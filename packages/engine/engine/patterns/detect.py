"""Детекция свечных паттернов по ряду закрытых свечей (план 2A.10.1, 2B.10).

Гарантии:
- На вход — только закрытые свечи (фильтрует вызывающая сторона, ``closed_only``).
- Отметка с индексом ``i`` зависит только от свечей ``[:i+1]`` и объектов структуры,
  известных к закрытию ``i`` (swing-и по ``confirmed_index``, зоны по ``created_index``).
  Поэтому ``detect_patterns`` на префиксе ряда даёт те же отметки — это и есть replay.
"""

from __future__ import annotations

from collections.abc import Sequence
from decimal import Decimal

from engine.candles import Candle
from engine.indicators import atr, ema
from engine.liquidity import Sweep
from engine.patterns import rules
from engine.patterns.context import build_context, is_significant
from engine.patterns.params import DEFAULT_PATTERN_PARAMS, PatternParams
from engine.patterns.rules import Measures
from engine.patterns.types import PatternMatch, PatternType
from engine.structure import Direction, MarketStructure, Trend
from engine.zones import Zone


def _prefix(values: Sequence[Decimal]) -> list[Decimal]:
    out = [Decimal(0)]
    for v in values:
        out.append(out[-1] + v)
    return out


def _mean(prefix: Sequence[Decimal], start: int, end: int) -> Decimal | None:
    """Среднее по полуинтервалу [start, end); None, если окно не помещается."""
    if start < 0 or end <= start:
        return None
    return (prefix[end] - prefix[start]) / (end - start)


def detect_patterns(
    candles: Sequence[Candle],
    params: PatternParams = DEFAULT_PATTERN_PARAMS,
    *,
    structure: MarketStructure | None = None,
    zones: Sequence[Zone] = (),
    levels: Sequence[Decimal] = (),
    sweeps: Sequence[Sweep] = (),
    htf_trend: Trend | None = None,
    since: int = 0,
) -> list[PatternMatch]:
    """Все отметки с индексом последней свечи ≥ ``since`` (и ≥ warmup), по возрастанию индекса."""
    n = len(candles)
    if n == 0:
        return []
    atr_values = atr(candles, params.atr_period)
    ema_values = ema(candles, params.ema_period)
    bodies = _prefix([c.body for c in candles])
    volumes = _prefix([c.volume for c in candles])
    out: list[PatternMatch] = []

    def measures(start: int, index: int) -> Measures | None:
        a = atr_values[index]
        avg = _mean(bodies, start - params.avg_body_window, start)
        if a is None or a <= 0 or avg is None or avg <= 0:
            return None
        return Measures(avg_body=avg, atr=a)

    def add(
        type_: PatternType, direction: Direction | None, start: int, index: int, m: Measures
    ) -> None:
        last = candles[index]
        window = candles[start : index + 1]
        vol_avg = _mean(volumes, start - params.volume_window, start)
        vol_ratio = None if vol_avg is None or vol_avg <= 0 else last.volume / vol_avg
        ctx = build_context(
            candles,
            start,
            index,
            direction,
            type_,
            atr=m.atr,
            volume_ratio=vol_ratio,
            ema=ema_values[index],
            structure=structure,
            zones=zones,
            levels=levels,
            sweeps=sweeps,
            htf_trend=htf_trend,
            params=params,
        )
        if direction is Direction.UP:
            price = min(c.low for c in window)
        elif direction is Direction.DOWN:
            price = max(c.high for c in window)
        else:
            price = last.close
        out.append(
            PatternMatch(
                type=type_,
                direction=direction,
                start_index=start,
                index=index,
                time=last.open_time,
                price=price,
                atr=m.atr,
                rules_version=params.rules_version,
                context=ctx,
                significant=is_significant(type_, direction, ctx, params),
            )
        )

    for i in range(max(params.warmup, since), n):
        c = candles[i]
        # одна свеча
        m1 = measures(i, i)
        if m1 is not None:
            dj = rules.doji(c, m1, params)
            if dj is not None:
                add(dj, None, i, i, m1)
            else:
                pin = rules.pin_bar(c, params)
                if pin is not None:
                    add(PatternType.PIN_BAR, pin, i, i, m1)
            mb = rules.marubozu(c, m1, params)
            if mb is not None:
                add(PatternType.MARUBOZU, mb, i, i, m1)
        # две свечи
        m2 = measures(i - 1, i)
        if m2 is not None:
            c1 = candles[i - 1]
            eg = rules.engulfing(c1, c, m2, params)
            if eg is not None:
                add(PatternType.ENGULFING, eg, i - 1, i, m2)
            if rules.harami(c1, c, m2, params):
                add(PatternType.HARAMI, None, i - 1, i, m2)
            if rules.inside_bar(c1, c):
                add(PatternType.INSIDE_BAR, None, i - 1, i, m2)
            tw = rules.tweezer(c1, c, m2, params)
            if tw is not None:
                add(PatternType.TWEEZER, tw, i - 1, i, m2)
        # три свечи
        m3 = measures(i - 2, i)
        if m3 is not None:
            a, b = candles[i - 2], candles[i - 1]
            st = rules.star(a, b, c, m3, params)
            if st is not None:
                add(PatternType.STAR, st, i - 2, i, m3)
            tl = rules.three_line(a, b, c, m3, params)
            if tl is not None:
                add(PatternType.THREE_LINE, tl, i - 2, i, m3)
            br = rules.inside_bar_breakout(a, b, c)
            if br is not None:
                add(PatternType.INSIDE_BAR_BREAKOUT, br, i - 2, i, m3)
    return out


def detect_last(
    candles: Sequence[Candle],
    params: PatternParams = DEFAULT_PATTERN_PARAMS,
    **kwargs: object,
) -> list[PatternMatch]:
    """Отметки, подтверждённые на закрытии последней свечи ряда (для live-детектора)."""
    if not candles:
        return []
    return detect_patterns(candles, params, since=len(candles) - 1, **kwargs)  # type: ignore[arg-type]
