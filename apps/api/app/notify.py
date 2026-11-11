"""Уведомления по email (план 3.11, задача 2.13).

- ``notify_new_signal`` / ``notify_event`` — мгновенные письма по live-сигналам с учётом настроек:
  градации, инструменты (все / вотчлист), тихие часы (UTC), суточный лимит; каждая отправка
  записывается в ``notification_log`` (повтор невозможен).
- ``notify_staff_signal`` / ``notify_staff_event`` — письма и push владельцам и администраторам о
  новых сигналах форварда и смене их статуса (вход, TP1–TP3, стоп, выход по времени); форвард
  видят только они, обычные пользователи этих уведомлений не получают; исправления исхода
  (пересчёт форварда) не рассылаются. Каждая отправка (адресат × канал) — отдельно: сбой одной
  не мешает остальным, неудавшиеся не отмечаются и повторяются уведомителем
  (``StaffDeliveryError``).
- ``run_digest`` — ежедневный/еженедельный дайджест: закрытые сигналы за период, активные,
  метрики за 30 дней, ссылка отписки.

Пока сигналы закрыты (ADR-0013, ``SIGNALS_PUBLIC``), письма и push о сигналах и дайджест
получают только admin и owner; отчёт по журналу остальным уходит без строк о сигналах.
Тексты — простые, без обещаний (план 8). Без ключа Resend письма уходят в лог — кроме рассылок
в production: там процесс без ключа их пропускает, не отмечая отправленными (``mail_ready``).
"""

from __future__ import annotations

import logging
import secrets
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from functools import partial
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import settings
from app.corrections import CORRECTION_SOURCE
from app.journal_analytics import TradeRow, analytics, without_signal
from app.mail import MailError, send_mail
from app.mail import configured as mail_configured
from app.models import (
    Instrument,
    JournalEntry,
    NotificationLog,
    NotificationSettings,
    RiskProfile,
    Signal,
    SignalEvent,
    SignalResult,
    StrategyVersion,
    User,
    Watchlist,
    WatchlistItem,
)
from app.push import send_to_user
from app.signals_access import signals_open
from app.stats import load_trades
from engine.backtest import summarize

log = logging.getLogger("notify")

DISCLAIMER = (
    "Информация носит образовательный характер и не является инвестиционной рекомендацией. "
    "Торговля связана с риском потери всех средств. Прошлые результаты не гарантируют будущих."
)
EVENT_TEXT = {
    "activated": "вход исполнен",
    "tp1": "достигнут TP1 — по правилам стоп переносится в безубыток",
    "tp2": "достигнут TP2",
    "tp3": "достигнут TP3, позиция закрыта",
    "be": "закрыт в безубыток",
    "sl": "сработал стоп",
    "time_stop": "закрыт по времени",
    "expired": "вход не исполнен, сигнал истёк",
}
CLOSING_EVENTS = ("tp3", "be", "sl", "time_stop", "expired")
"""События закрытия сделки: в уведомлении о них — итог в R."""


def mail_ready() -> bool:
    """Можно ли рассылать из этого процесса (дайджест, отчёт по журналу).

    Ключ почты есть — да. Нет ключа: локально и на staging письма пишутся в лог (это и есть
    доставка), а в production рассылка пропускается — и не отмечается отправленной, чтобы её
    отправил процесс с ключом (уведомитель). На Railway у cron-сервиса ``digest`` ключа нет:
    раньше он «отправлял» в лог и писал ``notification_log``, и пользователь терял дайджест
    за день.
    """
    return mail_configured() or not settings.is_production


def mail_key(kind: str, user_id: int, ref: str) -> str:
    """Ключ идемпотентности письма рассылки (Resend помнит его сутки): если процесс упал между
    отправкой и фиксацией отметки, повтор того же письма провайдер не отправит второй раз."""
    return f"{kind}-{user_id}-{ref}".replace(":", "-")


def _send_recorded(db: Session, to: str, subject: str, text: str, key: str) -> bool:
    """Письмо рассылки после отметки в ``notification_log`` (``_record``, ещё не зафиксирована).

    Отправлено — отметка фиксируется, True. Отказ провайдера — отметка откатывается, письмо не
    числится отправленным: постоянный (неверный адрес) — False, адрес пропускается до следующего
    прохода; временный (лимит, сбой провайдера, ключ или домен) и сетевая ошибка — исключение,
    проход прерывается, его повторит уведомитель (уже отправленным дубля не будет).
    """
    try:
        send_mail(to, subject, text, idempotency_key=key, strict=True)
    except MailError as exc:
        db.rollback()
        if not exc.permanent:
            raise
        log.error("письмо %s отклонено провайдером (%s), не отмечаем", key, exc)
        return False
    except Exception:
        db.rollback()
        raise
    db.commit()
    return True


