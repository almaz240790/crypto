"""Базовые типы: таймфрейм, свеча, проверки целостности ряда."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from enum import StrEnum
from itertools import pairwise


class Timeframe(StrEnum):
    M1 = "1m"
    M5 = "5m"
    M15 = "15m"
    H1 = "1h"
    H4 = "4h"
    D1 = "1d"
    W1 = "1w"

    @property
    def delta(self) -> timedelta:
        return _DELTAS[self]

    @property
    def seconds(self) -> int:
        return int(self.delta.total_seconds())


_DELTAS: dict[Timeframe, timedelta] = {
    Timeframe.M1: timedelta(minutes=1),
    Timeframe.M5: timedelta(minutes=5),
    Timeframe.M15: timedelta(minutes=15),
    Timeframe.H1: timedelta(hours=1),
    Timeframe.H4: timedelta(hours=4),
    Timeframe.D1: timedelta(days=1),
    Timeframe.W1: timedelta(weeks=1),
}


@dataclass(frozen=True, slots=True)
class Candle:
    """Одна свеча. ``open_time`` — начало интервала в UTC. Цены и объёмы — Decimal."""

    open_time: datetime
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: Decimal
    quote_volume: Decimal = Decimal(0)
    trades: int = 0

    def __post_init__(self) -> None:
        if self.open_time.tzinfo is None or self.open_time.utcoffset() != timedelta(0):
            raise ValueError("open_time должен быть timezone-aware в UTC")
        if not (self.low <= self.open <= self.high and self.low <= self.close <= self.high):
            raise ValueError(f"нарушение low<=open/close<=high в свече {self.open_time}")
        if self.volume < 0:
            raise ValueError("объём не может быть отрицательным")

    def close_time(self, tf: Timeframe) -> datetime:
        """Момент закрытия свечи (начало следующего интервала)."""
        return self.open_time + tf.delta

    @property
    def body(self) -> Decimal:
        return abs(self.close - self.open)

    @property
    def range(self) -> Decimal:
        return self.high - self.low

    @property
    def is_bullish(self) -> bool:
        return self.close > self.open


def closed_only(candles: Sequence[Candle], tf: Timeframe, now: datetime) -> list[Candle]:
    """Оставляет только свечи, закрывшиеся к моменту ``now``.

    Единственная точка, где движок отсекает незакрытую свечу. Всё остальное
    получает результат этой функции и не проверяет закрытие заново.
    """
    if now.tzinfo is None:
        raise ValueError("now должен быть timezone-aware")
    now = now.astimezone(UTC)
    return [c for c in candles if c.close_time(tf) <= now]


def ensure_continuous(candles: Sequence[Candle], tf: Timeframe) -> None:
    """Проверяет, что свечи идут подряд без пропусков и дублей. Иначе ValueError.

    Для W1 Binance открывает свечу в понедельник 00:00 UTC, шаг — ровно 7 дней,
    поэтому арифметическая проверка подходит и для недель.
    """
    for prev, cur in pairwise(candles):
        expected = prev.open_time + tf.delta
        if cur.open_time != expected:
            raise ValueError(
                f"пропуск или дубль: после {prev.open_time.isoformat()} ожидалась "
                f"{expected.isoformat()}, получена {cur.open_time.isoformat()}"
            )


def find_gaps(candles: Sequence[Candle], tf: Timeframe) -> list[tuple[datetime, datetime]]:
    """Возвращает список (ожидалось, получено) для всех разрывов ряда."""
    gaps: list[tuple[datetime, datetime]] = []
    for prev, cur in pairwise(candles):
        expected = prev.open_time + tf.delta
        if cur.open_time != expected:
            gaps.append((expected, cur.open_time))
    return gaps
