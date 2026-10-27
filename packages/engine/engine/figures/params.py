"""Параметры поиска графических фигур (план 2A.10.2, шаг 1). Единственное место, где живут числа.

Изменение допусков — новая ``rules_version``; подтверждённые фигуры задним числом не меняются.
Наклоны линий измеряются в ATR на свечу: угол = atan(наклон / ATR) в градусах.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal


@dataclass(frozen=True, slots=True)
class FigureParams:
    rules_version: str = "figures@1.0.0"
    swing_lens: tuple[int, ...] = (2, 3, 5)
    atr_period: int = 14
    volume_window: int = 20
    # двойная вершина / дно
    double_tops_tol_atr: Decimal = Decimal("0.3")
    double_pullback_atr: Decimal = Decimal("1.5")
    # голова и плечи
    hs_head_over_atr: Decimal = Decimal("0.5")
    hs_shoulders_tol_atr: Decimal = Decimal("0.5")
    hs_neck_max_deg: float = 15.0
    # треугольники
    tri_min_len: int = 15
    tri_max_len: int = 80
    tri_min_r2: float = 0.9
    tri_compression: float = 0.4
    tri_confirm_part: float = 0.75
    tri_flat_deg: float = 3.0
    # флаг / вымпел
    pole_min_atr: Decimal = Decimal("2.5")
    pole_max_candles: int = 8
    flag_min_len: int = 5
    flag_max_len: int = 20
    flag_max_range: float = 0.5
    flag_parallel_deg: float = 5.0
    # клинья
    wedge_min_len: int = 20
    wedge_max_len: int = 100
    wedge_min_touches: int = 3
    wedge_compression: float = 0.25
    """Сжатие диапазона, с которого сходящиеся линии — клин/треугольник, а не канал."""
    # каналы
    channel_parallel_deg: float = 5.0
    channel_min_len: int = 15
    channel_max_len: int = 120
    channel_flat_deg: float = 3.0
    # чашка с ручкой
    cup_min_len: int = 30
    cup_max_len: int = 200
    cup_min_r2: float = 0.8
    cup_depth_min_atr: Decimal = Decimal("1.5")
    cup_depth_max_atr: Decimal = Decimal("6")
    handle_min_len: int = 5
    handle_max_len: int = 25
    handle_max_depth: float = 1.0 / 3.0
    # качество и статусы
    touch_tol_atr: float = 0.15
    """Касание линии: расстояние ≤ доля ATR."""
    min_quality: float = 0.4
    forming_quality: float = 0.6
    """«Формируется» показывается при скоре ≥ 0.6 (план 2A.10.4)."""
    outcome_horizon: int = 20
    validity_mult: float = 2.0
    """Фигура без пробоя за validity_mult × длину после конца геометрии считается отменённой."""
    flag_atr_window: int = 20

    @property
    def warmup(self) -> int:
        return max(self.atr_period, self.volume_window) + max(self.swing_lens) * 2


DEFAULT_FIGURE_PARAMS = FigureParams()
