"""Разовые задания выкладки (ADR-0012: ручные шаги заменяются кодом; миграция 0026)."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class DeployJob(Base):
    """Отметка о завершённом разовом задании (например, пересчёт форварда при старте трекера,
    ``app.retrack``). Строка пишется, когда задание выполнено целиком; повторный запуск её видит
    и ничего не делает. ``summary`` — итог и отчёт задания."""

    __tablename__ = "deploy_jobs"

    name: Mapped[str] = mapped_column(String(64), primary_key=True)
    completed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    summary: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
