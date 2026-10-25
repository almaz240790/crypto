"""Сигнальный движок Platform.

Правила (CLAUDE.md): только закрытые свечи, Decimal на входе и выходе, UTC, без сети и БД.
"""

from engine.candles import Candle, Timeframe, closed_only, ensure_continuous

__all__ = ["Candle", "Timeframe", "closed_only", "ensure_continuous"]
