"""Вспомогательные генераторы данных для тестов движка и golden-наборов."""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

from engine.candles import Candle, Timeframe


def make_candles(
    n: int,
    tf: Timeframe = Timeframe.H4,
    start: datetime | None = None,
    base: float = 100.0,
    step: float = 1.0,
) -> list[Candle]:
    """Ряд из n свечей с линейным ростом close: удобно проверять индикаторы руками."""
    start = start or datetime(2024, 1, 1, tzinfo=UTC)
    out: list[Candle] = []
    for i in range(n):
        close = Decimal(str(base + step * i))
        open_ = close - Decimal("0.5")
        out.append(
            Candle(
                open_time=start + tf.delta * i,
                open=open_,
                high=close + Decimal("1"),
                low=open_ - Decimal("1"),
                close=close,
                volume=Decimal("10"),
            )
        )
    return out