def settings_for(db: Session, user: User) -> NotificationSettings:
    ns = db.get(NotificationSettings, user.id)
    if ns is None:
        ns = NotificationSettings(user_id=user.id, unsubscribe_token=secrets.token_urlsafe(32))
        db.add(ns)
        db.flush()
    return ns


def in_quiet_hours(ns: NotificationSettings, now: datetime) -> bool:
    if ns.quiet_from is None or ns.quiet_to is None or ns.quiet_from == ns.quiet_to:
        return False
    h = now.astimezone(UTC).hour
    if ns.quiet_from < ns.quiet_to:
        return ns.quiet_from <= h < ns.quiet_to
    return h >= ns.quiet_from or h < ns.quiet_to  # через полночь


def limit_reached(ns: NotificationSettings, now: datetime) -> bool:
    today = now.astimezone(UTC).date()
    if ns.sent_day is None or ns.sent_day.astimezone(UTC).date() != today:
        ns.sent_day = now
        ns.sent_today = 0
    return ns.sent_today >= ns.daily_limit


def _dec(x: Decimal | None) -> str:
    return "—" if x is None else format(x.normalize(), "f")


def _fmt_r(x: Decimal | float | None) -> str:
    if x is None:
        return "—"
    v = float(x)
    return f"{v:+.2f} R"


def position_size(risk: RiskProfile | None, sig: Signal) -> str:
    """Размер позиции под риск пользователя (план 3.11): депозит × риск % / расстояние до стопа."""
    if risk is None or risk.deposit is None or sig.stop_loss is None:
        return "укажите депозит в настройках"
    entry = sig.entry_limit or sig.entry_market
    dist = abs(entry - sig.stop_loss)
    if dist == 0:
        return "—"
    risk_usd = risk.deposit * risk.risk_pct / 100
    size = (risk_usd / dist).quantize(Decimal("0.0001"))
    return f"{size} ({risk_usd.quantize(Decimal('0.01'))} USDT риска)"


def signal_text(sig: Signal, symbol: str, risk: RiskProfile | None) -> str:
    url = f"{settings.frontend_url}/signals/{sig.public_id}"
    rows = [
        ("инструмент", symbol),
        ("направление", sig.direction.upper()),
        ("градация", f"{sig.grade} ({sig.score})"),
        ("вход", _dec(sig.entry_limit or sig.entry_market)),
        ("стоп", _dec(sig.stop_loss)),
        ("TP1 / TP2 / TP3", f"{_dec(sig.tp1)} / {_dec(sig.tp2)} / {_dec(sig.tp3)}"),
        ("R:R до TP2", _dec(sig.rr_tp2)),
        ("свеча", sig.candle_close_time.strftime("%d.%m %H:%M UTC")),
        ("размер под ваш риск", position_size(risk, sig)),
    ]
    w = max(len(k) for k, _ in rows)
    table = "\n".join(f"{k.ljust(w)}  {v}" for k, v in rows)
    return f"Новый сигнал\n\n{table}\n\nКарточка: {url}\n\n{DISCLAIMER}"


def _watchlist_ids(db: Session, user_id: int) -> set[int]:
    wl = db.scalar(select(Watchlist.id).where(Watchlist.user_id == user_id))
    if wl is None:
        return set()
    return set(
        db.scalars(
            select(WatchlistItem.instrument_id).where(WatchlistItem.watchlist_id == wl)
        ).all()
    )


def should_notify(
    ns: NotificationSettings, sig: Signal, now: datetime, watchlist: set[int]
) -> bool:
    if sig.grade not in (ns.grades or []):
        return False
    if ns.scope == "watchlist" and sig.instrument_id not in watchlist:
        return False
    if in_quiet_hours(ns, now):
        return False
    return not limit_reached(ns, now)


def _record(db: Session, user_id: int, kind: str, ref: str) -> bool:
    db.add(NotificationLog(user_id=user_id, channel="email", kind=kind, ref=ref))
    try:
        db.flush()
        return True
    except IntegrityError:
        db.rollback()
        return False


