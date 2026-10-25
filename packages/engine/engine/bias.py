"""Контекст старшего таймфрейма: bias по D1 и W1 (план 2.2).

- ``long``: структура D1 вверх И закрытие D1 > EMA50 D1 И W1 не против (вверх или флэт).
- ``short``: зеркально.
- ``neutral``: иначе — сигналы на H4 по инструменту не генерируются.

На вход подаются только закрытые D1/W1-свечи на момент расчёта (``context_at`` делает это
сам через ``closed_only``), поэтому дневной контекст меняется один раз в сутки, на закрытии
D1, и не «подглядывает» в текущий день.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from enum import StrEnum

from engine.candles import Candle, Timeframe, closed_only
from engine.indicators import ema
from engine.params import BiasParams, StructureParams
from engine.structure import Trend, analyze_structure


class Bias(StrEnum):
    LONG = "long"
    SHORT = "short"
    NEUTRAL = "neutral"


@dataclass(frozen=True, slots=True)
class BiasContext:
    bias: Bias
    d1_trend: Trend
    w1_trend: Trend
    d1_close: Decimal | None
    ema: Decimal | None
    ema_slope: Decimal | None
    """EMA[-1] − EMA[-1 − slope_lookback]; знак — наклон, информационно."""
    reasons: tuple[str, ...]
    """Факты для обоснования сигнала (план 3.5), по одному на проверку."""


DEFAULT_PARAMS = BiasParams()
DEFAULT_STRUCTURE = StructureParams()


def compute_bias(
    d1: Sequence[Candle],
    w1: Sequence[Candle],
    params: BiasParams = DEFAULT_PARAMS,
    structure_params: StructureParams = DEFAULT_STRUCTURE,
) -> BiasContext:
    """Bias по уже закрытым D1/W1-свечам."""
    d1_trend = analyze_structure(d1, structure_params).trend
    w1_trend = analyze_structure(w1, structure_params).trend
    ema_values = ema(d1, params.ema_period)
    ema_now = ema_values[-1] if ema_values else None
    d1_close = d1[-1].close if d1 else None
    slope: Decimal | None = None
    if ema_now is not None and len(ema_values) > params.slope_lookback:
        prev = ema_values[-1 - params.slope_lookback]
        slope = ema_now - prev if prev is not None else None

    reasons = [f"D1: структура {d1_trend}", f"W1: структура {w1_trend}"]
    if ema_now is None or d1_close is None:
        reasons.append(f"D1: EMA{params.ema_period} не рассчитана (мало истории)")
        return BiasContext(
            Bias.NEUTRAL, d1_trend, w1_trend, d1_close, ema_now, slope, tuple(reasons)
        )

    above = d1_close > ema_now
    reasons.append(f"D1: закрытие {'выше' if above else 'ниже'} EMA{params.ema_period}")

    w1_ok_long = w1_trend is Trend.UP if params.require_w1_agreement else w1_trend is not Trend.DOWN
    w1_ok_short = (
        w1_trend is Trend.DOWN if params.require_w1_agreement else w1_trend is not Trend.UP
    )
    if d1_trend is Trend.UP and above and w1_ok_long:
        bias = Bias.LONG
    elif d1_trend is Trend.DOWN and not above and w1_ok_short:
        bias = Bias.SHORT
    else:
        bias = Bias.NEUTRAL
    if (bias is Bias.LONG and not params.allow_long) or (
        bias is Bias.SHORT and not params.allow_short
    ):
        reasons.append(f"bias: {bias}, направление отключено версией стратегии")
        bias = Bias.NEUTRAL
    reasons.append(f"bias: {bias}")
    return BiasContext(bias, d1_trend, w1_trend, d1_close, ema_now, slope, tuple(reasons))


def context_at(
    at: datetime,
    d1: Sequence[Candle],
    w1: Sequence[Candle],
    params: BiasParams = DEFAULT_PARAMS,
    structure_params: StructureParams = DEFAULT_STRUCTURE,
) -> BiasContext:
    """Bias на момент ``at`` (обычно — закрытие свечи H4): берутся только закрытые D1/W1."""
    return compute_bias(
        closed_only(d1, Timeframe.D1, at),
        closed_only(w1, Timeframe.W1, at),
        params,
        structure_params,
    )
