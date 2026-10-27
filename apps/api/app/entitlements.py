"""Тарифные ограничения (план, раздел 4; задача 3.3). Одна система сигналов для всех — различаются
скорость доступа, набор инструментов и глубина инструментария. Пока ``BILLING_ENABLED=false``
все пользователи получают уровень Pro (``billing.plan_for``).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.billing import plan_for
from app.models import Instrument, User, Watchlist, WatchlistItem
from app.plans import FREE, PREMIUM, PRO

FREE_BASE_SYMBOLS = ("BTCUSDT", "ETHUSDT")


@dataclass(frozen=True, slots=True)
class Entitlements:
    plan: str
    signal_grades: tuple[str, ...] | None
    """Какие градации видны (None — все)."""
    signal_delay_hours: int
    """Задержка публикации сигналов для тарифа (0 — сразу)."""
    all_instruments: bool
    """False — только BTC, ETH + инструменты вотчлиста."""
    instant_notifications: bool
    """Письма/push по каждому сигналу; иначе только дневной дайджест."""
    csv_export: bool
    forward_scope: bool
    """Экспериментальные стратегии (forward) — Premium."""
    journal_limit: int | None
    watchlist_limit: int | None
    intraday: bool = True
    """Таймфреймы 1m–15m на графике (Free — нет, план 2A.3)."""
    drawings_limit: int | None = None
    """Рисунков на инструмент (раздел 4: 10 / 100 / без лимита)."""
    drawings_sync: bool = True
    """Синхронизация рисунков между устройствами (Free — нет)."""
    layouts_limit: int | None = None
    """Именованных раскладок (раздел 4: 0 / 5 / 20)."""


ENTITLEMENTS: dict[str, Entitlements] = {
    FREE: Entitlements(FREE, ("A",), 12, False, False, False, False, 20, 5, False, 10, False, 0),
    PRO: Entitlements(PRO, None, 0, True, True, True, False, None, 50, True, 100, True, 5),
    PREMIUM: Entitlements(
        PREMIUM, None, 0, True, True, True, True, None, None, True, None, True, 20
    ),
}


def entitlements(plan: str) -> Entitlements:
    return ENTITLEMENTS.get(plan, ENTITLEMENTS[FREE])


def entitlements_for(db: Session, user: User | None, now: datetime | None = None) -> Entitlements:
    if user is None:
        return ENTITLEMENTS[FREE]
    if user.role in ("admin", "owner"):
        return ENTITLEMENTS[PREMIUM]
    return entitlements(plan_for(db, user, now))


def visible_since(ent: Entitlements, now: datetime) -> datetime | None:
    """Сигналы с закрытием свечи позже этого момента для тарифа ещё не видны."""
    return now - timedelta(hours=ent.signal_delay_hours) if ent.signal_delay_hours else None


def signal_visible(
    ent: Entitlements, grade: str, candle_close_time: datetime, now: datetime
) -> bool:
    """Чистая проверка одного сигнала: градация и задержка."""
    if ent.signal_grades is not None and grade not in ent.signal_grades:
        return False
    vs = visible_since(ent, now)
    return vs is None or candle_close_time <= vs


def allowed_instrument_ids(db: Session, user: User | None, ent: Entitlements) -> list[int] | None:
    """None — все инструменты; иначе список id (BTC, ETH + вотчлист)."""
    if ent.all_instruments:
        return None
    ids = set(
        db.scalars(select(Instrument.id).where(Instrument.symbol.in_(FREE_BASE_SYMBOLS))).all()
    )
    if user is not None:
        ids |= set(
            db.scalars(
                select(WatchlistItem.instrument_id)
                .join(Watchlist, Watchlist.id == WatchlistItem.watchlist_id)
                .where(Watchlist.user_id == user.id)
            ).all()
        )
    return sorted(ids)


def restrictions_dict(ent: Entitlements) -> dict[str, object]:
    return {
        "plan": ent.plan,
        "grades": list(ent.signal_grades) if ent.signal_grades else None,
        "delay_hours": ent.signal_delay_hours,
        "all_instruments": ent.all_instruments,
        "csv_export": ent.csv_export,
        "forward_scope": ent.forward_scope,
        "journal_limit": ent.journal_limit,
        "watchlist_limit": ent.watchlist_limit,
        "intraday": ent.intraday,
        "drawings_limit": ent.drawings_limit,
        "drawings_sync": ent.drawings_sync,
        "layouts_limit": ent.layouts_limit,
    }
