"""Деривативные ряды: funding, открытый интерес, ликвидации, long/short ratio.

Простые неизменяемые записи с временем в UTC. Ряды подаются в фильтры уже обрезанными
по моменту расчёта; для надёжности фильтры дополнительно отбрасывают записи позже ``at``.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Protocol, TypeVar


class Timed(Protocol):
    @property
    def time(self) -> datetime: ...


T = TypeVar("T", bound=Timed)


@dataclass(frozen=True, slots=True)
class FundingRate:
    time: datetime
    """Момент выплаты funding (каждые 8 часов на Binance/Bybit)."""
    rate: Decimal
    """Ставка за период, доля (0.0001 = 0.01 %)."""


@dataclass(frozen=True, slots=True)
class OpenInterest:
    time: datetime
    value: Decimal
    """OI в quote-валюте (USDT)."""


@dataclass(frozen=True, slots=True)
class LiquidationBucket:
    time: datetime
    """Начало интервала агрегации (обычно свеча H4)."""
    long_usd: Decimal
    """Ликвидированные лонги (продажи по рынку)."""
    short_usd: Decimal


@dataclass(frozen=True, slots=True)
class LongShortRatio:
    time: datetime
    long_pct: Decimal
    """Доля лонгов среди трейдеров, 0–1."""


@dataclass(frozen=True, slots=True)
class CalendarEvent:
    time: datetime
    title: str
    importance: int
    """1 — низкая, 2 — средняя, 3 — высокая (FOMC, CPI, NFP, решения ЦБ)."""


@dataclass(frozen=True, slots=True)
class TokenEvent:
    time: datetime
    kind: str
    """unlock / upgrade / delisting."""
    pct_supply: Decimal = Decimal(0)


def upto[T: Timed](series: Sequence[T], at: datetime) -> list[T]:
    """Записи с временем не позже ``at`` — защита от утечки будущего."""
    return [x for x in series if x.time <= at]
