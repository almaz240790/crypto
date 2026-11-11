"""Мониторинг и алерты (план 6.7, задача 2.16).

``evaluate`` — чистая функция: по снимку состояния (heartbeat воркеров, возраст последних
свечей, прогон движка) возвращает состояние компонентов. ``run_monitor`` собирает снимок из
Redis и БД, открывает/закрывает инциденты и шлёт алерты владельцам (email) с подавлением
повторов. Публичная статус-страница читает ``status_payload``.

Компонент «Сверка сигналов» (задача 8 пакета «Сигналы») монитор сам не считает: ежедневную сверку
выполняет уведомитель (``app.reconcile``) и кладёт итог в Redis ``reconcile:last``; здесь он только
читается. Критичное расхождение — ``down``, предупреждение — ``degraded``. Письмо по сверке уходит
при открытии инцидента и когда список расхождений изменился, а не каждые шесть часов: сверка
идёт раз в сутки, повтор того же письма ничего не сообщает.

Пороги из плана: нет закрытия свечи в ожидаемое время +2 мин; движок не отработал по > 5 %
инструментов; стрим биржи молчит > 60 с (у нас — REST-резерв, поэтому считаем по возрасту
последней 1m-свечи).
"""

from __future__ import annotations

import contextlib
import json
import logging
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.config import settings
from app.mail import send_mail
from app.models import Incident, Instrument, Signal

log = logging.getLogger("monitor")

OK, DEGRADED, DOWN = "ok", "degraded", "down"
REALERT_AFTER = timedelta(hours=6)
RECONCILE_KEY = "reconcile:last"
"""Ключ Redis с итогом последней сверки сигналов (``app.reconcile.Report.to_json``)."""
RECONCILE_STALE = timedelta(hours=36)
"""Сверка идёт раз в сутки; если итог старше — она не выполняется."""
RECONCILE_TITLE = "Сверка сигналов"


@dataclass(frozen=True, slots=True)
class Snapshot:
    now: datetime
    heartbeats: dict[str, int | None]
    """Возраст heartbeat в секундах по воркерам (None — нет)."""
    m1_age_sec: int | None
    """Сколько секунд назад закрылась последняя 1m-свеча (по всем инструментам — минимум)."""
    h4_stale: int
    """Инструментов, у которых последняя H4-свеча старше ожидаемой + 2 мин."""
    h4_total: int
    engine_last_h4: datetime | None
    """Последняя граница H4, по которой движок отработал ≥ 95 % инструментов."""
    api_db_ok: bool
    redis_ok: bool
    reconcile: dict[str, Any] | None = None
    """Итог последней сверки сигналов из Redis; ``None`` — сверка ещё не выполнялась."""


@dataclass(slots=True)
class Component:
    key: str
    title: str
    status: str
    detail: str
    checks: list[str] = field(default_factory=list)
    """Строки подробностей для письма владельцу (на статус-страницу не выводятся)."""
    realert: bool = True
    """Повторять ли письмо по открытому инциденту каждые ``REALERT_AFTER``. ``False`` — письмо
    уходит при открытии инцидента и при смене его текста."""


def parse_done_key(key: str) -> datetime | None:
    """``sched:done:{symbol}:{YYYYmmddTHHMM}`` → граница H4 (UTC, aware)."""
    try:
        return datetime.strptime(key.split(":", 3)[-1], "%Y%m%dT%H%M").replace(tzinfo=UTC)
    except ValueError:
        return None


def last_h4_close(now: datetime) -> datetime:
    floored = now.replace(minute=0, second=0, microsecond=0)
    return floored - timedelta(hours=floored.hour % 4)


