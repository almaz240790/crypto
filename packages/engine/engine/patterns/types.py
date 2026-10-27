"""Типы свечных паттернов и результат детекции (план 2A.10.1)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from enum import StrEnum

from engine.structure import Direction, Trend


class PatternType(StrEnum):
    ENGULFING = "engulfing"
    PIN_BAR = "pin_bar"
    """Молот (UP) / падающая звезда, повешенный (DOWN)."""
    DOJI = "doji"
    DOJI_DRAGONFLY = "doji_dragonfly"
    DOJI_GRAVESTONE = "doji_gravestone"
    STAR = "star"
    """Утренняя (UP) / вечерняя (DOWN) звезда."""
    THREE_LINE = "three_line"
    """Три белых солдата (UP) / три чёрные вороны (DOWN)."""
    HARAMI = "harami"
    INSIDE_BAR = "inside_bar"
    INSIDE_BAR_BREAKOUT = "inside_bar_breakout"
    MARUBOZU = "marubozu"
    TWEEZER = "tweezer"
    """Пинцет: дно (UP) / вершина (DOWN)."""


_TITLES: dict[tuple[PatternType, Direction | None], str] = {
    (PatternType.ENGULFING, Direction.UP): "Бычье поглощение",
    (PatternType.ENGULFING, Direction.DOWN): "Медвежье поглощение",
    (PatternType.PIN_BAR, Direction.UP): "Молот (пин-бар)",
    (PatternType.PIN_BAR, Direction.DOWN): "Падающая звезда (пин-бар)",
    (PatternType.DOJI, None): "Доджи",
    (PatternType.DOJI_DRAGONFLY, None): "Доджи-стрекоза",
    (PatternType.DOJI_GRAVESTONE, None): "Доджи-надгробие",
    (PatternType.STAR, Direction.UP): "Утренняя звезда",
    (PatternType.STAR, Direction.DOWN): "Вечерняя звезда",
    (PatternType.THREE_LINE, Direction.UP): "Три белых солдата",
    (PatternType.THREE_LINE, Direction.DOWN): "Три чёрные вороны",
    (PatternType.HARAMI, None): "Харами",
    (PatternType.INSIDE_BAR, None): "Внутренний бар",
    (PatternType.INSIDE_BAR_BREAKOUT, Direction.UP): "Пробой внутреннего бара вверх",
    (PatternType.INSIDE_BAR_BREAKOUT, Direction.DOWN): "Пробой внутреннего бара вниз",
    (PatternType.MARUBOZU, Direction.UP): "Бычья марубозу",
    (PatternType.MARUBOZU, Direction.DOWN): "Медвежья марубозу",
    (PatternType.TWEEZER, Direction.UP): "Пинцет-дно",
    (PatternType.TWEEZER, Direction.DOWN): "Пинцет-вершина",
}


def title(type_: PatternType, direction: Direction | None) -> str:
    """Русское название без оценочных слов (план 2A.10.6)."""
    return _TITLES.get((type_, direction), type_.value)


@dataclass(frozen=True, slots=True)
class PatternContext:
    """Факты вокруг паттерна. Ничего из этого не является оценкой «силы сигнала»."""

    trend: Trend | None
    """Тренд структуры на этом таймфрейме по swing-ам, известным к закрытию паттерна."""
    htf_trend: Trend | None
    prior_run: int
    """Число подряд идущих свечей движения перед паттерном: > 0 рост, < 0 снижение."""
    volume_ratio: Decimal | None
    """Объём ключевой свечи к среднему за окно."""
    zone_distance_atr: Decimal | None
    """До ближайшей активной зоны своего направления, в ATR; 0 — внутри."""
    level_distance_atr: Decimal | None
    sweep: bool
    """Внутри паттерна снята ликвидность (sweep swing-уровня) в нужную сторону."""
    pierced: bool
    """Хвост проткнул уровень/границу зоны и свеча закрылась обратно."""
    above_ema: bool | None
    overheat: bool
    """Суммарный диапазон > N ATR (три солдата / вороны)."""


@dataclass(frozen=True, slots=True)
class PatternMatch:
    type: PatternType
    direction: Direction | None
    """UP — бычий, DOWN — медвежий, None — без направления (пауза / нерешительность)."""
    start_index: int
    index: int
    """Последняя свеча паттерна; отметка подтверждена на её закрытии."""
    time: datetime
    """``open_time`` последней свечи."""
    price: Decimal
    """Опорная цена отметки: минимум для бычьих, максимум для медвежьих, close для нейтральных."""
    rules_version: str
    context: PatternContext
    significant: bool
    """Контекст подтверждает паттерн (статус «значимый»), иначе — «найден»."""

    @property
    def title(self) -> str:
        return title(self.type, self.direction)
