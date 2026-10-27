"""Рисунки и раскладки терминала (план 2A.5, 2A.4, раздел 7; задача 2B.7)."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class Drawing(Base):
    """Рисунок пользователя. ``client_id`` — id, выданный клиентом (офлайн-очередь); удаление
    мягкое (``deleted_at``); конфликт двух устройств решается по ``updated_at`` — последняя запись
    побеждает. ``updated_at`` — unix-миллисекунды клиента, одинаковые для всех устройств."""

    __tablename__ = "drawings"
    __table_args__ = (UniqueConstraint("user_id", "client_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    client_id: Mapped[str] = mapped_column(String(40))
    instrument_id: Mapped[int] = mapped_column(ForeignKey("instruments.id"), index=True)
    timeframe: Mapped[str | None] = mapped_column(String(4))
    type: Mapped[str] = mapped_column(String(20))
    points: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list)
    style: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    text: Mapped[str | None] = mapped_column(String(140))
    levels: Mapped[list[float] | None] = mapped_column(JSONB)
    locked: Mapped[bool] = mapped_column(Boolean, default=False)
    updated_at: Mapped[int] = mapped_column(BigInteger)
    deleted_at: Mapped[int | None] = mapped_column(BigInteger)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    synced_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class ChartLayout(Base):
    """Раскладка терминала: последняя (name = NULL) восстанавливается при входе;
    именованные — по тарифу."""

    __tablename__ = "chart_layouts"
    __table_args__ = (UniqueConstraint("user_id", "name"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    name: Mapped[str | None] = mapped_column(String(60))
    data: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    updated_at: Mapped[int] = mapped_column(BigInteger)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class SavedScreen(Base):
    """Сохранённый набор фильтров скринера (план 3.6, v2)."""

    __tablename__ = "saved_screens"
    __table_args__ = (UniqueConstraint("user_id", "name", name="uq_saved_screens_user_name"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    name: Mapped[str] = mapped_column(String(60))
    filters: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
