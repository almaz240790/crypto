"""Свечные паттерны и их отработка (план 2A.10, раздел 7; задача 2B.11).

``patterns`` в статусе ``confirmed`` — insert-only по геометрии и времени подтверждения
(триггер БД); меняется только ``status``, изменения фиксируются в ``pattern_events``.
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

ATR = Numeric(18, 6)


class PatternRulesVersion(Base):
    __tablename__ = "pattern_rules_versions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    version: Mapped[str] = mapped_column(String(32), unique=True)
    rules: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    changelog: Mapped[str | None] = mapped_column(String(500))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))


class Pattern(Base):
    __tablename__ = "patterns"
    __table_args__ = (
        UniqueConstraint(
            "instrument_id", "timeframe", "type", "candle_close_time", "rules_version_id"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    instrument_id: Mapped[int] = mapped_column(ForeignKey("instruments.id"), index=True)
    timeframe: Mapped[str] = mapped_column(String(4))
    type: Mapped[str] = mapped_column(String(24))
    direction: Mapped[str | None] = mapped_column(String(4))
    status: Mapped[str] = mapped_column(String(20), default="confirmed")
    """confirmed → outcome_recorded (для свечных нет «формируется»)."""
    start_time: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    confirm_time: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    """Закрытие последней свечи паттерна — момент, когда отметка стала известна."""
    candle_close_time: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    geometry: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    """price, atr, candle_time, candles (OHLC свечей паттерна)."""
    quality_score: Mapped[Decimal | None] = mapped_column(Numeric(6, 4))
    context: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    is_significant: Mapped[bool] = mapped_column(Boolean, default=False)
    rules_version_id: Mapped[int] = mapped_column(ForeignKey("pattern_rules_versions.id"))
    ml_model_id: Mapped[int | None] = mapped_column(Integer)
    ml_probability: Mapped[Decimal | None] = mapped_column(Numeric(6, 4))
    source: Mapped[str] = mapped_column(String(8), default="live")  # backfill / live
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class PatternEvent(Base):
    __tablename__ = "pattern_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    pattern_id: Mapped[int] = mapped_column(ForeignKey("patterns.id"), index=True)
    type: Mapped[str] = mapped_column(String(24))
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    details: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)


class PatternOutcome(Base):
    __tablename__ = "pattern_outcomes"

    pattern_id: Mapped[int] = mapped_column(ForeignKey("patterns.id"), primary_key=True)
    horizon_bars: Mapped[int] = mapped_column(Integer, primary_key=True)
    moved_expected: Mapped[bool | None] = mapped_column(Boolean)
    move_atr_favorable: Mapped[Decimal | None] = mapped_column(ATR)
    move_atr_adverse: Mapped[Decimal | None] = mapped_column(ATR)
    target_hit: Mapped[bool | None] = mapped_column(Boolean)
    evaluated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class PatternStatsSnapshot(Base):
    """Агрегаты отработки: тип × таймфрейм × инструмент (NULL — все) × с контекстом (NULL — все)
    × область (backfill/live) × горизонт × год (NULL — все). Считаются воркером из
    ``pattern_outcomes`` без ручного ввода (план 2A.10.4)."""

    __tablename__ = "pattern_stats_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    type: Mapped[str] = mapped_column(String(24), index=True)
    timeframe: Mapped[str] = mapped_column(String(4))
    instrument_id: Mapped[int | None] = mapped_column(ForeignKey("instruments.id"))
    with_context: Mapped[bool | None] = mapped_column(Boolean)
    scope: Mapped[str] = mapped_column(String(8))
    horizon_bars: Mapped[int] = mapped_column(Integer)
    year: Mapped[int | None] = mapped_column(Integer)
    period_start: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    period_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    n: Mapped[int] = mapped_column(Integer)
    success_rate: Mapped[Decimal | None] = mapped_column(Numeric(6, 4))
    ci_low: Mapped[Decimal | None] = mapped_column(Numeric(6, 4))
    ci_high: Mapped[Decimal | None] = mapped_column(Numeric(6, 4))
    avg_move_atr: Mapped[Decimal | None] = mapped_column(ATR)
    avg_adverse_atr: Mapped[Decimal | None] = mapped_column(ATR)
    computed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
