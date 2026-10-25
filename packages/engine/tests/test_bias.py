from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from engine.bias import Bias, compute_bias, context_at
from engine.candles import Candle, Timeframe
from engine.params import BiasParams
from engine.structure import Trend

T0 = datetime(2024, 1, 1, tzinfo=UTC)  # понедельник


def zigzag(n: int, tf: Timeframe, start: float, step: float, amp: float = 3.0) -> list[Candle]:
    """Тренд с откатами: каждые 4 свечи — новый экстремум выше/ниже предыдущего на step."""
    out = []
    for i in range(n):
        leg = i // 4
        pos = i % 4
        base = start + step * leg + (amp if pos == 2 else 0) * (1 if step > 0 else -1)
        close = base + (0.5 if pos in (1, 2) else -0.5) * (1 if step > 0 else -1)
        out.append(
            Candle(
                open_time=T0 + tf.delta * i,
                open=Decimal(str(base)),
                high=Decimal(str(max(base, close) + 1)),
                low=Decimal(str(min(base, close) - 1)),
                close=Decimal(str(close)),
                volume=Decimal(1),
            )
        )
    return out


def test_long_bias_when_d1_up_above_ema_and_w1_not_down() -> None:
    d1 = zigzag(80, Timeframe.D1, 100, 2)
    w1 = zigzag(20, Timeframe.W1, 100, 2)
    ctx = compute_bias(d1, w1)
    assert ctx.d1_trend is Trend.UP and ctx.w1_trend is Trend.UP
    assert ctx.ema is not None and ctx.d1_close is not None and ctx.d1_close > ctx.ema
    assert ctx.ema_slope is not None and ctx.ema_slope > 0
    assert ctx.bias is Bias.LONG
    assert any("выше EMA50" in r for r in ctx.reasons)


def test_short_bias_mirror() -> None:
    d1 = zigzag(80, Timeframe.D1, 300, -2)
    w1 = zigzag(20, Timeframe.W1, 300, -2)
    ctx = compute_bias(d1, w1)
    assert ctx.bias is Bias.SHORT and ctx.d1_trend is Trend.DOWN


def test_neutral_when_w1_against() -> None:
    d1 = zigzag(80, Timeframe.D1, 100, 2)
    w1 = zigzag(20, Timeframe.W1, 300, -2)
    assert compute_bias(d1, w1).bias is Bias.NEUTRAL


def test_neutral_when_below_ema_despite_structure() -> None:
    d1 = zigzag(80, Timeframe.D1, 100, 2)
    # последняя свеча резко вниз: структура ещё «вверх», но закрытие ниже EMA50
    last = d1[-1]
    d1[-1] = Candle(last.open_time, last.open, last.high, Decimal(50), Decimal(60), last.volume)
    ctx = compute_bias(d1, zigzag(20, Timeframe.W1, 100, 2))
    assert ctx.bias is Bias.NEUTRAL and ctx.d1_trend is Trend.UP


def test_neutral_without_enough_history() -> None:
    ctx = compute_bias(zigzag(10, Timeframe.D1, 100, 2), [])
    assert ctx.bias is Bias.NEUTRAL and ctx.ema is None
    assert any("мало истории" in r for r in ctx.reasons)
    assert compute_bias([], []).bias is Bias.NEUTRAL


def test_context_at_uses_only_closed_candles() -> None:
    d1 = zigzag(80, Timeframe.D1, 100, 2)
    w1 = zigzag(20, Timeframe.W1, 100, 2)
    last_open = d1[-1].open_time
    inside_last_day = last_open + timedelta(hours=8)
    ctx_inside = context_at(inside_last_day, d1, w1)
    ctx_after = context_at(last_open + Timeframe.D1.delta, d1, w1)
    assert ctx_inside.d1_close == d1[-2].close  # незакрытый день не учитывается
    assert ctx_after.d1_close == d1[-1].close


def test_params_validation() -> None:
    with pytest.raises(ValueError):
        BiasParams(ema_period=0)
