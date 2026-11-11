"""Мониторинг и алерты (план 6.7, задача 2.16).

``evaluate`` — чистая функция: по снимку состояния (heartbeat воркеров, возраст последних
свечей, прогон движка) возвращает состояние компонентов. ``run_monitor`` собирает снимок из
Redis и БД, открывает/закрывает инциденты и шлёт алерты владельцам (email) с подавлением
повторов. Публичная статус-страница читает ``status_payload``.

Пороги из плана: нет закрытия свечи в ожидаемое время +2 мин; движок не отработал по > 5 %
инструментов; стрим биржи молчит > 60 с (у нас — REST-резерв, поэтому считаем по возрасту
последней 1m-свечи).
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.config import settings
from app.mail import MailError, send_mail
from app.models import Incident, Instrument, Signal, User

log = logging.getLogger("monitor")

OK, DEGRADED, DOWN = "ok", "degraded", "down"
_SEVERITY = {OK: 0, DEGRADED: 1, DOWN: 2}
REALERT_AFTER = timedelta(hours=6)
INCIDENTS_LOCK = 0x706C_6D6E  # ключ advisory-блокировки инцидентов («plmn»), см. incidents_lock
_no_owners_warned = False


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


@dataclass(slots=True)
class Component:
    key: str
    title: str
    status: str
    detail: str
    checks: list[str] = field(default_factory=list)


def parse_done_key(key: str) -> datetime | None:
    """``sched:done:{symbol}:{YYYYmmddTHHMM}`` → граница H4 (UTC, aware)."""
    try:
        return datetime.strptime(key.split(":", 3)[-1], "%Y%m%dT%H%M").replace(tzinfo=UTC)
    except ValueError:
        return None


def last_h4_close(now: datetime) -> datetime:
    floored = now.replace(minute=0, second=0, microsecond=0)
    return floored - timedelta(hours=floored.hour % 4)


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
    # доставка алертов — отдельный цикл уведомителя со своим heartbeat (время последнего движения
    # очереди): застрявшая отправка не видна по heartbeat основного цикла. Ключа нет (уведомитель
    # прежней версии при выкладке, Redis только что поднялся пустым) — судим по основному.
    if s.heartbeats.get("alert_delivery") is not None:
        st2, d2 = hb("alert_delivery", 120, 600)
        if _SEVERITY[st2] > _SEVERITY[st]:
            st, d = st2, d2
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
    for name in (
        "market_data",
        "scheduler",
        "tracker",
        "notifier",
        "alert_delivery",
        "pattern_detector",
        "alerts",
    ):
        try:
            v = r.get(f"{name}:heartbeat") if r is not None else None
            heartbeats[name] = (ts - int(v)) if v else None
        except Exception:
            heartbeats[name] = None
            redis_ok = False
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
    return Snapshot(now, heartbeats, m1_age, h4_stale, h4_total, engine_last, api_db_ok, redis_ok)


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
    db.flush()
    return opened


def merge_owner_emails(configured: set[str], from_db: list[str]) -> list[str]:
    """OWNER_EMAILS ∪ адреса владельцев из БД: без дублей, регистр и пробелы не различаются."""
    out = {e.strip().lower() for e in configured if e and e.strip()}
    out.update(e.strip().lower() for e in from_db if e and e.strip())
    return sorted(out)


def owner_recipients(db: Session) -> list[str]:
    """Кому слать письма владельцам: OWNER_EMAILS этого процесса плюс активные (не удалённые,
    не заблокированные) пользователи с ролью owner и подтверждённым адресом из БД.

    У уведомителя на Railway переменной OWNER_EMAILS нет, а владелец в БД есть — без этого
    письма об инцидентах не уходили никому.
    """
    rows = db.scalars(
        select(User.email).where(
            User.role == "owner",
            User.deleted_at.is_(None),
            User.blocked_at.is_(None),
            User.email_verified_at.is_not(None),
        )
    ).all()
    return merge_owner_emails(settings.owner_email_set, list(rows))


def incident_mail_key(inc: Incident, to: str) -> str:
    """Ключ идемпотентности письма об инциденте: инцидент, очередное оповещение (по прежнему
    ``alerted_at``) и адресат. Повтор того же оповещения после сбоя (таймаут, процесс убит до
    фиксации) Resend второй раз не отправит; новое оповещение через ``REALERT_AFTER`` — с новым
    ключом. Адрес — хешем: ключ не длиннее 256 символов и без адреса в открытом виде."""
    round_ = int(inc.alerted_at.timestamp()) if inc.alerted_at is not None else 0
    who = hashlib.sha256(to.encode()).hexdigest()[:16]
    return f"incident-{inc.id}-{round_}-{who}"


def send_alerts(db: Session, components: list[Component], now: datetime) -> int:
    """Письмо владельцам по каждому открытому инциденту: при открытии и затем раз в 6 часов.

    Письмо — в строгом режиме и с ключом идемпотентности (``incident_mail_key``). Инцидент
    отмечается оповещённым (``alerted_at``), только когда письмо принято для всех адресатов;
    отказ по адресу получателя повтором не лечится — адрес пропускается. Любой другой сбой
    (сеть, отказ провайдера) не роняет прогон: уже отправленные отмечаются, остальные инциденты
    ждут следующего прогона (через минуту), а повтор того же письма Resend не задвоит.
    Возвращает число оповещённых инцидентов.
    """
    global _no_owners_warned
    due = [
        inc
        for inc in db.scalars(
            select(Incident)
            .where(Incident.closed_at.is_(None))
            .order_by(Incident.id)
            .execution_options(populate_existing=True)  # alerted_at мог записать другой экземпляр
        ).all()
        if inc.alerted_at is None or now - inc.alerted_at >= REALERT_AFTER
    ]
    if not due:
        return 0
    owners = owner_recipients(db)
    if not owners:
        if not _no_owners_warned:
            log.warning("инциденты открыты, а слать некому: нет OWNER_EMAILS и владельцев в БД")
            _no_owners_warned = True
        return 0
    sent = 0
    titles = {c.key: c.title for c in components}
    for inc in due:
        subject = f"[Platform] {inc.severity.upper()}: {titles.get(inc.component, inc.component)}"
        body = (
            f"{titles.get(inc.component, inc.component)}: {inc.message}\n"
            f"Открыт: {inc.opened_at:%d.%m %H:%M} UTC\n"
            f"Статус: {settings.frontend_url}/status\n"
            f"Админка: {settings.frontend_url}/admin?tab=system"
        )
        failure: Exception | None = None
        for to in owners:
            try:
                send_mail(to, subject, body, incident_mail_key(inc, to), strict=True)
            except MailError as exc:
                if not exc.permanent:
                    failure = exc
                    break
                log.error("инцидент %s: адрес владельца отклонён провайдером (%s)", inc.id, exc)
            except Exception as exc:
                failure = exc
                break
        if failure is not None:
            log.warning(
                "инцидент %s: письмо не отправлено (%s) — повтор в следующий прогон",
                inc.id,
                failure,
            )
            break
        inc.alerted_at = now
        sent += 1
    return sent


def incidents_lock(db: Session) -> bool:
    """Взять блокировку инцидентов на эту транзакцию (``pg_try_advisory_xact_lock``).

    Два уведомителя бок о бок (выкладка без простоя) иначе оба открыли бы инцидент по одному
    компоненту и оба отправили бы письмо. Не взяли — этот прогон инциденты не трогает: их ведёт
    другой экземпляр, следующий прогон через минуту. Снимается при commit/rollback.
    """
    return bool(db.scalar(select(func.pg_try_advisory_xact_lock(INCIDENTS_LOCK))))


def run_monitor(db: Session, r: Any | None) -> dict[str, Any]:
    """Прогон монитора. Инциденты открываются и закрываются в одной транзакции и фиксируются до
    писем: сбой отправки их не откатывает (иначе следующий прогон открыл бы их заново и
    отправил письма, которые уже ушли). Письма — во второй транзакции под той же блокировкой."""
    snap = collect(db, r)
    comps = evaluate(snap)
    opened: list[Incident] = []
    if incidents_lock(db):
        opened = sync_incidents(db, comps, snap.now)
        db.commit()
        if incidents_lock(db):
            send_alerts(db, comps, snap.now)
        else:
            log.info("письма об инцидентах шлёт другой экземпляр монитора — пропуск")
    else:
        log.info("инциденты ведёт другой экземпляр монитора — пропуск")
    db.commit()
    if opened:
        log.warning("инциденты: %s", ", ".join(f"{i.component}={i.severity}" for i in opened))
    payload = status_payload(db, comps, snap.now)
    if r is not None:
        with contextlib.suppress(Exception):
            r.set("monitor:status", json.dumps(payload, ensure_ascii=False), ex=300)
    return payload


def current_status() -> dict[str, Any]:
    """Полный снимок статуса: из Redis (уведомитель кладёт его раз в минуту), а если кэша нет —
    расчёт на месте без инцидентов и алертов (чтобы API не слал письма). Публичная страница
    показывает его без компонентов сигналов, пока они закрыты (ADR-0013); админка — целиком."""
    import redis

    from app.db import SessionLocal

    r: Any | None
    try:
        r = redis.from_url(settings.redis_url, socket_timeout=2)
        cached = r.get("monitor:status")
        if cached:
            return dict(json.loads(cached))
    except Exception:
        r = None
    with SessionLocal() as db:
        snap = collect(db, r)
        return status_payload(db, evaluate(snap), snap.now)


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
