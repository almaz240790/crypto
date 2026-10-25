"""Параметры стратегии. Единственное место, где живут числа.

Все параметры неизменяемы; новая версия стратегии = новый экземпляр с другими значениями.
Соответствие плану: раздел 2 (логика сигналов), `strategy_versions.params` в БД.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal


@dataclass(frozen=True, slots=True)
class StructureParams:
    """Структура рынка (план 2.2–2.3)."""

    swing_len: int = 2
    """Свечей слева и справа от экстремума, чтобы считать его swing-точкой (фрактал)."""

    def __post_init__(self) -> None:
        if self.swing_len < 1:
            raise ValueError("swing_len должен быть >= 1")


@dataclass(frozen=True, slots=True)
class ZoneParams:
    """Зоны интереса (план 2.4)."""

    ob_aggressive: bool = False
    """OB до high/low свечи (True) или до open (False, консервативно)."""
    sd_min_impulse_atr: Decimal = Decimal("1.5")
    """Минимальный импульс после базы в ATR, чтобы база считалась зоной S/D."""
    sd_base_max_candles: int = 3
    sd_body_max_ratio: Decimal = Decimal("0.5")
    """Тело свечи базы меньше этой доли диапазона."""
    atr_period: int = 14

    def __post_init__(self) -> None:
        if self.sd_base_max_candles < 1 or self.atr_period < 1:
            raise ValueError("sd_base_max_candles и atr_period должны быть >= 1")
        if not (0 < self.sd_body_max_ratio <= 1):
            raise ValueError("sd_body_max_ratio в (0; 1]")


@dataclass(frozen=True, slots=True)
class LiquidityParams:
    """Ликвидность (план 2.4)."""

    equal_tolerance_atr: Decimal = Decimal("0.1")
    """Разница между экстремумами меньше этой доли ATR — «равные» максимумы/минимумы."""
    equal_max_gap: int = 60
    """Максимум свечей между соседними swing-ами одного уровня."""
    atr_period: int = 14

    def __post_init__(self) -> None:
        if self.equal_tolerance_atr <= 0 or self.equal_max_gap < 1 or self.atr_period < 1:
            raise ValueError("некорректные параметры LiquidityParams")


@dataclass(frozen=True, slots=True)
class BiasParams:
    """Контекст D1/W1 (план 2.2)."""

    ema_period: int = 50
    slope_lookback: int = 10

    def __post_init__(self) -> None:
        if self.ema_period < 1 or self.slope_lookback < 1:
            raise ValueError("ema_period и slope_lookback должны быть >= 1")
