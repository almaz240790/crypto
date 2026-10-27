"""Отработка подтверждённой фигуры: цель или инвалидация за N свечей (план 2A.10.4)."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from decimal import Decimal

from engine.candles import Candle
from engine.figures.types import Figure, FigureStatus
from engine.structure import Direction


@dataclass(frozen=True, slots=True)
class FigureOutcome:
    horizon: int
    target_hit: bool | None
    """None — рано судить или фигура не подтверждена."""
    invalidation_hit: bool | None
    max_favorable_atr: Decimal | None
    max_adverse_atr: Decimal | None
    bars_to_target: int | None


def figure_outcome(
    candles: Sequence[Candle], fig: Figure, atr_value: Decimal, horizon: int = 20
) -> FigureOutcome:
    """Смотрим свечи после пробоя: дошла ли цена до цели раньше, чем до инвалидации."""
    if fig.status is not FigureStatus.CONFIRMED or fig.confirm_index is None or atr_value <= 0:
        return FigureOutcome(horizon, None, None, None, None, None)
    window = candles[fig.confirm_index + 1 : fig.confirm_index + 1 + horizon]
    if not window:
        return FigureOutcome(horizon, None, None, None, None, None)
    ref = candles[fig.confirm_index].close
    up = fig.direction is Direction.UP
    fav = max(((c.high - ref) if up else (ref - c.low)) for c in window)
    adv = max(((ref - c.low) if up else (c.high - ref)) for c in window)
    target_hit: bool | None = None
    inval_hit: bool | None = None
    bars: int | None = None
    for i, c in enumerate(window, start=1):
        reached = fig.target is not None and (
            (c.high >= fig.target) if up else (c.low <= fig.target)
        )
        broken = fig.invalidation is not None and (
            (c.close < fig.invalidation) if up else (c.close > fig.invalidation)
        )
        if reached:
            target_hit, inval_hit, bars = True, False, i
            break
        if broken:
            target_hit, inval_hit, bars = False, True, i
            break
    if target_hit is None and len(window) >= horizon:
        target_hit, inval_hit = False, False
    return FigureOutcome(horizon, target_hit, inval_hit, fav / atr_value, adv / atr_value, bars)
