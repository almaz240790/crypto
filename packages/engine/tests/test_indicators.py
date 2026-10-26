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


# --- индикаторы терминала (план 2A.4) -----------------------------------------------------------


def _mk(
    closes: list[float], highs: list[float] | None = None, lows: list[float] | None = None
) -> list[Candle]:
    from datetime import UTC, datetime, timedelta
    from decimal import Decimal

    out = []
    t0 = datetime(2026, 1, 1, tzinfo=UTC)
    for i, c in enumerate(closes):
        h = highs[i] if highs else c + 1
        lo = lows[i] if lows else c - 1
        out.append(
            Candle(
                t0 + timedelta(hours=4 * i),
                Decimal(str(c)),
                Decimal(str(h)),
                Decimal(str(lo)),
                Decimal(str(c)),
                Decimal(10),
            )
        )
    return out


def test_rsi_hand_calculation() -> None:
    from engine.indicators import rsi

    # 5 ростов по 1 и 5 падений по 1 при period=5: после первых 5 изменений avg_loss = 0 → 100
    r = rsi(_mk([1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1]), 5)
    assert r[:5] == [None] * 5 and r[5] == 100
    # далее: avg_gain = (1*4+0)/5 = 0.8, avg_loss = 0.2 → RS 4 → RSI 80
    assert float(r[6] or 0) == 80.0
    assert r[-1] is not None and 0 <= float(r[-1]) < 50


def test_macd_relationships() -> None:
    from engine.indicators import ema, macd

    candles = _mk([float(100 + ((i * 37) % 11) - 5) for i in range(80)])
    line, sig, hist = macd(candles, 12, 26, 9)
    e12, e26 = ema(candles, 12), ema(candles, 26)
    assert line[:25] == [None] * 25 and line[25] is not None
    assert abs(float(line[40] or 0) - (float(e12[40] or 0) - float(e26[40] or 0))) < 1e-9
    assert sig[:33] == [None] * 33 and sig[33] is not None
    assert abs(float(hist[50] or 0) - (float(line[50] or 0) - float(sig[50] or 0))) < 1e-9


def test_stochastic_bounds_and_flat() -> None:
    from engine.indicators import stochastic

    flat = _mk([5.0] * 10, [5.0] * 10, [5.0] * 10)
    k, d = stochastic(flat, 3, 2, 2)
    assert k[3] == 50 and d[4] == 50
    rising = _mk([float(i) for i in range(20)])
    k, _ = stochastic(rising, 5, 3, 1)
    assert k[4] is not None and 0 <= float(k[4]) <= 100


def test_bollinger_population_std() -> None:
    from engine.indicators import bollinger

    mid, up, lo = bollinger(_mk([1, 2, 3, 4, 5]), 5, 2.0)
    assert float(mid[4] or 0) == 3.0
    # σ населения для 1..5 = sqrt(2)
    assert abs(float(up[4] or 0) - (3 + 2 * 2**0.5)) < 1e-12
    assert abs(float(lo[4] or 0) - (3 - 2 * 2**0.5)) < 1e-12


def test_vwap_daily_resets_at_midnight() -> None:
    from engine.indicators import vwap_daily

    candles = _mk([10, 20, 30, 40, 50, 60, 70, 80])  # 6 свечей в первом дне, 2 во втором
    v = vwap_daily(candles)
    tp = lambda c: (float(c.high) + float(c.low) + float(c.close)) / 3  # noqa: E731
    assert abs(float(v[1] or 0) - (tp(candles[0]) + tp(candles[1])) / 2) < 1e-12
    assert abs(float(v[6] or 0) - tp(candles[6])) < 1e-12  # новый день — только своя свеча


def test_supertrend_direction_follows_trend() -> None:
    from engine.indicators import supertrend

    up = _mk([float(100 + i * 3) for i in range(40)])
    line, direction = supertrend(up, 10, 3.0)
    assert direction[:9] == [None] * 9
    assert direction[-1] == 1 and line[-1] is not None and float(line[-1]) < float(up[-1].close)
    down = _mk([float(300 - i * 3) for i in range(40)])
    _, direction = supertrend(down, 10, 3.0)
    assert direction[-1] == -1
