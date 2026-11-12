"""Отчёт «готовность к live» на сервере: цели, расписание, запуск скрипта, Redis, админка."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from app.live_gate_job import (
    LIVE_GATE_KEY,
    SCRIPT,
    Done,
    GateTarget,
    build_all,
    gate_targets,
    has_errors,
    last_run_at,
    live_gate_due,
    summary_line,
)
from app.workers import notifier

V100, V120, V121 = (f"trend-ob-retest@{v}" for v in ("1.0.0", "1.2.0", "1.2.1"))
MONDAY = datetime(2026, 11, 16, tzinfo=UTC)
SUMMARY = {"counts": {"met": 4, "not_met": 3, "human": 5}, "criteria": []}


def test_script_path_points_at_the_report_script() -> None:
    assert SCRIPT.name == "live_gate_report.py" and SCRIPT.exists()


def test_targets_from_version_statuses() -> None:
    statuses = [(V100, "archived"), (V120, "forward"), (V121, "backtest"), ("x@9.9.9", "forward")]
    own, candidate = gate_targets(statuses)
    assert own == GateTarget(f"{V120} — форвард версии", V120)
    assert own.args() == ["--version", V120]
    assert (candidate.version, candidate.symbols_of) == (V120, V121)
    assert candidate.args() == ["--version", V120, "--symbols-of", V121]
    assert "кандидат" in candidate.title and "20 парах" in candidate.title
    # двойника в форварде нет — кандидата мерить нечем
    assert gate_targets([(V120, "archived"), (V121, "backtest")]) == []
    # кандидат сам в форварде — меряется своим форвардом
    assert gate_targets([(V121, "forward")]) == [GateTarget(f"{V121} — форвард версии", V121)]


def test_schedule_is_weekly_with_catch_up() -> None:
    ok = json.dumps({"at": MONDAY.isoformat(), "reports": []})
    assert last_run_at(ok) == MONDAY and last_run_at(ok.encode()) == MONDAY
    for raw in (None, b"", "не json", "[]", json.dumps({"at": MONDAY.isoformat(), "failed": "x"})):
        assert last_run_at(raw) is None, raw
    assert live_gate_due(MONDAY.replace(hour=12), None)  # отчёта нет — сразу
    week_ago = MONDAY - timedelta(days=7) + timedelta(hours=3)
    assert not live_gate_due(MONDAY.replace(hour=1, minute=59), week_ago)  # час не настал
    assert live_gate_due(MONDAY.replace(hour=2), week_ago)
    assert not live_gate_due(MONDAY.replace(hour=23), MONDAY.replace(hour=2, minute=5))
    tuesday = MONDAY + timedelta(days=1, hours=5)
    assert not live_gate_due(tuesday, MONDAY.replace(hour=2))
    # понедельник пропущен (уведомитель лежал) — догоняем в любой день
    assert live_gate_due(MONDAY + timedelta(days=2), MONDAY - timedelta(days=7))
    # какая-то цель не построилась — повтор через 12 часов, а не через неделю
    built = MONDAY.replace(hour=2, minute=5)
    assert not live_gate_due(built + timedelta(hours=11), built, errors=True)
    assert live_gate_due(built + timedelta(hours=12), built, errors=True)
    assert not live_gate_due(built + timedelta(hours=12), built)
    broken = json.dumps({"at": MONDAY.isoformat(), "reports": [{"title": "t", "error": "код 2"}]})
    assert has_errors(broken) and has_errors(broken.encode())
    for raw in (None, "", ok, "не json", "[]", json.dumps({"failed": "x"})):
        assert not has_errors(raw), raw


def _arg(args: Sequence[str], name: str) -> str:
    return args[list(args).index(name) + 1]


def test_build_all_runs_each_target_and_keeps_errors() -> None:
    calls: list[list[str]] = []

    async def runner(args: Sequence[str], timeout: float) -> Done:
        calls.append(list(args))
        if "--symbols-of" in args:
            return Done(2, "", "ошибка: --to auto: форвард не начинался")
        Path(_arg(args, "--out")).write_text("# Готовность к live\n", encoding="utf-8")
        Path(_arg(args, "--json")).write_text(json.dumps(SUMMARY), encoding="utf-8")
        return Done(0, "готово", "")

    targets = [GateTarget("своя", V120), GateTarget("кандидат", V120, V121)]
    now = MONDAY.replace(hour=2, minute=7, second=30)
    state = asyncio.run(build_all(targets, now, runner))
    assert state["at"] == now.isoformat()
    ok, bad = state["reports"]
    assert ok["markdown"] == "# Готовность к live\n" and ok["summary"] == SUMMARY
    assert "error" not in ok
    assert bad["error"] == "код выхода 2: ошибка: --to auto: форвард не начинался"
    assert "markdown" not in bad
    # момент отчёта — последнее закрытие H4, бэктест до начала форварда, сверка из Redis
    first = calls[0]
    assert _arg(first, "--now") == MONDAY.isoformat() and _arg(first, "--to") == "auto"
    assert "--reconcile-redis" in first
    line = summary_line(state)
    assert "своя: выполнено 4, не выполнено 3, нужно решение человека 5" in line
    assert "кандидат: ошибка" in line


def test_build_all_records_a_timeout_and_a_missing_file() -> None:
    async def slow(args: Sequence[str], timeout: float) -> Done:
        raise TimeoutError

    async def silent(args: Sequence[str], timeout: float) -> Done:
        return Done(0, "", "")  # код 0, но файлов нет

    (r,) = asyncio.run(build_all([GateTarget("t", V120)], MONDAY, slow))["reports"]
    assert r["error"] == "отчёт не уложился в 60 мин"
    (r,) = asyncio.run(build_all([GateTarget("t", V120)], MONDAY, silent))["reports"]
    assert r["error"] == "код 0"
    assert summary_line({"at": "x", "reports": []}) == "готовность к live: целей нет"
    assert (
        summary_line({"failed": "OperationalError"}) == "готовность к live: сбой — OperationalError"
    )


def test_run_script_kills_the_process_on_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    """Тайм-аут убивает дочерний процесс — он не переживает уведомитель."""
    import app.live_gate_job as job

    monkeypatch.setattr(job, "SCRIPT", Path("-c"))
    done = asyncio.run(job.run_script(["print('ок')"], 30))
    assert (done.returncode, done.stdout.strip()) == (0, "ок")
    with pytest.raises(TimeoutError):
        asyncio.run(job.run_script(["import time; time.sleep(30)"], 0.5))


class _AsyncRedis:
    def __init__(self) -> None:
        self.data: dict[str, str] = {}

    async def set(self, key: str, value: str) -> None:
        self.data[key] = value


def test_notifier_stores_the_reports_and_a_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    store = _AsyncRedis()
    monkeypatch.setattr(notifier, "live_gate_statuses", lambda: [(V120, "forward")])

    async def fake_build(targets: Sequence[GateTarget], now: datetime) -> dict[str, Any]:
        assert [t.version for t in targets] == [V120]
        return {"at": now.isoformat(), "reports": [{"title": "t", "summary": SUMMARY}]}

    monkeypatch.setattr(notifier, "build_all", fake_build)
    line = asyncio.run(notifier.live_gate_once(store, MONDAY))
    assert line == "готовность к live: t: выполнено 4, не выполнено 3, нужно решение человека 5"
    assert last_run_at(store.data[LIVE_GATE_KEY]) == MONDAY

    def boom() -> list[tuple[str, str]]:
        raise RuntimeError("БД недоступна")

    monkeypatch.setattr(notifier, "live_gate_statuses", boom)
    with pytest.raises(RuntimeError):
        asyncio.run(notifier.live_gate_once(store, MONDAY))
    state = json.loads(store.data[LIVE_GATE_KEY])
    assert state["failed"] == "RuntimeError: БД недоступна"
    assert last_run_at(store.data[LIVE_GATE_KEY]) is None  # следующая проверка повторит


class _SyncRedis:
    value: str | None = None

    def get(self, key: str) -> str | None:
        assert key == LIVE_GATE_KEY
        return self.value

    def close(self) -> None:
        pass


def test_admin_endpoint_returns_the_last_reports(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.routers import admin

    route = next(r for r in admin.router.routes if getattr(r, "path", "").endswith("/live-gate"))
    deps = [d.call for d in route.dependant.dependencies]  # type: ignore[attr-defined]
    assert admin.ADMIN in deps  # только админ и владелец

    fake = _SyncRedis()
    monkeypatch.setattr(admin.redis_sync.Redis, "from_url", lambda *_, **__: fake)
    empty = admin.live_gate(user=None)  # type: ignore[arg-type]
    assert empty["at"] is None and empty["reports"] == []
    assert empty["schedule"] == "раз в неделю, в понедельник после 02:00 UTC"
    fake.value = json.dumps({"at": MONDAY.isoformat(), "reports": [{"title": "t"}]})
    got = admin.live_gate(user=None)  # type: ignore[arg-type]
    assert got["at"] == MONDAY.isoformat() and got["reports"] == [{"title": "t"}]
    assert got["failed"] is None
    fake.value = "не json"
    assert admin.live_gate(user=None)["failed"] == "итог не читается"  # type: ignore[arg-type]
