"""Отработка паттерна через N свечей (план 2A.10.4): факт хода на ≥ k ATR в ожидаемую сторону."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from decimal import Decimal

from engine.candles import Candle
from engine.patterns.params import DEFAULT_PATTERN_PARAMS, PatternParams
from engine.patterns.types import PatternMatch
from engine.structure import Direction


@dataclass(frozen=True, slots=True)
class PatternOutcome:
    horizon: int
    hit: bool | None
    """None — рано судить (не хватает свечей) или паттерн без направления."""
    max_favorable_atr: Decimal | None
    max_adverse_atr: Decimal | None
    """Для паттернов без направления: favorable — ход вверх, adverse — вниз."""


def outcome_from(
    ref: Decimal,
    direction: Direction | None,
    after: Sequence[Candle],
    horizon: int,
    atr_value: Decimal,
    params: PatternParams = DEFAULT_PATTERN_PARAMS,
) -> PatternOutcome:
    """Отработка по свечам ``after`` (первые ``horizon`` штук после паттерна) от цены ``ref``."""
    window = after[:horizon]
    if len(window) < horizon or atr_value <= 0:
        return PatternOutcome(horizon, None, None, None)
    up = (max(c.high for c in window) - ref) / atr_value
    down = (ref - min(c.low for c in window)) / atr_value
    if direction is Direction.UP:
        fav, adv = up, down
    elif direction is Direction.DOWN:
        fav, adv = down, up
    else:
        return PatternOutcome(horizon, None, up, down)
    return PatternOutcome(horizon, fav >= params.outcome_move_atr, fav, adv)


def outcome(
    candles: Sequence[Candle],
    match: PatternMatch,
    horizon: int,
    atr_value: Decimal,
    params: PatternParams = DEFAULT_PATTERN_PARAMS,
) -> PatternOutcome:
    """Считается по свечам ``index+1 .. index+horizon`` относительно close свечи паттерна."""
    after = candles[match.index + 1 : match.index + 1 + horizon]
    return outcome_from(
        candles[match.index].close, match.direction, after, horizon, atr_value, params
    )


def outcomes(
    candles: Sequence[Candle],
    match: PatternMatch,
    atr_value: Decimal,
    params: PatternParams = DEFAULT_PATTERN_PARAMS,
) -> list[PatternOutcome]:
    return [outcome(candles, match, h, atr_value, params) for h in params.outcome_horizons]