def reconcile_component(state: dict[str, Any] | None, now: datetime) -> Component:
    """Состояние компонента «Сверка сигналов» по итогу последней сверки."""

    def comp(status: str, detail: str, checks: list[str] | None = None) -> Component:
        return Component("reconcile", RECONCILE_TITLE, status, detail, checks or [], realert=False)

    if state is None:
        return comp(OK, "сверка ещё не выполнялась")
    if state.get("failed"):
        return comp(DEGRADED, "сверка не выполнена: ошибка", [str(state["failed"])])
    try:
        at = datetime.fromisoformat(str(state["at"]))
        checked, critical, warnings = (
            int(state["checked"]),
            int(state["critical"]),
            int(state["warnings"]),
        )
    except (KeyError, TypeError, ValueError):
        return comp(DEGRADED, "итог сверки не читается")
    if now - at > RECONCILE_STALE:
        return comp(DEGRADED, "сверка не выполнялась больше 36 ч")
    if critical or warnings:
        return comp(
            DOWN if critical else DEGRADED,
            f"расхождений: критичных {critical}, предупреждений {warnings}; "
            f"проверено сигналов: {checked}",
            [str(line) for line in state.get("lines", [])],
        )
    return comp(OK, f"проверено сигналов: {checked}, расхождений нет")


def evaluate(s: Snapshot) -> list[Component]:
    out: list[Component] = []

    def hb(name: str, warn: int, down: int) -> tuple[str, str]:
        age = s.heartbeats.get(name)
        if age is None:
            return DOWN, "нет heartbeat"
        if age > down:
            return DOWN, f"heartbeat {age // 60} мин назад"
        if age > warn:
            return DEGRADED, f"heartbeat {age} с назад"
        return OK, f"heartbeat {age} с назад"

    # данные с биржи
    st, d = hb("market_data", 90, 600)
    if s.m1_age_sec is None:
        st, d = DOWN, "нет минутных свечей"
    elif s.m1_age_sec > 300:
        st, d = DOWN, f"последняя 1m-свеча {s.m1_age_sec // 60} мин назад"
    elif s.m1_age_sec > 120 and st == OK:
        st, d = DEGRADED, f"последняя 1m-свеча {s.m1_age_sec} с назад"
    out.append(Component("data", "Данные с биржи", st, d))

    # закрытие свечей H4: +2 мин к ожидаемому времени (план 6.7)
    expected = last_h4_close(s.now)
    grace = s.now - expected > timedelta(minutes=2)
    if s.h4_total == 0:
        out.append(Component("candles", "Свечи H4", DOWN, "нет инструментов"))
    elif grace and s.h4_stale > 0:
        share = s.h4_stale / s.h4_total
        out.append(
            Component(
                "candles",
                "Свечи H4",
                DOWN if share > 0.05 else DEGRADED,
                f"нет закрытия свечи у {s.h4_stale} из {s.h4_total} инструментов",
            )
        )
    else:
        out.append(Component("candles", "Свечи H4", OK, f"{s.h4_total} инструментов в срок"))

    # движок: отработал ли по последней свече (с запасом 3 мин на публикацию, SLO 60 с)
    st, d = hb("scheduler", 180, 900)
    if s.now - expected > timedelta(minutes=3) and (
        s.engine_last_h4 is None or s.engine_last_h4 < expected
    ):
        st, d = DOWN, f"нет прогона по свече {expected:%d.%m %H:%M} UTC"
    out.append(Component("engine", "Движок сигналов", st, d))

    st, d = hb("tracker", 180, 900)
    out.append(Component("tracker", "Трекер сделок", st, d))
    st, d = hb("notifier", 120, 600)
    out.append(Component("notifier", "Уведомления", st, d))
    st, d = hb("pattern_detector", 180, 900)
    out.append(Component("patterns", "Паттерны на графике", st, d))
    st, d = hb("alerts", 120, 600)
    out.append(Component("alerts", "Алерты", st, d))
    out.append(
        Component(
            "api",
            "API и база",
            OK if (s.api_db_ok and s.redis_ok) else DOWN,
            "ок" if (s.api_db_ok and s.redis_ok) else ("нет Redis" if s.api_db_ok else "нет базы"),
        )
    )
    out.append(reconcile_component(s.reconcile, s.now))
    return out


