"""Модели БД. Соответствуют разделу 7 плана; на этапе 0 — только движок и сигналы."""

from app.models.backtests import BacktestRun
from app.models.derivatives import (
    FundingRateRow,
    LiquidationRow,
    LongShortRatioRow,
    OpenInterestRow,
)
from app.models.market import Candle, Instrument
from app.models.signals import Signal, SignalEvent, SignalResult, Strategy, StrategyVersion
from app.models.tracking import SignalTracking
from app.models.users import (
    AuthIdentity,
    EmailToken,
    JournalEntry,
    NotificationLog,
    NotificationSettings,
    RefreshToken,
    RiskProfile,
    User,
    Watchlist,
    WatchlistItem,
)

__all__ = [
    "AuthIdentity",
    "BacktestRun",
    "Candle",
    "EmailToken",
    "FundingRateRow",
    "Instrument",
    "JournalEntry",
    "LiquidationRow",
    "LongShortRatioRow",
    "NotificationLog",
    "NotificationSettings",
    "OpenInterestRow",
    "RefreshToken",
    "RiskProfile",
    "Signal",
    "SignalEvent",
    "SignalResult",
    "SignalTracking",
    "Strategy",
    "StrategyVersion",
    "User",
    "Watchlist",
    "WatchlistItem",
]
