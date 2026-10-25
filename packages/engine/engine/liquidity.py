"""Ликвидность: равные максимумы/минимумы, снятие ликвидности (sweep), уровни PDH/PDL/PWH/PWL
(план 2.4, блок «Ликвидность»).

Как и структура, всё считается слева направо по закрытым свечам: равный уровень известен
с момента подтверждения второго swing-а, sweep — на закрытии свечи, которая его сделала.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from engine.candles import Candle, Timeframe
from engine.indicators import atr
from engine.params import LiquidityParams
from engine.structure import Swing, SwingKind


@dataclass(frozen=True, slots=True)
class EqualLevel:
    """Два и более swing-а одного типа на близких ценах — скопление стопов."""

    kind: SwingKind
    price: Decimal
    """Среднее по участвующим swing-ам."""
    swing_indices: tuple[int, ...]
    confirmed_index: int
    swept_index: int | None = None
    """Свеча, хвост которой вышел за уровень (high > price для максимумов)."""


@dataclass(frozen=True, slots=True)
class Sweep:
    """Прокол swing-уровня хвостом с закрытием обратно: ликвидность снята, пробоя нет."""

    index: int
    time: datetime
    kind: SwingKind
    """LOW — снят минимум (бычий сигнал), HIGH — снят максимум."""
    level: Decimal
    extreme: Decimal
    """Насколько далеко зашёл хвост (low свечи для LOW)."""
    swing_index: int


@dataclass(frozen=True, slots=True)
class PeriodLevels:
    pdh: Decimal | None = None
    pdl: Decimal | None = None
    pwh: Decimal | None = None
    pwl: Decimal | None = None


def find_equal_levels(
    swings: Sequence[Swing],
    candles: Sequence[Candle],
    params: LiquidityParams,
    atr_values: Sequence[Decimal | None] | None = None,
) -> list[EqualLevel]:
    """Соседние swing-и одного типа с разницей < ``equal_tolerance_atr`` × ATR.

    Цепочка из трёх и более близких экстремумов даёт один уровень. Статус ``swept``
    выставляется по свечам после подтверждения уровня.
    """
    atr_values = atr_values if atr_values is not None else atr(candles, params.atr_period)
    levels: list[EqualLevel] = []
    for kind in (SwingKind.HIGH, SwingKind.LOW):
        same = [s for s in swings if s.kind is kind]
        chain: list[Swing] = []
        for s in same:
            a = atr_values[s.index]
            if (
                chain
                and a is not None
                and s.index - chain[-1].index <= params.equal_max_gap
                and abs(s.price - chain[-1].price) < params.equal_tolerance_atr * a
            ):
                chain.append(s)
                continue
            if len(chain) >= 2:
                levels.append(_level(chain))
            chain = [s]
        if len(chain) >= 2:
            levels.append(_level(chain))
    levels.sort(key=lambda lv: lv.confirmed_index)
    return [_sweep_status(lv, candles) for lv in levels]


def _level(chain: Sequence[Swing]) -> EqualLevel:
    price = sum((s.price for s in chain), Decimal(0)) / len(chain)
    return EqualLevel(
        kind=chain[0].kind,
        price=price,
        swing_indices=tuple(s.index for s in chain),
        confirmed_index=max(s.confirmed_index for s in chain),
    )


def _sweep_status(level: EqualLevel, candles: Sequence[Candle]) -> EqualLevel:
    for i in range(level.confirmed_index + 1, len(candles)):
        c = candles[i]
        if level.kind is SwingKind.HIGH and c.high > level.price:
            return replace(level, swept_index=i)
        if level.kind is SwingKind.LOW and c.low < level.price:
            return replace(level, swept_index=i)
    return level


def find_sweeps(candles: Sequence[Candle], swings: Sequence[Swing]) -> list[Sweep]:
    """Свеча проколола последний известный swing-уровень хвостом и закрылась обратно.

    Уровень — последний подтверждённый swing нужного типа на момент свечи ``i``
    (``confirmed_index <= i``). Каждый swing снимается не больше одного раза; после
    закрытия за уровнем (настоящий пробой) он больше не рассматривается.
    """
    out: list[Sweep] = []
    for kind in (SwingKind.LOW, SwingKind.HIGH):
        same = sorted((s for s in swings if s.kind is kind), key=lambda s: s.confirmed_index)
        pos = 0
        current: Swing | None = None
        done = False
        for i, c in enumerate(candles):
            while pos < len(same) and same[pos].confirmed_index <= i:
                current, done = same[pos], False
                pos += 1
            if current is None or done or i <= current.index:
                continue
            if kind is SwingKind.LOW:
                if c.close < current.price:
                    done = True
                elif c.low < current.price:
                    out.append(Sweep(i, c.open_time, kind, current.price, c.low, current.index))
                    done = True
            else:
                if c.close > current.price:
                    done = True
                elif c.high > current.price:
                    out.append(Sweep(i, c.open_time, kind, current.price, c.high, current.index))
                    done = True
    out.sort(key=lambda s: s.index)
    return out


def _period_start(at: datetime, tf: Timeframe) -> datetime:
    at = at.astimezone(UTC)
    day = at.replace(hour=0, minute=0, second=0, microsecond=0)
    if tf is Timeframe.D1:
        return day
    return day - timedelta(days=day.weekday())  # понедельник 00:00 UTC, как у Binance


def period_levels(
    at: datetime, d1: Sequence[Candle] = (), w1: Sequence[Candle] = ()
) -> PeriodLevels:
    """PDH/PDL и PWH/PWL — экстремумы предыдущего завершённого дня и недели на момент ``at``.

    «Предыдущий» — последний период, закрывшийся не позже начала текущего периода.
    Свечи D1/W1 должны быть закрытыми (``closed_only``).
    """
    levels = PeriodLevels()
    day_start = _period_start(at, Timeframe.D1)
    prev_day = next((c for c in reversed(d1) if c.close_time(Timeframe.D1) <= day_start), None)
    if prev_day is not None:
        levels = replace(levels, pdh=prev_day.high, pdl=prev_day.low)
    week_start = _period_start(at, Timeframe.W1)
    prev_week = next((c for c in reversed(w1) if c.close_time(Timeframe.W1) <= week_start), None)
    if prev_week is not None:
        levels = replace(levels, pwh=prev_week.high, pwl=prev_week.low)
    return levels
