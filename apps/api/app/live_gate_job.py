"""Отчёт «готовность к live» на сервере (задача 9 пакета «Сигналы»; план 10.4, 3.15).

Раз в неделю уведомитель строит отчёт ``scripts/live_gate_report.py`` по каждой цели и кладёт
его в Redis ``live_gate:last``; админка показывает таблицу критериев и отдаёт отчёт файлом. Так
владельцу не нужен доступ к базе production: отчёт считает сам сервер, только на чтение.

Цели (``gate_targets``) берутся из статусов версий в БД:

- версия в статусе forward — её собственный форвард на её списке инструментов;
- версия в статусе backtest со своим списком инструментов, у которой есть «двойник» в форварде
  (те же правила, без списка, ``same_rules``), — кандидат: форвард двойника на списке кандидата.
  Правило одной сделки действует по инструменту, поэтому такая выборка совпадает с тем, что дал
  бы сам кандидат (задача 11).

Бэктест каждой цели кончается в день начала её форварда (``--to auto``), момент отчёта —
последнее закрытие H4. Скрипт идёт отдельным процессом с пониженным приоритетом и тайм-аутом:
цикл уведомителя он не держит, а сбой одной цели не мешает остальным. Отчёт ничего не решает и
статусов не меняет: выпуск в live — решение владельца.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import tempfile
from collections.abc import Awaitable, Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import Connection, text

from app.live_gate_report import last_close, same_rules
from engine.strategies import STRATEGIES

log = logging.getLogger("live_gate")

LIVE_GATE_KEY = "live_gate:last"
"""Redis: последний набор отчётов (JSON: ``at``, ``reports``; при сбое — ``failed``)."""
LIVE_GATE_WEEKDAY = 0
"""День недели, когда строится отчёт (понедельник)."""
LIVE_GATE_HOUR_UTC = 2
"""Час UTC: после ежедневной сверки (01:00), чтобы отчёт взял её свежий итог."""
LIVE_GATE_MAX_AGE = timedelta(days=8)
"""Отчёт старше — строится в любой день (понедельник пропущен: уведомитель лежал)."""
TARGET_TIMEOUT = 3600
"""Секунд на одну цель: бэктест 59 пар идёт десятки минут."""
NICE = 10
"""Приоритет процесса отчёта: ниже, чем у уведомителя."""
ERROR_TAIL = 2000
"""Сколько последних символов stderr хранить при сбое."""
SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "live_gate_report.py"
"""Скрипт отчёта: в образе — ``/srv/scripts``, в репозитории — ``scripts/``."""


@dataclass(frozen=True, slots=True)
class GateTarget:
    """Что мерить: форвард версии ``version`` на списке инструментов версии ``symbols_of``."""

    title: str
    version: str
    """Версия, форвард-сигналы которой читаются (``--version``)."""
    symbols_of: str | None = None
    """Версия, чей список инструментов взять (``--symbols-of``); ``None`` — список ``version``."""

    def args(self) -> list[str]:
        out = ["--version", self.version]
        if self.symbols_of is not None:
            out += ["--symbols-of", self.symbols_of]
        return out


def load_statuses(conn: Connection) -> list[tuple[str, str]]:
    """Версии в БД: ``(стратегия@номер, статус)``."""
    rows = conn.execute(
        text(
            "select st.slug, sv.version, sv.status from strategy_versions sv "
            "join strategies st on st.id = sv.strategy_id order by st.slug, sv.id"
        )
    ).all()
    return [(f"{r[0]}@{r[1]}", str(r[2])) for r in rows]


def gate_targets(statuses: Iterable[tuple[str, str]]) -> list[GateTarget]:
    """Цели отчёта по статусам версий в БД. Версии, которых нет в ``engine.strategies``, не
    берутся: их правила неизвестны, бэктест не построить."""
    known = [(label, status) for label, status in statuses if label in STRATEGIES]
    forward = [label for label, status in known if status == "forward"]
    out = [GateTarget(f"{label} — форвард версии", label) for label in forward]
    for label, status in known:
        params = STRATEGIES[label]
        if status != "backtest" or params.symbols is None:
            continue
        twins = [
            f
            for f in forward
            if STRATEGIES[f].symbols is None and same_rules(STRATEGIES[f], params)
        ]
        if twins:
            twin = twins[0]
            title = f"{label} — кандидат: форвард {twin} на {len(params.symbols)} парах кандидата"
            out.append(GateTarget(title, twin, label))
    return out


def last_run_at(raw: bytes | str | None) -> datetime | None:
    """Когда отчёт последний раз построен; сбой целиком за построение не считается."""
    if not raw:
        return None
    try:
        state = json.loads(raw)
        if not isinstance(state, dict) or state.get("failed"):
            return None
        return datetime.fromisoformat(str(state["at"])).astimezone(UTC)
    except (KeyError, TypeError, ValueError):
        return None


def live_gate_due(now: datetime, last_at: datetime | None) -> bool:
    """Пора ли строить: отчёта нет; или понедельник после 02:00 UTC, а сегодня ещё не строили;
    или отчёт старше 8 дней."""
    if last_at is None or now - last_at > LIVE_GATE_MAX_AGE:
        return True
    return (
        now.weekday() == LIVE_GATE_WEEKDAY
        and now.hour >= LIVE_GATE_HOUR_UTC
        and last_at.date() < now.date()
    )


@dataclass(frozen=True, slots=True)
class Done:
    """Итог процесса отчёта."""

    returncode: int
    stdout: str
    stderr: str


Runner = Callable[[Sequence[str], float], Awaitable[Done]]


def _lower_priority() -> None:  # pragma: no cover - выполняется в дочернем процессе
    os.nice(NICE)


async def run_script(args: Sequence[str], timeout: float) -> Done:
    """Скрипт отчёта отдельным процессом: тот же Python, то же окружение, пониженный приоритет.
    Тайм-аут или отмена задачи (остановка уведомителя) убивают процесс — он не переживает
    уведомитель и не держит его остановку."""
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        str(SCRIPT),
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        preexec_fn=_lower_priority,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except BaseException:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()
        raise
    return Done(
        proc.returncode if proc.returncode is not None else -1,
        out.decode("utf-8", "replace"),
        err.decode("utf-8", "replace"),
    )


async def build_report(
    target: GateTarget, now: datetime, workdir: Path, runner: Runner = run_script
) -> dict[str, Any]:
    """Один отчёт: Markdown и сводка JSON; при сбое — текст ошибки вместо них."""
    md, js = workdir / "report.md", workdir / "summary.json"
    for f in (md, js):
        f.unlink(missing_ok=True)
    args = [
        *target.args(),
        "--to",
        "auto",
        "--now",
        last_close(now).isoformat(),
        "--reconcile-redis",
        "--out",
        str(md),
        "--json",
        str(js),
    ]
    out: dict[str, Any] = {
        "title": target.title,
        "version": target.version,
        "symbols_of": target.symbols_of,
    }
    try:
        done = await runner(args, TARGET_TIMEOUT)
    except TimeoutError:
        out["error"] = f"отчёт не уложился в {TARGET_TIMEOUT // 60} мин"
        return out
    if done.returncode != 0 or not md.exists() or not js.exists():
        tail = (done.stderr or done.stdout or "").strip()[-ERROR_TAIL:]
        out["error"] = f"код выхода {done.returncode}: {tail}" if tail else f"код {done.returncode}"
        return out
    out["markdown"] = md.read_text(encoding="utf-8")
    out["summary"] = json.loads(js.read_text(encoding="utf-8"))
    return out


async def build_all(
    targets: Sequence[GateTarget], now: datetime, runner: Runner = run_script
) -> dict[str, Any]:
    """Все цели по очереди; итог для Redis ``live_gate:last``."""
    with tempfile.TemporaryDirectory(prefix="live-gate-") as tmp:
        reports = [await build_report(t, now, Path(tmp), runner) for t in targets]
    return {"at": now.isoformat(), "reports": reports}


def summary_line(state: dict[str, Any]) -> str:
    """Строка для журнала уведомителя."""
    if state.get("failed"):
        return f"готовность к live: сбой — {state['failed']}"
    parts = []
    for r in state.get("reports", []):
        if r.get("error"):
            parts.append(f"{r['title']}: ошибка")
            continue
        c = r["summary"]["counts"]
        parts.append(
            f"{r['title']}: выполнено {c['met']}, не выполнено {c['not_met']}, "
            f"нужно решение человека {c['human']}"
        )
    return "готовность к live: " + ("; ".join(parts) if parts else "целей нет")
