"""Алерты на графике и журнал срабатываний (план 2A.6, раздел 7; задача 2B.13)."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class Alert(Base):
    __tablename__ = "alerts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    instrument_id: Mapped[int | None] = mapped_column(ForeignKey("instruments.id"), index=True)
    """NULL — по вотчлисту пользователя (только для паттернов)."""
    timeframe: Mapped[str | None] = mapped_column(String(4))
    type: Mapped[str] = mapped_column(String(12))  # price / indicator / zone / structure / pattern
    condition: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    frequency: Mapped[str] = mapped_column(
        String(14), default="once"
    )  # once / every / once_per_bar
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(10), default="active")
    drawing_client_id: Mapped[str | None] = mapped_column(String(40))
    note: Mapped[str | None] = mapped_column(String(140))
    last_triggered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    triggers_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AlertTrigger(Base):
    """Срабатывание; уникальность (alert_id, triggered_at) — идемпотентность воркера."""

    __tablename__ = "alert_triggers"
    __table_args__ = (UniqueConstraint("alert_id", "triggered_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    alert_id: Mapped[int] = mapped_column(ForeignKey("alerts.id", ondelete="CASCADE"), index=True)
    triggered_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    price: Mapped[Decimal | None] = mapped_column(Numeric(24, 10))
    details: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    notified: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
