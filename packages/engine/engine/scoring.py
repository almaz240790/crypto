"""Скоринг уверенности 0–100 и градация A/B/C (план 2.7).

Компоненты считаются по фактам, собранным при сборке сигнала; вклад фильтров (бонусы
и штрафы из раздела 2.5) приходит готовым числом ``filter_delta``. Сумма ограничивается
диапазоном 0–100. Веса — параметры стратегии (``ScoringParams``).
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from enum import StrEnum

from engine.params import ScoringParams
from engine.structure import Trend
from engine.zones import ZoneKind


class Grade(StrEnum):
    A = "A"
    B = "B"
    C = "C"
    NONE = "-"
    """Ниже порога публикации: сигнал сохраняется для анализа, но не показывается."""


@dataclass(frozen=True, slots=True)
class ScoreInput:
    w1_trend: Trend
    signal_up: bool
    bos_strength_atr: Decimal
    """На сколько ATR закрытие свечи BOS вышло за пробитый уровень."""
    zone_kinds: frozenset[ZoneKind]
    """Типы зон, совпавших с зоной входа (OB / SD / FVG)."""
    sweep_before_entry: bool
    volume_ratio: Decimal | None
    """Объём свечи BOS к среднему; None — нет данных."""
    rr_tp2: Decimal
    obstacle_before_tp1: bool
    filter_delta: int
    """Суммарный вклад фильтров (деривативы, новости, корреляция, ATR, выходные)."""


@dataclass(frozen=True, slots=True)
class ScoreBreakdown:
    components: dict[str, int]
    total: int
    grade: Grade

    @property
    def publishable(self) -> bool:
        return self.grade is not Grade.NONE


DEFAULT_PARAMS = ScoringParams()


def _tier(value: Decimal, tiers: tuple[tuple[Decimal, int], ...]) -> int:
    """Первый порог (по убыванию), который value достигает, иначе 0."""
    for threshold, points in tiers:
        if value >= threshold:
            return points
    return 0


def grade_for(total: int, params: ScoringParams = DEFAULT_PARAMS) -> Grade:
    if total >= params.grade_a:
        return Grade.A
    if total >= params.grade_b:
        return Grade.B
    if total >= params.grade_c:
        return Grade.C
    return Grade.NONE


def score_signal(inp: ScoreInput, params: ScoringParams = DEFAULT_PARAMS) -> ScoreBreakdown:
    c: dict[str, int] = {}
    same_w1 = (inp.w1_trend is Trend.UP) if inp.signal_up else (inp.w1_trend is Trend.DOWN)
    c["w1_agreement"] = (
        params.w1_same if same_w1 else params.w1_flat if inp.w1_trend is Trend.FLAT else 0
    )
    c["bos_strength"] = _tier(inp.bos_strength_atr, params.bos_tiers)
    n_kinds = len(inp.zone_kinds)
    c["zone_quality"] = (
        params.zone_three
        if n_kinds >= 3
        else params.zone_two
        if n_kinds == 2
        else params.zone_one
        if n_kinds == 1
        else 0
    )
    c["sweep"] = params.sweep_points if inp.sweep_before_entry else 0
    c["volume"] = (
        _tier(inp.volume_ratio, params.volume_tiers) if inp.volume_ratio is not None else 0
    )
    c["rr"] = _tier(inp.rr_tp2, params.rr_tiers)
    c["no_obstacles"] = 0 if inp.obstacle_before_tp1 else params.no_obstacle_points
    c["filters"] = max(params.filters_min, min(params.filters_max, inp.filter_delta))
    total = max(0, min(100, sum(c.values())))
    return ScoreBreakdown(c, total, grade_for(total, params))
