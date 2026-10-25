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


@dataclass(frozen=True, slots=True)
class FilterParams:
    """Фильтры (план 2.5) и их вклад в скоринг (план 2.7)."""

    atr_period: int = 14
    atr_window: int = 200
    atr_min_history: int = 50
    atr_low_pct: Decimal = Decimal("0.10")
    atr_high_pct: Decimal = Decimal("0.90")
    atr_top_decile: Decimal = Decimal("0.80")
    atr_top_decile_penalty: int = 10

    volume_avg_window: int = 20
    volume_min_ratio: Decimal = Decimal("1.2")
    volume_strong_ratio: Decimal = Decimal("1.5")
    volume_weak_bonus: int = 5
    volume_strong_bonus: int = 10
    volume_penalty: int = 15

    weekend_volume_ratio: Decimal = Decimal("0.6")
    weekend_penalty: int = 5

    choch_lookback: int = 6

    news_min_importance: int = 3
    news_hours_before: int = 2
    news_hours_after: int = 1
    news_soon_hours: int = 12
    news_soon_penalty: int = 10

    btc_symbol: str = "BTCUSDT"
    correlation_threshold: Decimal = Decimal("0.8")
    correlation_penalty: int = 10
    correlation_risk_multiplier: Decimal = Decimal("0.5")

    min_daily_turnover: Decimal = Decimal(50_000_000)

    funding_contrarian: Decimal = Decimal("0.0001")
    """Funding против сигнала не меньше этого (0.01 %) — бонус."""
    funding_overheat: Decimal = Decimal("0.0005")
    """Funding в сторону сигнала не меньше этого (0.05 %) и выше перцентиля — блок."""
    funding_overheat_pct: Decimal = Decimal("0.95")
    funding_history_days: int = 90
    funding_bonus: int = 10

    oi_confirm_change: Decimal = Decimal("0.05")
    oi_confirm_bonus: int = 5
    oi_squeeze_penalty: int = 5
    oi_accumulation_24h: Decimal = Decimal("0.15")

    liq_cluster_ratio: Decimal = Decimal(3)
    liq_recent_buckets: int = 1
    liq_avg_buckets: int = 30
    liq_bonus: int = 10

    crowd_threshold: Decimal = Decimal("0.65")
    crowd_penalty: int = 5

    unlock_min_pct: Decimal = Decimal("0.01")
    unlock_hours_ahead: int = 72

    def __post_init__(self) -> None:
        if not (0 <= self.atr_low_pct < self.atr_high_pct <= 1):
            raise ValueError("atr_low_pct < atr_high_pct в [0; 1]")
        if self.atr_window < 2 or self.volume_avg_window < 1 or self.choch_lookback < 1:
            raise ValueError("окна должны быть положительными")
