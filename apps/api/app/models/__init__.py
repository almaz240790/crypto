"""Модели БД. Соответствуют разделу 7 плана; на этапе 0 — только движок и сигналы."""

from app.models.alerts import Alert, AlertTrigger
from app.models.backtests import BacktestRun
from app.models.billing import BalanceEntry, Payment, PromoCode, Subscription
from app.models.chart import ChartLayout, Drawing
from app.models.derivatives import (
    FundingRateRow,
    LiquidationRow,
    LongShortRatioRow,
    OpenInterestRow,
)
from app.models.figures import FigureEvent, FigureOutcomeRow, FigureRow, FigureStatsSnapshot
from app.models.llm import LlmRequest
from app.models.market import Candle, Instrument
from app.models.ml import MlLabel
from app.models.patterns import (
    Pattern,
    PatternEvent,
    PatternOutcome,
    PatternRulesVersion,
    PatternStatsSnapshot,
)
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
    "Alert",
    "AlertTrigger",
    "AuthIdentity",
    "BacktestRun",
    "BalanceEntry",
    "Candle",
    "ChartLayout",
    "Drawing",
    "EmailToken",
    "FigureEvent",
    "FigureOutcomeRow",
    "FigureRow",
    "FigureStatsSnapshot",
    "FundingRateRow",
    "Incident",
    "Instrument",
    "JournalEntry",
    "LiquidationRow",
    "LlmRequest",
    "LongShortRatioRow",
    "MlLabel",
    "NotificationLog",
    "NotificationSettings",
    "OpenInterestRow",
    "Pattern",
    "PatternEvent",
    "PatternOutcome",
    "PatternRulesVersion",
    "PatternStatsSnapshot",
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
