"""Модели БД. Соответствуют разделу 7 плана; на этапе 0 — только движок и сигналы."""

from app.models.backtests import BacktestRun
from app.models.billing import BalanceEntry, Payment, PromoCode, Subscription
from app.models.derivatives import (
    FundingRateRow,
    LiquidationRow,
    LongShortRatioRow,
    OpenInterestRow,
)
from app.models.market import Candle, Instrument
from app.models.signals import Signal, SignalEvent, SignalResult, Strategy, StrategyVersion
from app.models.stats import StatsSnapshot
from app.models.support import SupportTicket
from app.models.tracking import SignalTracking
from app.models.users import (
    AdminAudit,
    AuthIdentity,
    EmailToken,
    Incident,
    JournalEntry,
    NotificationLog,
    NotificationSettings,
    PushSubscription,
    RefreshToken,
    RiskProfile,
    StatusChangeRequest,
    User,
    Watchlist,
    WatchlistItem,
)

__all__ = [
    "AdminAudit",
    "AuthIdentity",
    "BacktestRun",
    "BalanceEntry",
    "Candle",
    "EmailToken",
    "FundingRateRow",
    "Incident",
    "Instrument",
    "JournalEntry",
    "LiquidationRow",
    "LongShortRatioRow",
    "NotificationLog",
    "NotificationSettings",
    "OpenInterestRow",
    "Payment",
    "PromoCode",
    "PushSubscription",
    "RefreshToken",
    "RiskProfile",
    "Signal",
    "SignalEvent",
    "SignalResult",
    "SignalTracking",
    "StatsSnapshot",
    "StatusChangeRequest",
    "Strategy",
    "StrategyVersion",
    "Subscription",
    "SupportTicket",
    "User",
    "Watchlist",
    "WatchlistItem",
]