def _record_push(db: Session, user_id: int, kind: str, ref: str) -> bool:
    db.add(NotificationLog(user_id=user_id, channel="push", kind=kind, ref=ref))
    try:
        db.flush()
        return True
    except IntegrityError:
        db.rollback()
        return False


def _live_signal(sig: Signal) -> bool:
    """Уведомления — только по live-сигналам. Область зафиксирована при публикации
    (``signals.scope``): по форвард-сигналу версии, ставшей потом live, писем и push нет."""
    return sig.scope == "live"


def _recipients(db: Session, flag: str) -> list[tuple[User, NotificationSettings]]:
    """Получатели мгновенных уведомлений: Free получает только дневной дайджест (раздел 4);
    пока сигналы закрыты (ADR-0013) — только admin и owner."""
    from app.entitlements import entitlements_for

    rows = db.execute(
        select(User, NotificationSettings)
        .join(NotificationSettings, NotificationSettings.user_id == User.id)
        .where(User.deleted_at.is_(None), User.email_verified_at.is_not(None))
        .where(getattr(NotificationSettings, flag).is_(True))
    ).all()
    return [
        (u, ns)
        for u, ns in rows
        if signals_open(u) and entitlements_for(db, u).instant_notifications
    ]


def notify_new_signal(db: Session, sig: Signal, now: datetime | None = None) -> int:
    """Письма всем, у кого включены письма о сигналах. Возвращает число отправок."""
    now = now or datetime.now(tz=UTC)
    if not _live_signal(sig):
        return 0
    symbol = db.scalar(select(Instrument.symbol).where(Instrument.id == sig.instrument_id)) or "?"
    sent = 0
    for user, ns in _recipients(db, "email_signals"):
        if not should_notify(ns, sig, now, _watchlist_ids(db, user.id)):
            continue
        if not _record(db, user.id, "signal", sig.public_id):
            continue
        send_mail(
            user.email,
            f"Сигнал {symbol} {sig.direction.upper()} {sig.grade}",
            signal_text(sig, symbol, db.get(RiskProfile, user.id)) + unsubscribe_footer(ns),
        )
        ns.sent_today += 1
        sent += 1
    for user, ns in _recipients(db, "push_signals"):
        if not should_notify(ns, sig, now, _watchlist_ids(db, user.id)):
            continue
        if not _record_push(db, user.id, "signal", sig.public_id):
            continue
        sent += send_to_user(
            db,
            user.id,
            {
                "title": f"{symbol} {sig.direction.upper()} · {sig.grade}",
                "body": f"вход {_dec(sig.entry_limit or sig.entry_market)}, "
                f"стоп {_dec(sig.stop_loss)}, TP2 {_dec(sig.tp2)} (R:R {_dec(sig.rr_tp2)})",
                "url": f"/signals/{sig.public_id}",
                "tag": f"signal-{sig.public_id}",
            },
        )
    db.commit()
    return sent


def notify_event(db: Session, ev: SignalEvent, now: datetime | None = None) -> int:
    now = now or datetime.now(tz=UTC)
    sig = db.get(Signal, ev.signal_id)
    if sig is None or ev.type not in EVENT_TEXT or not _live_signal(sig):
        return 0
    symbol = db.scalar(select(Instrument.symbol).where(Instrument.id == sig.instrument_id)) or "?"
    sent = 0
    for user, ns in _recipients(db, "email_events"):
        if not should_notify(ns, sig, now, _watchlist_ids(db, user.id)):
            continue
        if not _record(db, user.id, "event", str(ev.id)):
            continue
        price = f" по {_dec(ev.price)}" if ev.price is not None else ""
        text = (
            f"{symbol} {sig.direction.upper()}: {EVENT_TEXT[ev.type]}{price}.\n"
            f"Время: {ev.occurred_at.strftime('%d.%m %H:%M UTC')}\n"
            f"Карточка: {settings.frontend_url}/signals/{sig.public_id}\n\n{DISCLAIMER}"
        )
        send_mail(
            user.email,
            f"{symbol}: {EVENT_TEXT[ev.type].split(' — ')[0]}",
            text + unsubscribe_footer(ns),
        )
        ns.sent_today += 1
        sent += 1
    for user, ns in _recipients(db, "push_events"):
        if not should_notify(ns, sig, now, _watchlist_ids(db, user.id)):
            continue
        if not _record_push(db, user.id, "event", str(ev.id)):
            continue
        sent += send_to_user(
            db,
            user.id,
            {
                "title": f"{symbol} {sig.direction.upper()}: {EVENT_TEXT[ev.type].split(' — ')[0]}",
                "body": f"{_dec(ev.price)}" if ev.price is not None else "",
                "url": f"/signals/{sig.public_id}",
                "tag": f"event-{ev.id}",
            },
        )
    db.commit()
    return sent