def overall(components: list[Component]) -> str:
    if any(c.status == DOWN for c in components):
        return DOWN
    if any(c.status == DEGRADED for c in components):
        return DEGRADED
    return OK


# --- сбор снимка ---------------------------------------------------------------------------------


def collect(db: Session, r: Any | None) -> Snapshot:
    now = datetime.now(tz=UTC)
    ts = int(now.timestamp())
    heartbeats: dict[str, int | None] = {}
    redis_ok = r is not None
    for name in ("market_data", "scheduler", "tracker", "notifier", "pattern_detector", "alerts"):
        try:
            v = r.get(f"{name}:heartbeat") if r is not None else None
            heartbeats[name] = (ts - int(v)) if v else None
        except Exception:
            heartbeats[name] = None
            redis_ok = False
    reconcile: dict[str, Any] | None = None
    try:
        raw = r.get(RECONCILE_KEY) if r is not None else None
        loaded = json.loads(raw) if raw else None
        reconcile = loaded if isinstance(loaded, dict) else None
    except Exception:
        reconcile = None  # Redis недоступен — это покажет компонент «API и база»
    api_db_ok = True
    try:
        m1 = db.execute(text("select max(open_time) from candles where timeframe='1m'")).scalar()
        m1_age = int((now - (m1 + timedelta(minutes=1))).total_seconds()) if m1 else None
        expected = last_h4_close(now) - timedelta(hours=4)  # последняя закрытая H4 = open_time
        row = db.execute(
            text(
                "select count(*) filter (where m < :exp) as stale, count(*) as total from ("
                "select instrument_id, max(open_time) m from candles c join instruments i "
                "on i.id=c.instrument_id where c.timeframe='4h' and i.is_active "
                "and i.market_type='futures' group by 1) t"
            ),
            {"exp": expected},
        ).first()
        h4_stale, h4_total = (int(row[0]), int(row[1])) if row else (0, 0)
        active = (
            db.scalar(
                select(func.count())
                .select_from(Instrument)
                .where(Instrument.is_active, Instrument.market_type == "futures")
            )
            or 0
        )
        engine_last: datetime | None = None
        if r is not None:
            try:
                keys = r.keys("sched:done:*")
                counts: dict[datetime, int] = {}
                for k in keys:
                    close = parse_done_key(k.decode() if isinstance(k, bytes) else k)
                    if close is not None:
                        counts[close] = counts.get(close, 0) + 1
                good = [c for c, n in counts.items() if active and n >= 0.95 * active]
                engine_last = max(good) if good else None
            except Exception:
                redis_ok = False
        if engine_last is None:
            last_sig = db.scalar(select(func.max(Signal.candle_close_time)))
            engine_last = last_sig.astimezone(UTC) if last_sig else None
    except Exception:
        log.exception("сбор снимка")
        api_db_ok = False
        m1_age, h4_stale, h4_total, engine_last = None, 0, 0, None
    return Snapshot(
        now, heartbeats, m1_age, h4_stale, h4_total, engine_last, api_db_ok, redis_ok, reconcile
    )


# --- инциденты и алерты --------------------------------------------------------------------------


def sync_incidents(db: Session, components: list[Component], now: datetime) -> list[Incident]:
    """Открывает инцидент при degraded/down, закрывает при ok. Возвращает новые инциденты."""
    opened: list[Incident] = []
    current = {
        i.component: i
        for i in db.scalars(select(Incident).where(Incident.closed_at.is_(None))).all()
    }
    for c in components:
        inc = current.get(c.key)
        if c.status == OK:
            if inc is not None:
                inc.closed_at = now
            continue
        if inc is None:
            inc = Incident(component=c.key, severity=c.status, message=c.detail, opened_at=now)
            db.add(inc)
            opened.append(inc)
        elif inc.severity != c.status or inc.message != c.detail:
            inc.severity = c.status
            inc.message = c.detail
            if not c.realert:
                inc.alerted_at = None  # текст сменился — письмо уйдёт ещё раз
    db.flush()
    return opened


