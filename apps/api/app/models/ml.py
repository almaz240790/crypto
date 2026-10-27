"""Метки разметчиков для кандидатов фигур (план 2A.10.2; задача 4B.2)."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class MlLabel(Base):
    __tablename__ = "ml_labels"
    __table_args__ = (UniqueConstraint("candidate_figure_id", "labeler_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    candidate_figure_id: Mapped[int] = mapped_column(ForeignKey("figures.id"), index=True)
    labeler_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    label: Mapped[str] = mapped_column(String(12))  # figure / not_figure / unsure
    figure_type: Mapped[str | None] = mapped_column(String(24))
    labeled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    time_spent_s: Mapped[int] = mapped_column(Integer, default=0)
