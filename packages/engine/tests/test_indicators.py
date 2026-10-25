from __future__ import annotations

from decimal import Decimal

import pytest

from engine.candles import Candle
from engine.indicators import atr, ema, sma, true_range
from engine.testing import make_candles


def test_sma_matches_hand_calculation(h4_candles: list[Candle]) -> None:
    # close = 100, 101, 102, ... → SMA(3) на третьей свече = 101
    result = sma(h4_candles, 3)
    assert result[:2] == [None, None]
    assert result[2] == Decimal("101.0")
    assert result[-1] == Decimal(str(float(h4_candles[-1].close) - 1))


def test_sma_short_series_is_all_none() -> None:
    assert sma(make_candles(2), 3) == [None, None]


def test_ema_seeded_with_sma(h4_candles: list[Candle]) -> None:
    result = ema(h4_candles, 3)
    assert result[:2] == [None, None]
    assert result[2] == Decimal("101.0")
    # alpha=0.5: ema3 = 0.5*103 + 0.5*101 = 102
    assert result[3] == Decimal("102.0")


def test_true_range_and_atr() -> None:
    candles = make_candles(16)
    tr = true_range(candles)
    # каждая свеча: high-low = (close+1) - (open-1) = 2.5; разрыв к prev_close = 1 → max = 2.5
    assert tr[0] == Decimal("2.5")
    assert all(x == Decimal("2.5") for x in tr[1:])
    result = atr(candles, 14)
    assert result[12] is None
    assert result[13] == Decimal("2.5")
    assert result[15] == Decimal("2.5")


def test_indicators_reject_bad_period(h4_candles: list[Candle]) -> None:
    for fn in (sma, ema, atr):
        with pytest.raises(ValueError):
            fn(h4_candles, 0)


def test_atr_short_series() -> None:
    assert atr(make_candles(3), 14) == [None, None, None]