def send_alerts(db: Session, components: list[Component], now: datetime) -> int:
    """Письмо владельцам по каждому открытому инциденту: при открытии и затем раз в 6 часов.

    У компонента с ``realert = False`` повторов по времени нет: следующее письмо уйдёт, когда
    сменится текст инцидента (``sync_incidents`` сбрасывает ``alerted_at``). Строки
    ``Component.checks`` добавляются в письмо — подробности, которых нет на статус-странице.
    """
    owners = sorted(settings.owner_email_set)
    if not owners:
        return 0
    sent = 0
    by_key = {c.key: c for c in components}
    titles = {c.key: c.title for c in components}
    for inc in db.scalars(select(Incident).where(Incident.closed_at.is_(None))).all():
        comp = by_key.get(inc.component)
        repeat = comp is None or comp.realert
        if inc.alerted_at is not None and (not repeat or now - inc.alerted_at < REALERT_AFTER):
            continue
        subject = f"[Platform] {inc.severity.upper()}: {titles.get(inc.component, inc.component)}"
        details = "".join(f"- {line}\n" for line in (comp.checks if comp else []))
        body = (
            f"{titles.get(inc.component, inc.component)}: {inc.message}\n"
            f"{details}"
            f"Открыт: {inc.opened_at:%d.%m %H:%M} UTC\n"
            f"Статус: {settings.frontend_url}/status\n"
            f"Админка: {settings.frontend_url}/admin?tab=system"
        )
        for to in owners:
            send_mail(to, subject, body)
        inc.alerted_at = now
        sent += 1
    return sent


def run_monitor(db: Session, r: Any | None) -> dict[str, Any]:
    snap = collect(db, r)
    comps = evaluate(snap)
    opened = sync_incidents(db, comps, snap.now)
    send_alerts(db, comps, snap.now)
    db.commit()
    if opened:
        log.warning("инциденты: %s", ", ".join(f"{i.component}={i.severity}" for i in opened))
    payload = status_payload(db, comps, snap.now)
    if r is not None:
        with contextlib.suppress(Exception):
            r.set("monitor:status", json.dumps(payload, ensure_ascii=False), ex=300)
    return payload


def status_payload(db: Session, comps: list[Component], now: datetime) -> dict[str, Any]:
    since = now - timedelta(days=7)
    incidents = db.scalars(
        select(Incident)
        .where((Incident.closed_at.is_(None)) | (Incident.opened_at >= since))
        .order_by(Incident.opened_at.desc())
        .limit(50)
    ).all()
    # доступность за 7 дней: доля времени без инцидента уровня down по каждому компоненту
    window = (now - since).total_seconds()
    down_sec: dict[str, float] = {}
    for i in incidents:
        if i.severity != DOWN:
            continue
        a = max(i.opened_at, since)
        b = i.closed_at or now
        down_sec[i.component] = down_sec.get(i.component, 0) + max(0.0, (b - a).total_seconds())
    return {
        "status": overall(comps),
        "generated_at": now.isoformat(),
        "components": [
            {
                "key": c.key,
                "title": c.title,
                "status": c.status,
                "detail": c.detail,
                "uptime_7d": round(100 * (1 - min(window, down_sec.get(c.key, 0)) / window), 2),
            }
            for c in comps
        ],
        "incidents": [
            {
                "component": i.component,
                "severity": i.severity,
                "message": i.message,
                "opened_at": i.opened_at.isoformat(),
                "closed_at": i.closed_at.isoformat() if i.closed_at else None,
            }
            for i in incidents
        ],
        "checked_at_unix": int(time.time()),
    }
