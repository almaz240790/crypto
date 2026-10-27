"""Параметры правил свечных паттернов (план 2A.10.1). Единственное место, где живут числа.

Любое изменение правил — новая ``rules_version``; подтверждённые отметки задним числом не
пересчитываются (план 2A.10.4).
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal


@dataclass(frozen=True, slots=True)
class PatternParams:
    rules_version: str = "candles@1.0.0"
    # нормировка
    avg_body_window: int = 20
    atr_period: int = 14
    volume_window: int = 20
    ema_period: int = 50
    # поглощение
    engulf_body: Decimal = Decimal("1.2")
    # пин-бар / молот / падающая звезда
    pin_tail_body: Decimal = Decimal("2")
    pin_nose_range: Decimal = Decimal("0.3")
    pin_body_range: Decimal = Decimal("0.1")
    pin_close_part: int = 3
    """Закрытие в верхней (нижней) 1/part диапазона."""
    # доджи
    doji_body_range: Decimal = Decimal("0.1")
    doji_range_atr: Decimal = Decimal("0.8")
    doji_tail_range: Decimal = Decimal("0.1")
    """Короткая тень стрекозы/надгробия ≤ доля диапазона."""
    # утренняя / вечерняя звезда
    star_big_body: Decimal = Decimal("1.0")
    star_small_body: Decimal = Decimal("0.3")
    star_volume_ratio: Decimal = Decimal("1")
    # три солдата / три вороны
    three_body: Decimal = Decimal("0.8")
    three_shadow_body: Decimal = Decimal("0.3")
    three_overheat_atr: Decimal = Decimal("3")
    # харами
    harami_body: Decimal = Decimal("1.2")
    # марубозу
    marubozu_shadow_range: Decimal = Decimal("0.1")
    marubozu_body: Decimal = Decimal("1.5")
    # пинцет
    tweezer_tolerance_atr: Decimal = Decimal("0.1")
    # контекст
    run_candles: int = 3
    """«После ≥ N свечей снижения/роста»."""
    volume_ratio: Decimal = Decimal("1.2")
    near_atr: Decimal = Decimal("0.5")
    """«У зоны/уровня» — расстояние в ATR."""
    # отработка (план 2A.10.4)
    outcome_horizons: tuple[int, ...] = (3, 5, 10)
    outcome_move_atr: Decimal = Decimal("1")

    @property
    def warmup(self) -> int:
        """Сколько закрытых свечей нужно до первой возможной отметки."""
        return max(self.avg_body_window, self.atr_period, self.volume_window, self.ema_period) + 3


DEFAULT_PATTERN_PARAMS = PatternParams()