# --- форвард: владельцу и администраторам ------------------------------------------------------

STAFF_ROLES = ("owner", "admin")
"""Кто получает письма и push о сигналах форварда: форвард видят только они (план 2.11)."""
STAFF_SIGNAL, STAFF_EVENT = "fwd_signal", "fwd_event"
"""``notification_log.kind`` уведомлений о форварде: повтор по тому же сигналу или событию
невозможен (уникальность пользователь + канал + вид + ссылка)."""
DIRECTION = {"long": "LONG", "short": "SHORT"}


def _staff(db: Session) -> list[User]:
    """Владельцы и администраторы: не удалены и не заблокированы."""
    return list(
        db.scalars(
            select(User)
            .where(
                User.role.in_(STAFF_ROLES),
                User.deleted_at.is_(None),
                User.blocked_at.is_(None),
            )
            .order_by(User.id)
        ).all()
    )


def _forward_signal(sig: Signal) -> bool:
    """Уведомления владельцу и администраторам — по форвард-сигналам (``signals.scope``, область
    на момент публикации). Live-сигналы идут обычным путём, по настройкам пользователей."""
    return sig.scope == "forward"


def _signal_head(db: Session, sig: Signal) -> tuple[str, str]:
    symbol = db.scalar(select(Instrument.symbol).where(Instrument.id == sig.instrument_id)) or "?"
    return symbol, f"{symbol} {DIRECTION.get(sig.direction, sig.direction.upper())}"


def _levels_line(sig: Signal) -> str:
    return (
        f"вход {_dec(sig.entry_limit or sig.entry_market)}, стоп {_dec(sig.stop_loss)}, "
        f"TP1 / TP2 / TP3 {_dec(sig.tp1)} / {_dec(sig.tp2)} / {_dec(sig.tp3)}"
    )


def staff_signal_text(sig: Signal, symbol: str, version: str) -> str:
    """Письмо о новом сигнале форварда: инструмент, направление, уровни, градация, ссылка."""
    rows = [
        ("инструмент", symbol),
        ("направление", DIRECTION.get(sig.direction, sig.direction.upper())),
        ("градация", f"{sig.grade} ({sig.score})"),
        ("вход", _dec(sig.entry_limit or sig.entry_market)),
        ("стоп", _dec(sig.stop_loss)),
        ("TP1 / TP2 / TP3", f"{_dec(sig.tp1)} / {_dec(sig.tp2)} / {_dec(sig.tp3)}"),
        ("R:R до TP2", _dec(sig.rr_tp2)),
        ("версия стратегии", version),
        ("свеча", sig.candle_close_time.astimezone(UTC).strftime("%d.%m %H:%M UTC")),
    ]
    w = max(len(k) for k, _ in rows)
    table = "\n".join(f"{k.ljust(w)}  {v}" for k, v in rows)
    return (
        f"Новый сигнал форварда: {symbol}\n\n{table}\n\n"
        f"Карточка: {settings.frontend_url}/signals/{sig.public_id}\n\n"
        "Сигналы форварда видят только владелец и администраторы."
    )


def staff_event_text(sig: Signal, ev: SignalEvent, head: str, result: SignalResult | None) -> str:
    """Письмо о смене статуса сигнала форварда: что произошло, по какой цене, когда, результат."""
    price = f" по {_dec(ev.price)}" if ev.price is not None else ""
    lines = [
        f"{head} · {sig.grade}: {EVENT_TEXT[ev.type]}{price}.",
        f"Время: {ev.occurred_at.astimezone(UTC).strftime('%d.%m %H:%M UTC')}",
    ]
    if result is not None:
        lines.append(f"Результат: {_fmt_r(result.realized_r)} с учётом комиссии и проскальзывания.")
    lines += [
        f"Уровни: {_levels_line(sig)}.",
        f"Карточка: {settings.frontend_url}/signals/{sig.public_id}",
    ]
    return "\n".join(lines)


