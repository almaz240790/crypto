"""Структура рынка: swing-точки, BOS, CHoCH, тренд (план 2.2–2.3).

Алгоритм идёт по свечам слева направо и на каждой свече использует только её саму и
предыдущие. Swing-точка на свече ``j`` подтверждается с задержкой ``swing_len`` свечей
(на свече ``j + swing_len``) — это честная задержка фрактала, см. план 2.8.
Поэтому результат на префиксе ряда совпадает с префиксом результата на полном ряде
(тест на утечку будущего).

Определения:
- swing high — ``high[j]`` строго больше high на ``swing_len`` свечах слева и справа;
  swing low — зеркально. Равенство не считается экстремумом.
- Уровень для пробоя — последняя подтверждённая swing-точка соответствующего типа.
  Каждый уровень пробивается не больше одного раза.
- Закрытие выше последнего swing high: если структура направлена вниз — CHoCH вверх,
  иначе — BOS вверх. Закрытие ниже последнего swing low — зеркально.
- Тренд по последовательности экстремумов: HH и HL — вверх, LH и LL — вниз, иначе флэт.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from enum import StrEnum

from engine.candles import Candle
from engine.params import StructureParams


class SwingKind(StrEnum):
    HIGH = "high"
    LOW = "low"


class Direction(StrEnum):
    UP = "up"
    DOWN = "down"


class EventType(StrEnum):
    BOS = "bos"
    CHOCH = "choch"


class Trend(StrEnum):
    UP = "up"
    DOWN = "down"
    FLAT = "flat"


@dataclass(frozen=True, slots=True)
class Swing:
    index: int
    """Индекс свечи-экстремума в исходном ряду."""
    time: datetime
    price: Decimal
    kind: SwingKind
    confirmed_index: int
    """Индекс свечи, на закрытии которой swing стал известен (= index + swing_len)."""


@dataclass(frozen=True, slots=True)
class StructureEvent:
    index: int
    """Свеча, закрытие которой пробило уровень."""
    time: datetime
    type: EventType
    direction: Direction
    level: Decimal
    """Цена пробитого swing-уровня."""
    broken_swing: Swing
    origin_swing: Swing | None
    """Противоположный swing, от которого шёл импульс (начало импульсной ноги)."""


@dataclass(slots=True)
class MarketStructure:
    swings: list[Swing] = field(default_factory=list)
    events: list[StructureEvent] = field(default_factory=list)
    direction: Direction | None = None
    """Текущее направление структуры по последнему BOS/CHoCH."""
    last_swing_high: Swing | None = None
    last_swing_low: Swing | None = None

    @property
    def last_event(self) -> StructureEvent | None:
        return self.events[-1] if self.events else None

    @property
    def last_bos(self) -> StructureEvent | None:
        return next((e for e in reversed(self.events) if e.type is EventType.BOS), None)

    @property
    def last_choch(self) -> StructureEvent | None:
        return next((e for e in reversed(self.events) if e.type is EventType.CHOCH), None)

    @property
    def trend(self) -> Trend:
        """HH+HL → вверх, LH+LL → вниз, иначе флэт (план 2.2)."""
        return classify_trend(self.swings)


def classify_trend(swings: Sequence[Swing]) -> Trend:
    highs = [s for s in swings if s.kind is SwingKind.HIGH][-2:]
    lows = [s for s in swings if s.kind is SwingKind.LOW][-2:]
    if len(highs) < 2 or len(lows) < 2:
        return Trend.FLAT
    hh = highs[1].price > highs[0].price
    hl = lows[1].price > lows[0].price
    lh = highs[1].price < highs[0].price
    ll = lows[1].price < lows[0].price
    if hh and hl:
        return Trend.UP
    if lh and ll:
        return Trend.DOWN
    return Trend.FLAT


def _is_swing(candles: Sequence[Candle], j: int, length: int, kind: SwingKind) -> bool:
    c = candles[j]
    window = candles[j - length : j] if j - length >= 0 else None
    if window is None or len(window) < length:
        return False
    right = candles[j + 1 : j + 1 + length]
    if len(right) < length:
        return False
    if kind is SwingKind.HIGH:
        return all(c.high > x.high for x in window) and all(c.high > x.high for x in right)
    return all(c.low < x.low for x in window) and all(c.low < x.low for x in right)


def analyze_structure(
    candles: Sequence[Candle], params: StructureParams = StructureParams()
) -> MarketStructure:
    """Полный проход по закрытым свечам. Вход — результат ``closed_only``."""
    length = params.swing_len
    state = MarketStructure()
    high_broken = False
    low_broken = False

    for i, c in enumerate(candles):
        # 1. Подтверждение swing-точек, которые стали известны на этой свече.
        j = i - length
        if j >= length:
            for kind in (SwingKind.HIGH, SwingKind.LOW):
                if _is_swing(candles, j, length, kind):
                    price = candles[j].high if kind is SwingKind.HIGH else candles[j].low
                    swing = Swing(j, candles[j].open_time, price, kind, confirmed_index=i)
                    state.swings.append(swing)
                    if kind is SwingKind.HIGH:
                        state.last_swing_high, high_broken = swing, False
                    else:
                        state.last_swing_low, low_broken = swing, False

        # 2. Пробой уровней закрытием текущей свечи.
        sh, sl = state.last_swing_high, state.last_swing_low
        if sh is not None and not high_broken and c.close > sh.price:
            etype = EventType.CHOCH if state.direction is Direction.DOWN else EventType.BOS
            state.events.append(
                StructureEvent(i, c.open_time, etype, Direction.UP, sh.price, sh, sl)
            )
            state.direction = Direction.UP
            high_broken = True
        elif sl is not None and not low_broken and c.close < sl.price:
            etype = EventType.CHOCH if state.direction is Direction.UP else EventType.BOS
            state.events.append(
                StructureEvent(i, c.open_time, etype, Direction.DOWN, sl.price, sl, sh)
            )
            state.direction = Direction.DOWN
            low_broken = True

    return state
