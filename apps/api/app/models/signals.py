from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.market import PRICE

STRATEGY_STATUSES = ("backtest", "forward", "live", "archived")
SIGNAL_STATUSES = (
    "pending",
    "active",
    "tp1_hit",
    "tp2_hit",
    "closed_tp3",
    "closed_be",
    "closed_sl",
    "closed_time",
    "expired",
    "cancelled",
)
SIGNAL_EVENT_TYPES = (
    "created",
    "activated",
    "tp1",
    "tp2",
    "tp3",
    "be",
    "sl",
    "time_stop",
    "expired",
    "cancelled",
)


class Strategy(Base):
    __tablename__ = "strategies"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    slug: Mapped[str] = mapped_column(String(64), unique=True)
    name: Mapped[str] = mapped_column(String(128))
    description_public: Mapped[str] = mapped_column(Text, default="")


class StrategyVersion(Base):
    """Параметры неизменяемы после создания (триггер в миграции)."""

    __tablename__ = "strategy_versions"
    __table_args__ = (UniqueConstraint("strategy_id", "version"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    strategy_id: Mapped[int] = mapped_column(ForeignKey("strategies.id"))
    version: Mapped[str] = mapped_column(String(32))  # semver: 1.0.0
    params: Mapped[dict[str, Any]] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(String(16), default="backtest")
    created_by: Mapped[str | None] = mapped_column(String(64))
    approved_by: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    activated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    changelog: Mapped[str] = mapped_column(Text, default="")


class Signal(Base):
    """Торговые поля insert-only: UPDATE entry/sl/tp/score/grade запрещён триггером."""

    __tablename__ = "signals"
    __table_args__ = (
        UniqueConstraint("strategy_version_id", "instrument_id", "candle_close_time"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    public_id: Mapped[str] = mapped_column(String(16), unique=True)
    strategy_version_id: Mapped[int] = mapped_column(ForeignKey("strategy_versions.id"))
    instrument_id: Mapped[int] = mapped_column(ForeignKey("instruments.id"))
    direction: Mapped[str] = mapped_column(String(5))  # long / short
    candle_close_time: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    entry_market: Mapped[Decimal] = mapped_column(PRICE)
    entry_limit: Mapped[Decimal | None] = mapped_column(PRICE)
    stop_loss: Mapped[Decimal] = mapped_column(PRICE)
    tp1: Mapped[Decimal] = mapped_column(PRICE)
    tp2: Mapped[Decimal] = mapped_column(PRICE)
    tp3: Mapped[Decimal] = mapped_column(PRICE)
    rr_tp2: Mapped[Decimal] = mapped_column(Numeric(8, 3))
    score: Mapped[int] = mapped_column(Integer)
    grade: Mapped[str] = mapped_column(String(1))  # A / B / C
    score_breakdown: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    rationale_facts: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    status: Mapped[str] = mapped_column(String(16), default="pending")
    input_hash: Mapped[str] = mapped_column(String(64))
    correlated_signal_id: Mapped[int | None] = mapped_column(ForeignKey("signals.id"))
    news_flag: Mapped[str | None] = mapped_column(String(64))
    session_label: Mapped[str | None] = mapped_column(String(16))


class SignalEvent(Base):
    __tablename__ = "signal_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    signal_id: Mapped[int] = mapped_column(ForeignKey("signals.id"), index=True)
    type: Mapped[str] = mapped_column(String(16))
    price: Mapped[Decimal | None] = mapped_column(PRICE)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    source: Mapped[str] = mapped_column(String(16), default="tracker")  # tracker / admin / engine
    note: Mapped[str | None] = mapped_column(Text)


class SignalResult(Base):
    __tablename__ = "signal_results"

    signal_id: Mapped[int] = mapped_column(ForeignKey("signals.id"), primary_key=True)
    realized_r: Mapped[Decimal] = mapped_column(Numeric(8, 3))
    realized_r_tp1_only: Mapped[Decimal | None] = mapped_column(Numeric(8, 3))
    realized_r_full_tp2: Mapped[Decimal | None] = mapped_column(Numeric(8, 3))
    duration_hours: Mapped[Decimal | None] = mapped_column(Numeric(10, 2))
    max_favorable_r: Mapped[Decimal | None] = mapped_column(Numeric(8, 3))
    max_adverse_r: Mapped[Decimal | None] = mapped_column(Numeric(8, 3))
    closed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    entry_type_used: Mapped[str] = mapped_column(String(8), default="market")  # market / limit
