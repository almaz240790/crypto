from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class BacktestRun(Base):
    __tablename__ = "backtest_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    strategy_version: Mapped[str] = mapped_column(String(64))
    params: Mapped[dict[str, Any]] = mapped_column(JSONB)
    period_start: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    period_end: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    instruments: Mapped[list[str]] = mapped_column(JSONB)
    execution: Mapped[dict[str, Any]] = mapped_column(JSONB)
    result_summary: Mapped[dict[str, Any]] = mapped_column(JSONB)
    trades: Mapped[list[dict[str, Any]]] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    created_by: Mapped[str | None] = mapped_column(String(64))
    note: Mapped[str | None] = mapped_column(Text)