class StaffDeliveryError(RuntimeError):
    """Часть отправок владельцу и администраторам не удалась (сеть, сбой почты или push).
    Остальные адресаты и каналы уведомление получили, их отметки в ``notification_log``
    зафиксированы; неудавшиеся не отмечены — повтор того же вызова отправит только их
    (уведомитель повторяет, ``app.workers.notifier.StaffRetry``)."""

    def __init__(self, what: str, sent: int, failed: list[str]) -> None:
        super().__init__(f"{what}: не отправлено — {', '.join(failed)}")
        self.sent = sent
        self.failed = failed


def _staff_send(
    db: Session, user_id: int, channel: str, kind: str, ref: str, send: Callable[[], int]
) -> int | None:
    """Одна отправка сотруднику по одному каналу. Отметка в ``notification_log`` пишется в точке
    сохранения до отправки и фиксируется сразу после неё. Уже отмечено (отправлено раньше) — 0,
    без отправки. Ошибка отправки откатывает только эту отметку и пишется в лог — ``None``:
    не отправлено и не отмечено, остальные отправки не затронуты."""
    savepoint = db.begin_nested()
    db.add(NotificationLog(user_id=user_id, channel=channel, kind=kind, ref=ref))
    try:
        db.flush()
    except IntegrityError:
        savepoint.rollback()
        return 0
    try:
        n = send()
    except Exception:
        savepoint.rollback()
        log.exception("%s %s → пользователь %s (%s): не отправлено", kind, ref, user_id, channel)
        return None
    savepoint.commit()
    db.commit()
    return n


def _mail_one(to: str, subject: str, text: str) -> int:
    send_mail(to, subject, text)
    return 1


def _deliver_staff(
    db: Session, kind: str, ref: str, subject: str, text: str, push: dict[str, str]
) -> int:
    """Письмо (с подтверждённым адресом) и push каждому владельцу и администратору — каждая
    отправка отдельно (``_staff_send``). Возвращает число отправок; если какие-то не удались, —
    ``StaffDeliveryError`` после попытки всем."""
    sent = 0
    failed: list[str] = []
    for user in _staff(db):
        uid = user.id
        sends: list[tuple[str, Callable[[], int]]] = []
        if user.email_verified_at is not None:
            sends.append(("email", partial(_mail_one, user.email, subject, text)))
        sends.append(("push", partial(send_to_user, db, uid, push)))
        for channel, send in sends:
            n = _staff_send(db, uid, channel, kind, ref, send)
            if n is None:
                failed.append(f"{channel} пользователю {uid}")
            else:
                sent += n
    db.commit()
    if failed:
        raise StaffDeliveryError(f"{kind} {ref}", sent, failed)
    return sent


def notify_staff_signal(db: Session, sig: Signal) -> int:
    """Письмо и push о новом сигнале форварда — владельцам и администраторам (обычные
    пользователи форвард не получают). Возвращает число отправок; часть не ушла —
    ``StaffDeliveryError`` (ушедшие отмечены, повтор отправит остальные)."""
    if not _forward_signal(sig):
        return 0
    symbol, head = _signal_head(db, sig)
    version = db.scalar(
        select(StrategyVersion.version).where(StrategyVersion.id == sig.strategy_version_id)
    )
    title = f"Новый сигнал: {head} · {sig.grade}"
    return _deliver_staff(
        db,
        STAFF_SIGNAL,
        sig.public_id,
        title,
        staff_signal_text(sig, symbol, version or "?"),
        {
            "title": title,
            "body": _levels_line(sig),
            "url": f"/signals/{sig.public_id}",
            "tag": f"signal-{sig.public_id}",
        },
    )


def notify_staff_event(db: Session, ev: SignalEvent) -> int:
    """Письмо и push о смене статуса сигнала форварда (вход, TP1–TP3, безубыток, стоп, выход по
    времени, истечение) — владельцам и администраторам. Исправления исхода (``source =
    'retrack'``) не рассылаются. Часть отправок не ушла — ``StaffDeliveryError``."""
    if ev.type not in EVENT_TEXT or ev.source == CORRECTION_SOURCE:
        return 0
    sig = db.get(Signal, ev.signal_id)
    if sig is None or not _forward_signal(sig):
        return 0
    _, head = _signal_head(db, sig)
    what = EVENT_TEXT[ev.type].split(" — ")[0]
    result = db.get(SignalResult, sig.id) if ev.type in CLOSING_EVENTS else None
    body = f"по {_dec(ev.price)}" if ev.price is not None else ""
    if result is not None:
        body = f"{body}, итог {_fmt_r(result.realized_r)}".lstrip(", ")
    return _deliver_staff(
        db,
        STAFF_EVENT,
        str(ev.id),
        f"{head}: {what}",
        staff_event_text(sig, ev, head, result),
        {
            "title": f"{head}: {what}",
            "body": body,
            "url": f"/signals/{sig.public_id}",
            "tag": f"event-{ev.id}",
        },
    )


