"""Параметры стратегии. Единственное место, где живут числа.

Все параметры неизменяемы; новая версия стратегии = новый экземпляр с другими значениями.
Соответствие плану: раздел 2 (логика сигналов), `strategy_versions.params` в БД.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class StructureParams:
    """Структура рынка (план 2.2–2.3)."""

    swing_len: int = 2
    """Свечей слева и справа от экстремума, чтобы считать его swing-точкой (фрактал)."""

    def __post_init__(self) -> None:
        if self.swing_len < 1:
            raise ValueError("swing_len должен быть >= 1")
