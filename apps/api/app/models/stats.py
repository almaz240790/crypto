"""Снимки статистики (план 7, таблица ``stats_snapshots``; задача 2.4)."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class StatsSnapshot(Base):
    """Готовые агрегаты публичной статистики по ключу (область, версия, инструмент, градация).

    Пересчитываются воркером по расписанию и после закрытия сигнала; хранится последний снимок
    по каждому ключу. ``metrics`` — тот же JSON, что отдаёт ``GET /v1/stats``.
    """

    __tablename__ = "stats_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    scope: Mapped[str] = mapped_column(String(16), index=True)  # live / forward
    strategy_version_id: Mapped[int | None] = mapped_column(
        ForeignKey("strategy_versions.id", ondelete="CASCADE"), index=True
    )
    instrument_id: Mapped[int | None] = mapped_column(
        ForeignKey("instruments.id", ondelete="CASCADE")
    )
    grade: Mapped[str | None] = mapped_column(String(1))
    period_start: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    period_end: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    metrics: Mapped[dict[str, Any]] = mapped_column(JSON)
    computed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