def unsubscribe_footer(ns: NotificationSettings) -> str:
    return (
        "\n\n—\nОтписаться от писем: "
        f"{settings.frontend_url}/unsubscribe?token={ns.unsubscribe_token}\n"
        f"Настройки уведомлений: {settings.frontend_url}/settings"
    )


def digest_text(db: Session, user: User, period: str, now: datetime) -> str | None:
    days = 7 if period == "weekly" else 1
    since = now - timedelta(days=days)
    closed = db.execute(
        select(Signal, Instrument.symbol, SignalResult)
        .join(Instrument, Instrument.id == Signal.instrument_id)
        .join(SignalResult, SignalResult.signal_id == Signal.id)
        .where(Signal.scope == "live", SignalResult.closed_at >= since)
        .order_by(SignalResult.closed_at)
    ).all()
    active = db.execute(
        select(Signal, Instrument.symbol)
        .join(Instrument, Instrument.id == Signal.instrument_id)
        .where(
            Signal.scope == "live",
            Signal.status.in_(("pending", "active", "tp1_hit", "tp2_hit")),
        )
        .order_by(Signal.candle_close_time.desc())
    ).all()
    if not closed and not active and period == "daily":
        return None  # пустой ежедневный дайджест не шлём
    m = summarize(load_trades(db, "live", since=now - timedelta(days=30)))
    lines = [
        f"Platform — {'недельный' if period == 'weekly' else 'ежедневный'} дайджест, "
        f"{now.strftime('%d.%m.%Y')}",
        "",
    ]
    lines.append(f"Закрыто за {'неделю' if period == 'weekly' else 'сутки'}: {len(closed)}")
    for sig, sym, res in closed:
        lines.append(
            f"  {sym:<12} {sig.direction.upper():<5} {sig.grade}  "
            f"{_fmt_r(res.realized_r):>9}  {sig.status}"
        )
    lines.append(f"Активных сейчас: {len(active)}")
    for sig, sym in active[:10]:
        lines.append(
            f"  {sym:<12} {sig.direction.upper():<5} {sig.grade}  {sig.status}  "
            f"вход {_dec(sig.entry_limit or sig.entry_market)}"
        )
    wr = f"{float(m.winrate) * 100:.0f} %" if m.winrate is not None else "—"
    lines += [
        "",
        f"За 30 дней: сделок {m.closed}, винрейт {wr}, средний R {_fmt_r(m.avg_r)}, "
        f"итог {_fmt_r(m.sum_r)}, просадка {_fmt_r(-m.max_drawdown_r)}.",
        f"Лента: {settings.frontend_url}/signals",
        f"Статистика: {settings.frontend_url}/stats",
        "",
        DISCLAIMER,
    ]
    return "\n".join(lines)


def run_digest(db: Session, period: str = "daily", now: datetime | None = None) -> int:
    """Рассылает дайджест всем с подходящей настройкой; одна отправка на день/пользователя.
    Дайджест — о сигналах: пока они закрыты (ADR-0013), его получают только admin и owner.

    Отметка в ``notification_log`` пишется (flush) до письма и фиксируется после него: строка
    с уникальным ключом (пользователь, канал, вид, дата) — блокировка. Параллельный проход
    (уведомитель и cron-скрипт, два экземпляра при выкладке) ждёт её на вставке, а после фиксации
    получает конфликт и пропускает адрес; повтор не шлёт дубль тем, кому уже отправлено, а сбой на
    одном адресе не откатывает отметки остальных. Упал между письмом и фиксацией — повтор с тем
    же ключом идемпотентности (``mail_key``) провайдер не отправит второй раз. Письмо, которое
    провайдер не принял, не отмечается (``_send_recorded``); временный отказ прерывает проход
    исключением — повторит уведомитель."""
    if not mail_ready():
        log.warning("дайджест %s: нет ключа почты — пропуск, отправит процесс с ключом", period)
        return 0
    now = now or datetime.now(tz=UTC)
    ref = f"{period}:{now.strftime('%Y-%m-%d')}"
    rows = db.execute(
        select(User, NotificationSettings)
        .join(NotificationSettings, NotificationSettings.user_id == User.id)
        .where(User.deleted_at.is_(None), User.email_verified_at.is_not(None))
        .where(NotificationSettings.email_digest == period)
        .order_by(User.id)
    ).all()
    sent = 0
    for user, ns in rows:
        if not signals_open(user):
            continue
        text = digest_text(db, user, period, now)
        if text is None or not _record(db, user.id, "digest", ref):
            continue
        sent += _send_recorded(
            db,
            user.email,
            f"Platform: дайджест {now.strftime('%d.%m')}",
            text + unsubscribe_footer(ns),
            mail_key("digest", user.id, ref),
        )
    db.commit()
    log.info("дайджест %s: отправлено %d из %d", period, sent, len(rows))
    return sent


