"""Контекст паттерна: факты вокруг отметки и правило статуса «значимый» (план 2A.10.1)."""

from __future__ import annotations

from collections.abc import Sequence
from decimal import Decimal

from engine.candles import Candle
from engine.liquidity import Sweep
from engine.patterns.params import PatternParams
from engine.patterns.types import PatternContext, PatternType
from engine.structure import Direction, MarketStructure, SwingKind, Trend, classify_trend
from engine.zones import Zone


def prior_run(candles: Sequence[Candle], start: int) -> int:
    """Сколько свечей подряд закрывались в одну сторону перед ``start``: > 0 рост, < 0 снижение."""
    i = start - 1
    if i < 1:
        return 0
    first = candles[i].close - candles[i - 1].close
    sign = 1 if first > 0 else -1 if first < 0 else 0
    run = 0
    while i >= 1:
        d = candles[i].close - candles[i - 1].close
        if sign == 0 or (sign > 0 and d <= 0) or (sign < 0 and d >= 0):
            break
        run += 1
        i -= 1
    return sign * run


def visible_zones(zones: Sequence[Zone], index: int, direction: Direction | None) -> list[Zone]:
    """Зоны, известные к закрытию свечи ``index`` и ещё не инвалидированные к ней."""
    return [
        z
        for z in zones
        if z.created_index <= index
        and (z.invalidated_index is None or z.invalidated_index > index)
        and (direction is None or z.direction is direction)
    ]


def _distance(price: Decimal, top: Decimal, bottom: Decimal, atr: Decimal) -> Decimal:
    if bottom <= price <= top:
        return Decimal(0)
    return min(abs(price - top), abs(price - bottom)) / atr


def trend_at(structure: MarketStructure | None, index: int) -> Trend | None:
    if structure is None:
        return None
    return classify_trend([s for s in structure.swings if s.confirmed_index <= index])


def build_context(
    candles: Sequence[Candle],
    start: int,
    index: int,
    direction: Direction | None,
    type_: PatternType,
    *,
    atr: Decimal,
    volume_ratio: Decimal | None,
    ema: Decimal | None,
    structure: MarketStructure | None,
    zones: Sequence[Zone],
    levels: Sequence[Decimal],
    sweeps: Sequence[Sweep],
    htf_trend: Trend | None,
    params: PatternParams,
) -> PatternContext:
    window = candles[start : index + 1]
    last = candles[index]
    lo = min(c.low for c in window)
    hi = max(c.high for c in window)
    ref = lo if direction is Direction.UP else hi if direction is Direction.DOWN else last.close
    zs = visible_zones(zones, index, direction)
    zone_d = min((_distance(ref, z.top, z.bottom, atr) for z in zs), default=None)
    level_d = min((abs(ref - lv) / atr for lv in levels), default=None)
    edges = list(levels) + [e for z in visible_zones(zones, index, None) for e in (z.top, z.bottom)]
    if direction is Direction.UP:
        pierced = any(last.low < e < last.close for e in edges)
    elif direction is Direction.DOWN:
        pierced = any(last.close < e < last.high for e in edges)
    else:
        pierced = False
    want: SwingKind | None = None
    if direction is Direction.UP:
        want = SwingKind.LOW
    elif direction is Direction.DOWN:
        want = SwingKind.HIGH
    sweep = any(start <= s.index <= index and (want is None or s.kind is want) for s in sweeps)
    overheat = (
        type_ is PatternType.THREE_LINE
        and sum((c.range for c in window), Decimal(0)) > params.three_overheat_atr * atr
    )
    return PatternContext(
        trend=trend_at(structure, index),
        htf_trend=htf_trend,
        prior_run=prior_run(candles, start),
        volume_ratio=volume_ratio,
        zone_distance_atr=zone_d,
        level_distance_atr=level_d,
        sweep=sweep,
        pierced=pierced,
        above_ema=None if ema is None else last.close > ema,
        overheat=overheat,
    )


def is_significant(
    type_: PatternType, direction: Direction | None, ctx: PatternContext, p: PatternParams
) -> bool:
    """Контекст из таблицы 2A.10.1. Это статус, а не оценка «силы сигнала»."""
    near = (ctx.zone_distance_atr is not None and ctx.zone_distance_atr <= p.near_atr) or (
        ctx.level_distance_atr is not None and ctx.level_distance_atr <= p.near_atr
    )
    vol_ok = ctx.volume_ratio is not None and ctx.volume_ratio >= p.volume_ratio
    against = (direction is Direction.UP and ctx.prior_run <= -p.run_candles) or (
        direction is Direction.DOWN and ctx.prior_run >= p.run_candles
    )
    match type_:
        case PatternType.ENGULFING:
            return (against or near) and vol_ok
        case PatternType.PIN_BAR:
            return ctx.sweep or ctx.pierced or against
        case PatternType.DOJI | PatternType.DOJI_DRAGONFLY | PatternType.DOJI_GRAVESTONE:
            return near
        case PatternType.STAR:
            return (
                against and ctx.volume_ratio is not None and ctx.volume_ratio >= p.star_volume_ratio
            )
        case PatternType.THREE_LINE | PatternType.TWEEZER:
            return near
        case PatternType.INSIDE_BAR_BREAKOUT:
            return vol_ok
        case PatternType.MARUBOZU:
            return ctx.pierced
        case _:
            return False
