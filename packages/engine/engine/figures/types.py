"""Типы графических фигур и результат поиска (план 2A.10.2)."""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from enum import StrEnum

from engine.structure import Direction


class FigureType(StrEnum):
    DOUBLE_TOP = "double_top"
    DOUBLE_BOTTOM = "double_bottom"
    HEAD_SHOULDERS = "head_shoulders"
    INV_HEAD_SHOULDERS = "inv_head_shoulders"
    TRIANGLE_SYM = "triangle_sym"
    TRIANGLE_ASC = "triangle_asc"
    TRIANGLE_DESC = "triangle_desc"
    FLAG = "flag"
    PENNANT = "pennant"
    WEDGE_RISING = "wedge_rising"
    WEDGE_FALLING = "wedge_falling"
    CHANNEL_UP = "channel_up"
    CHANNEL_DOWN = "channel_down"
    RANGE = "range"
    CUP_HANDLE = "cup_handle"


class FigureStatus(StrEnum):
    FORMING = "forming"
    CONFIRMED = "confirmed"
    INVALIDATED = "invalidated"


TITLES: dict[FigureType, str] = {
    FigureType.DOUBLE_TOP: "Двойная вершина",
    FigureType.DOUBLE_BOTTOM: "Двойное дно",
    FigureType.HEAD_SHOULDERS: "Голова и плечи",
    FigureType.INV_HEAD_SHOULDERS: "Перевёрнутые голова и плечи",
    FigureType.TRIANGLE_SYM: "Симметричный треугольник",
    FigureType.TRIANGLE_ASC: "Восходящий треугольник",
    FigureType.TRIANGLE_DESC: "Нисходящий треугольник",
    FigureType.FLAG: "Флаг",
    FigureType.PENNANT: "Вымпел",
    FigureType.WEDGE_RISING: "Восходящий клин",
    FigureType.WEDGE_FALLING: "Нисходящий клин",
    FigureType.CHANNEL_UP: "Восходящий канал",
    FigureType.CHANNEL_DOWN: "Нисходящий канал",
    FigureType.RANGE: "Диапазон",
    FigureType.CUP_HANDLE: "Чашка с ручкой",
}


@dataclass(frozen=True, slots=True)
class Point:
    index: int
    price: Decimal


@dataclass(frozen=True, slots=True)
class Line:
    """Отрезок линии: цена на свече ``a`` и на свече ``b`` (между ними — линейно)."""

    name: str
    a: Point
    b: Point

    def at(self, index: int) -> Decimal:
        if self.b.index == self.a.index:
            return self.a.price
        k = (self.b.price - self.a.price) / (self.b.index - self.a.index)
        return self.a.price + k * (index - self.a.index)


@dataclass(frozen=True, slots=True)
class Figure:
    type: FigureType
    direction: Direction | None
    """Ожидаемое направление после подтверждения (у канала/диапазона — по стороне пробоя)."""
    scale: int
    """swing_len, на котором найдена фигура."""
    points: tuple[Point, ...]
    """Опорные swing-точки в порядке времени."""
    lines: tuple[Line, ...]
    start_index: int
    end_index: int
    """Последняя свеча геометрии (без учёта пробоя)."""
    known_index: int
    """Свеча, на закрытии которой кандидат стал известен (все swing-и подтверждены)."""
    status: FigureStatus
    confirm_index: int | None
    """Свеча пробоя (закрытие за линией)."""
    invalidated_index: int | None
    breakout_level: Decimal | None
    """Цена линии в свече пробоя (или уровень, за которым ждём закрытие)."""
    target: Decimal | None
    invalidation: Decimal | None
    quality: float
    rules_version: str
    metrics: dict[str, float] = field(default_factory=dict)

    @property
    def title(self) -> str:
        return TITLES[self.type]

    @property
    def key(self) -> tuple[FigureType, int, int]:
        return (self.type, self.points[0].index, self.points[-1].index)
