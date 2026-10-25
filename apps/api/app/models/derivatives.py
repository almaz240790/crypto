"""Деривативные ряды (план, раздел 7): funding, OI, long/short, ликвидации. Hypertables."""

from datetime import datetime
from decimal import Decimal

from sqlalchemy import DateTime, ForeignKey, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

RATE = Numeric(12, 8)
QTY = Numeric(28, 10)


class FundingRateRow(Base):
    __tablename__ = "funding_rates"

    instrument_id: Mapped[int] = mapped_column(ForeignKey("instruments.id"), primary_key=True)
    funding_time: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    rate: Mapped[Decimal] = mapped_column(RATE)
    interval_hours: Mapped[int | None] = mapped_column()


class OpenInterestRow(Base):
    __tablename__ = "open_interest"

    instrument_id: Mapped[int] = mapped_column(ForeignKey("instruments.id"), primary_key=True)
    time: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    oi_contracts: Mapped[Decimal] = mapped_column(QTY)
    oi_quote: Mapped[Decimal] = mapped_column(QTY)


class LongShortRatioRow(Base):
    __tablename__ = "long_short_ratios"

    instrument_id: Mapped[int] = mapped_column(ForeignKey("instruments.id"), primary_key=True)
    time: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    top_traders_ratio: Mapped[Decimal] = mapped_column(RATE)
    global_ratio: Mapped[Decimal] = mapped_column(RATE)
    taker_ratio: Mapped[Decimal | None] = mapped_column(RATE)


class LiquidationRow(Base):
    """Агрегат по интервалу (1m из live-стрима forceOrder; H4 — continuous aggregate)."""

    __tablename__ = "liquidations"

    instrument_id: Mapped[int] = mapped_column(ForeignKey("instruments.id"), primary_key=True)
    time: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    long_usd: Mapped[Decimal] = mapped_column(QTY)
    short_usd: Mapped[Decimal] = mapped_column(QTY)
    source: Mapped[str] = mapped_column(String(16), default="stream")