# --- еженедельный отчёт по журналу (план 3.8 v2) -----------------------------------------------

WEEKDAYS_RU = ("пн", "вт", "ср", "чт", "пт", "сб", "вс")
GRADE_TITLES = {"A": "A", "B": "B", "C": "C", "none": "без сигнала"}


def _bucket_line(title: str, b: dict[str, Any]) -> str:
    wr = f"{b['winrate'] * 100:.0f} %" if b["winrate"] is not None else "—"
    total = _fmt_r(Decimal(b["sum_r"]))
    return f"  {title:<14} сделок {b['closed']}/{b['trades']}  итог {total}  винрейт {wr}"


def journal_report_lines(a: dict[str, Any], now: datetime, signals: bool = True) -> list[str]:
    """Текст отчёта по готовой аналитике (чистая функция, тестируется без БД). ``signals=False``
    — получателю сигналы не видны (ADR-0013): без градаций сигналов и ошибок «по сигналу»."""
    t = a["total"]
    wr = f"{t['winrate'] * 100:.0f} %" if t["winrate"] is not None else "—"
    avg = _fmt_r(Decimal(t["avg_r"])) if t["avg_r"] is not None else "—"
    lines = [
        f"Platform — отчёт по журналу за неделю, {now.strftime('%d.%m.%Y')}",
        "",
        f"Сделок: {t['trades']}, закрыто {t['closed']}, итог {_fmt_r(Decimal(t['sum_r']))}, "
        f"средний R {avg}, винрейт {wr}.",
    ]
    dd = a["equity"]["max_drawdown_r"]
    if dd is not None:
        lines.append(f"Максимальная просадка за неделю: {_fmt_r(-Decimal(dd))}.")
    lines += ["", "По инструментам:"]
    lines += [_bucket_line(str(b["key"]), b) for b in a["by_symbol"][:8]]
    if signals:
        lines += ["", "По градациям сигналов:"]
        lines += [
            _bucket_line(GRADE_TITLES.get(str(b["key"]), str(b["key"])), b) for b in a["by_grade"]
        ]
    lines += ["", "По дням недели:"]
    lines += [_bucket_line(WEEKDAYS_RU[int(b["key"])], b) for b in a["by_weekday"]]
    e = a["errors"]
    lines += ["", "Типовые ошибки:"]
    if signals:
        lines += [
            f"  ранний выход: {e['early_exit']['count']} из {e['early_exit']['of']} "
            "сделок по сигналу",
            f"  вход без сигнала: {e['no_signal']['count']} из {e['no_signal']['of']}",
        ]
    if e["risk_exceeded"]["budget_usd"] is None:
        lines.append("  превышение риска: не оценивается — задайте депозит в настройках")
    else:
        lines.append(
            f"  превышение риска: {e['risk_exceeded']['count']} из {e['risk_exceeded']['of']} "
            f"(бюджет {e['risk_exceeded']['budget_usd']} USDT)"
        )
    lines += ["", f"Журнал: {settings.frontend_url}/journal", "", DISCLAIMER]
    return lines


