from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class SignalTracking(Base):
    """Сохранённое состояние ``engine.tracker.TrackerState`` по открытому сигналу."""

    __tablename__ = "signal_tracking"

    signal_id: Mapped[int] = mapped_column(ForeignKey("signals.id"), primary_key=True)
    state: Mapped[dict[str, Any]] = mapped_column(JSONB)
    timeframe: Mapped[str] = mapped_column(String(4), default="1m")
    last_candle_time: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
