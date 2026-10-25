"""Уведомления по email (план 3.11, задача 2.13).

- ``notify_new_signal`` / ``notify_event`` — мгновенные письма по live-сигналам с учётом настроек:
  градации, инструменты (все / вотчлист), тихие часы (UTC), суточный лимит; каждая отправка
  записывается в ``notification_log`` (повтор невозможен).
- ``run_digest`` — ежедневный/еженедельный дайджест: закрытые сигналы за период, активные,
  метрики за 30 дней, ссылка отписки.
Тексты — простые, без обещаний (план 8). Без ключа Resend письма уходят в лог.
"""

from __future__ import annotations

import logging
import secrets
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import settings
from app.mail import send_mail
from app.models import (
    Instrument,
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


def _live_signal(db: Session, sig: Signal) -> bool:
    return (
        db.scalar(
            select(StrategyVersion.status).where(StrategyVersion.id == sig.strategy_version_id)
        )
        == "live"
    )


def _recipients(db: Session, flag: str) -> list[tuple[User, NotificationSettings]]:
    rows = db.execute(
        select(User, NotificationSettings)
        .join(NotificationSettings, NotificationSettings.user_id == User.id)
        .where(User.deleted_at.is_(None), User.email_verified_at.is_not(None))
        .where(getattr(NotificationSettings, flag).is_(True))
    ).all()
    return [(u, ns) for u, ns in rows]


def notify_new_signal(db: Session, sig: Signal, now: datetime | None = None) -> int:
    """Письма всем, у кого включены письма о сигналах. Возвращает число отправок."""
    now = now or datetime.now(tz=UTC)
    if not _live_signal(db, sig):
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
    db.commit()
    return sent


def notify_event(db: Session, ev: SignalEvent, now: datetime | None = None) -> int:
    now = now or datetime.now(tz=UTC)
    sig = db.get(Signal, ev.signal_id)
    if sig is None or ev.type not in EVENT_TEXT or not _live_signal(db, sig):
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
    db.commit()
    return sent


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
        .join(StrategyVersion, StrategyVersion.id == Signal.strategy_version_id)
        .join(SignalResult, SignalResult.signal_id == Signal.id)
        .where(StrategyVersion.status == "live", SignalResult.closed_at >= since)
        .order_by(SignalResult.closed_at)
    ).all()
    active = db.execute(
        select(Signal, Instrument.symbol)
        .join(Instrument, Instrument.id == Signal.instrument_id)
        .join(StrategyVersion, StrategyVersion.id == Signal.strategy_version_id)
        .where(
            StrategyVersion.status == "live",
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
    """Рассылает дайджест всем с подходящей настройкой; одна отправка на день/пользователя."""
    now = now or datetime.now(tz=UTC)
    ref = f"{period}:{now.strftime('%Y-%m-%d')}"
    rows = db.execute(
        select(User, NotificationSettings)
        .join(NotificationSettings, NotificationSettings.user_id == User.id)
        .where(User.deleted_at.is_(None), User.email_verified_at.is_not(None))
        .where(NotificationSettings.email_digest == period)
    ).all()
    sent = 0
    for user, ns in rows:
        text = digest_text(db, user, period, now)
        if text is None or not _record(db, user.id, "digest", ref):
            continue
        send_mail(
            user.email, f"Platform: дайджест {now.strftime('%d.%m')}", text + unsubscribe_footer(ns)
        )
        sent += 1
    db.commit()
    log.info("дайджест %s: отправлено %d из %d", period, sent, len(rows))
    return sent


def send_test(db: Session, user: User) -> str:
    """Тестовое письмо себе (приёмка 2.13: «тестовая доставка»)."""
    ns = settings_for(db, user)
    now = datetime.now(tz=UTC)
    text = digest_text(db, user, "weekly", now) or "Тестовое письмо Platform: доставка работает."
    send_mail(user.email, "Platform: тестовое письмо", text + unsubscribe_footer(ns))
    db.add(NotificationLog(user_id=user.id, channel="email", kind="test", ref=now.isoformat()))
    db.commit()
    return (
        "отправлено"
        if settings.resend_api_key
        else "ключ почты не задан: письмо записано в лог сервера"
    )


def unsubscribe(db: Session, token: str) -> bool:
    ns = db.scalar(
        select(NotificationSettings).where(NotificationSettings.unsubscribe_token == token)
    )
    if ns is None:
        return False
    ns.email_digest = "off"
    ns.email_signals = False
    ns.email_events = False
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
        "telegram_linked": ns.telegram_chat_id is not None,
    }