def journal_report_text(db: Session, user: User, now: datetime) -> str | None:
    """Отчёт за 7 дней; None, если за неделю нет закрытых сделок. Тому, кому сигналы не видны
    (ADR-0013), — без сопоставления с сигналами."""
    since = now - timedelta(days=7)
    rows = db.execute(
        select(JournalEntry, Instrument.symbol, Signal.grade, SignalResult.realized_r)
        .join(Instrument, Instrument.id == JournalEntry.instrument_id)
        .outerjoin(Signal, Signal.id == JournalEntry.signal_id)
        .outerjoin(SignalResult, SignalResult.signal_id == JournalEntry.signal_id)
        .where(
            JournalEntry.user_id == user.id,
            or_(JournalEntry.exit_at >= since, JournalEntry.entry_at >= since),
        )
    ).all()
    trades = [
        TradeRow(
            symbol=sym,
            direction=e.direction,
            entry_at=e.entry_at,
            exit_at=e.exit_at,
            entry_price=e.entry_price,
            stop_loss=e.stop_loss,
            size=e.size,
            realized_r=e.realized_r,
            signal_id=e.signal_id,
            grade=grade,
            system_r=sys_r,
        )
        for e, sym, grade, sys_r in rows
    ]
    if not any(t.realized_r is not None for t in trades):
        return None
    open_ = signals_open(user)
    if not open_:
        trades = [without_signal(t) for t in trades]
    risk = db.get(RiskProfile, user.id)
    a = analytics(trades, risk.deposit if risk else None, risk.risk_pct if risk else None)
    return "\n".join(journal_report_lines(a, now, signals=open_))


def run_journal_reports(db: Session, now: datetime | None = None) -> int:
    """Еженедельно (по понедельникам, вместе с дайджестом): всем, у кого письма не выключены
    и за неделю есть закрытые сделки. Одна отправка на дату; отметка — как у дайджеста
    (``run_digest``, ``_send_recorded``)."""
    if not mail_ready():
        log.warning("отчёт по журналу: нет ключа почты — пропуск, отправит процесс с ключом")
        return 0
    now = now or datetime.now(tz=UTC)
    ref = f"journal:{now.strftime('%Y-%m-%d')}"
    rows = db.execute(
        select(User, NotificationSettings)
        .join(NotificationSettings, NotificationSettings.user_id == User.id)
        .where(User.deleted_at.is_(None), User.email_verified_at.is_not(None))
        .where(NotificationSettings.email_digest != "off")
        .order_by(User.id)
    ).all()
    sent = 0
    for user, ns in rows:
        text = journal_report_text(db, user, now)
        if text is None or not _record(db, user.id, "journal", ref):
            continue
        sent += _send_recorded(
            db,
            user.email,
            f"Platform: отчёт по журналу {now.strftime('%d.%m')}",
            text + unsubscribe_footer(ns),
            mail_key("journal", user.id, ref),
        )
    db.commit()
    log.info("отчёт по журналу: отправлено %d из %d", sent, len(rows))
    return sent


def send_test(db: Session, user: User) -> str:
    """Тестовое письмо себе (приёмка 2.13: «тестовая доставка»): образец того, что придёт по
    подписке. Дайджест — о сигналах, пока они закрыты (ADR-0013), его образец получают только
    admin и owner; остальным — отчёт по журналу (если есть сделки) или короткий текст."""
    ns = settings_for(db, user)
    now = datetime.now(tz=UTC)
    sample = (
        digest_text(db, user, "weekly", now)
        if signals_open(user)
        else journal_report_text(db, user, now)
    )
    text = sample or "Тестовое письмо Platform: доставка работает."
    send_mail(user.email, "Platform: тестовое письмо", text + unsubscribe_footer(ns))
    db.add(NotificationLog(user_id=user.id, channel="email", kind="test", ref=now.isoformat()))
    db.commit()
    return (
        "отправлено"
        if settings.resend_api_key
        else "ключ почты не задан: письмо записано в лог сервера"
    )


def unsubscribe(db: Session, token: str) -> bool:
    """Отписка по ссылке из письма: выключает все рассылки по email — дайджест, сигналы, события
    и письма алертов (страница отписки обещает «от всех писем»; ссылка стоит и в письмах алертов).
    Push и письма входа/восстановления пароля не трогает."""
    ns = db.scalar(
        select(NotificationSettings).where(NotificationSettings.unsubscribe_token == token)
    )
    if ns is None:
        return False
    ns.email_digest = "off"
    ns.email_signals = False
    ns.email_events = False
    ns.email_alerts = False
    db.commit()
    return True


def settings_dict(ns: NotificationSettings) -> dict[str, Any]:
    return {
        "email_digest": ns.email_digest,
        "email_signals": ns.email_signals,
        "email_events": ns.email_events,
        "grades": ns.grades,
        "scope": ns.scope,
        "quiet_from": ns.quiet_from,
        "quiet_to": ns.quiet_to,
        "daily_limit": ns.daily_limit,
        "push_signals": ns.push_signals,
        "push_events": ns.push_events,
        "email_alerts": ns.email_alerts,
        "push_alerts": ns.push_alerts,
        "telegram_linked": ns.telegram_chat_id is not None,
    }
