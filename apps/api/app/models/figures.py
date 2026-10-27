"""Графические фигуры и их отработка (план 2A.10.2, 2A.10.4; задача 4B.6).

Фигура в статусе ``forming`` может обновляться (геометрия растёт), ``confirmed`` и
``invalidated`` — insert-only по геометрии и статусу (триггер БД).
"""

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

PRICE = Numeric(24, 10)
ATR = Numeric(18, 6)


class FigureRow(Base):
    __tablename__ = "figures"
    __table_args__ = (
        UniqueConstraint(
            "instrument_id", "timeframe", "type", "start_time", "end_time", "rules_version"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    instrument_id: Mapped[int] = mapped_column(ForeignKey("instruments.id"), index=True)
    timeframe: Mapped[str] = mapped_column(String(4))
    type: Mapped[str] = mapped_column(String(24))
    direction: Mapped[str | None] = mapped_column(String(4))
    status: Mapped[str] = mapped_column(String(12))
    scale: Mapped[int] = mapped_column(Integer)
    start_time: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    end_time: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    known_time: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    confirm_time: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    invalidated_time: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    geometry: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    """points [[t, price]], lines [{name, a:[t,p], b:[t,p]}], times."""
    breakout_level: Mapped[Decimal | None] = mapped_column(PRICE)
    target: Mapped[Decimal | None] = mapped_column(PRICE)
    invalidation: Mapped[Decimal | None] = mapped_column(PRICE)
    quality: Mapped[Decimal] = mapped_column(Numeric(6, 4))
    metrics: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    rules_version: Mapped[str] = mapped_column(String(32))
    source: Mapped[str] = mapped_column(String(8), default="live")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class FigureEvent(Base):
    __tablename__ = "figure_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    figure_id: Mapped[int] = mapped_column(ForeignKey("figures.id"), index=True)
    type: Mapped[str] = mapped_column(
        String(24)
    )  # detected_forming / confirmed / invalidated / outcome_recorded
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    details: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)


class FigureOutcomeRow(Base):
    __tablename__ = "figure_outcomes"

    figure_id: Mapped[int] = mapped_column(ForeignKey("figures.id"), primary_key=True)
    horizon_bars: Mapped[int] = mapped_column(Integer)
    target_hit: Mapped[bool | None] = mapped_column(Boolean)
    invalidation_hit: Mapped[bool | None] = mapped_column(Boolean)
    move_atr_favorable: Mapped[Decimal | None] = mapped_column(ATR)
    move_atr_adverse: Mapped[Decimal | None] = mapped_column(ATR)
    bars_to_target: Mapped[int | None] = mapped_column(Integer)
    evaluated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class FigureStatsSnapshot(Base):
    __tablename__ = "figure_stats_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    type: Mapped[str] = mapped_column(String(24), index=True)
    timeframe: Mapped[str] = mapped_column(String(4))
    scope: Mapped[str] = mapped_column(String(8))
    year: Mapped[int | None] = mapped_column(Integer)
    n: Mapped[int] = mapped_column(Integer)
    success_rate: Mapped[Decimal | None] = mapped_column(Numeric(6, 4))
    ci_low: Mapped[Decimal | None] = mapped_column(Numeric(6, 4))
    ci_high: Mapped[Decimal | None] = mapped_column(Numeric(6, 4))
    avg_move_atr: Mapped[Decimal | None] = mapped_column(ATR)
    avg_adverse_atr: Mapped[Decimal | None] = mapped_column(ATR)
    avg_bars_to_target: Mapped[Decimal | None] = mapped_column(Numeric(8, 2))
    computed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
