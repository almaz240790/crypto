"""Подписки, платежи, промокоды, баланс (план 3.13, раздел 7)."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, Numeric, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

MONEY = Numeric(12, 2)


class Subscription(Base):
    """Одна строка на пользователя: тариф и срок. Оплата продлевает срок, не заменяет его."""

    __tablename__ = "subscriptions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), unique=True, index=True)
    plan: Mapped[str] = mapped_column(String(16))  # pro / premium
    status: Mapped[str] = mapped_column(String(16))  # trialing / active / expired
    provider: Mapped[str] = mapped_column(String(16), default="crypto")  # crypto/manual/trial
    current_period_end: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    trial_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reminded_7: Mapped[bool] = mapped_column(Boolean, default=False)
    reminded_3: Mapped[bool] = mapped_column(Boolean, default=False)
    reminded_0: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class Payment(Base):
    """Инвойс/платёж. Строка создаётся при оформлении, статус меняется по вебхукам и сверке."""

    __tablename__ = "payments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    public_id: Mapped[str] = mapped_column(String(24), unique=True)
    """order_id у провайдера."""
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    plan: Mapped[str] = mapped_column(String(16))
    months: Mapped[int] = mapped_column(Integer)
    price_usd: Mapped[Decimal] = mapped_column(MONEY)
    """Цена до скидок."""
    discount_usd: Mapped[Decimal] = mapped_column(MONEY, default=Decimal(0))
    balance_applied_usd: Mapped[Decimal] = mapped_column(MONEY, default=Decimal(0))
    amount_due_usd: Mapped[Decimal] = mapped_column(MONEY)
    """К оплате у провайдера = price − discount − balance_applied."""
    promo_code: Mapped[str | None] = mapped_column(String(32))
    provider: Mapped[str] = mapped_column(String(16))  # nowpayments / balance / manual
    provider_invoice_id: Mapped[str | None] = mapped_column(String(64), index=True)
    provider_payment_id: Mapped[str | None] = mapped_column(String(64), index=True)
    invoice_url: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), default="pending")
    """pending / paid / underpaid / expired / failed / refunded."""
    pay_currency: Mapped[str | None] = mapped_column(String(16))
    actually_paid: Mapped[Decimal | None] = mapped_column(Numeric(30, 12))
    actually_paid_usd: Mapped[Decimal | None] = mapped_column(MONEY)
    tx_hash: Mapped[str | None] = mapped_column(String(128))
    raw: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    paid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class PromoCode(Base):
    __tablename__ = "promo_codes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(32), unique=True)
    percent: Mapped[int] = mapped_column(Integer, default=0)
    """Скидка в процентах (0–100)."""
    fixed_usd: Mapped[Decimal] = mapped_column(MONEY, default=Decimal(0))
    """Или фиксированная сумма в USD (применяется после процента)."""
    plan: Mapped[str | None] = mapped_column(String(16))
    """Только для тарифа (None — любой)."""
    max_uses: Mapped[int | None] = mapped_column(Integer)
    used: Mapped[int] = mapped_column(Integer, default=0)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class BalanceEntry(Base):
    """Внутренний баланс в USD-эквиваленте: пополнение, списание, переплата, рефералы (план 3.13).
    Баланс = сумма записей. Выводов нет."""

    __tablename__ = "balance_entries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    amount_usd: Mapped[Decimal] = mapped_column(MONEY)
    kind: Mapped[str] = mapped_column(String(24))
    """overpayment / underpayment_credit / subscription / upgrade_credit / manual / promo."""
    payment_id: Mapped[int | None] = mapped_column(ForeignKey("payments.id"))
    note: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
