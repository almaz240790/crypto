"""Журнал запросов к LLM (план 2A.10.3; задача 2B.14). Хранится 30 дней, без текста ответа."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from sqlalchemy import DateTime, ForeignKey, Integer, Numeric, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class LlmRequest(Base):
    __tablename__ = "llm_requests"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    kind: Mapped[str] = mapped_column(String(16))  # explain / question
    model: Mapped[str] = mapped_column(String(48))
    prompt_version: Mapped[str] = mapped_column(String(32))
    cache_key: Mapped[str | None] = mapped_column(String(120))
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost_usd: Mapped[Decimal] = mapped_column(Numeric(10, 6), default=Decimal(0))
    outcome: Mapped[str] = mapped_column(String(12))  # ok / rejected / error / budget / refusal
    latency_ms: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
