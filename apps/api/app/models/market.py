from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

PRICE = Numeric(24, 10)
QTY = Numeric(28, 10)


class Instrument(Base):
    __tablename__ = "instruments"
    __table_args__ = (UniqueConstraint("exchange", "symbol", "market_type"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    exchange: Mapped[str] = mapped_column(String(16))  # binance / bybit
    symbol: Mapped[str] = mapped_column(String(32))  # BTCUSDT
    base: Mapped[str] = mapped_column(String(16))
    quote: Mapped[str] = mapped_column(String(16))
    market_type: Mapped[str] = mapped_column(String(8))  # spot / futures
    tick_size: Mapped[Decimal] = mapped_column(PRICE)
    lot_size: Mapped[Decimal] = mapped_column(QTY)
    min_notional: Mapped[Decimal] = mapped_column(PRICE, default=Decimal(0))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    avg_volume_30d: Mapped[Decimal | None] = mapped_column(PRICE)
    listed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    delisted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Candle(Base):
    """Hypertable (TimescaleDB) по open_time. Составной ключ без суррогатного id."""

    __tablename__ = "candles"

    instrument_id: Mapped[int] = mapped_column(ForeignKey("instruments.id"), primary_key=True)
    timeframe: Mapped[str] = mapped_column(String(4), primary_key=True)  # 1m / 4h / 1d / 1w
    open_time: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    open: Mapped[Decimal] = mapped_column(PRICE)
    high: Mapped[Decimal] = mapped_column(PRICE)
    low: Mapped[Decimal] = mapped_column(PRICE)
    close: Mapped[Decimal] = mapped_column(PRICE)
    volume: Mapped[Decimal] = mapped_column(QTY)
    quote_volume: Mapped[Decimal] = mapped_column(QTY, default=Decimal(0))
    trades: Mapped[int] = mapped_column(BigInteger, default=0)
    is_closed: Mapped[bool] = mapped_column(Boolean, default=True)
