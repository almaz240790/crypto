"""Пользователи, способы входа, риск-профиль, вотчлист, журнал (план, раздел 7)."""

from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

PRICE = Numeric(24, 10)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True)
    email_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    password_hash: Mapped[str | None] = mapped_column(String(255))
    name: Mapped[str | None] = mapped_column(String(100))
    country: Mapped[str | None] = mapped_column(String(2))
    locale: Mapped[str] = mapped_column(String(5), default="ru")
    timezone: Mapped[str] = mapped_column(String(64), default="UTC")
    theme: Mapped[str] = mapped_column(String(8), default="system")
    role: Mapped[str] = mapped_column(String(16), default="user")  # user/support/admin/owner
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    terms_accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    marketing_opt_in: Mapped[bool] = mapped_column(Boolean, default=False)


class AuthIdentity(Base):
    __tablename__ = "auth_identities"
    __table_args__ = (UniqueConstraint("provider", "provider_user_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    provider: Mapped[str] = mapped_column(String(16))  # google / telegram / email
    provider_user_id: Mapped[str] = mapped_column(String(128))
    data: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class RiskProfile(Base):
    __tablename__ = "risk_profiles"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), primary_key=True)
    deposit: Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    risk_pct: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=Decimal("1.00"))
    exchange: Mapped[str] = mapped_column(String(16), default="binance")
    market_type: Mapped[str] = mapped_column(String(8), default="futures")
    default_leverage: Mapped[int] = mapped_column(Integer, default=3)
    experience: Mapped[str | None] = mapped_column(String(16))  # novice / experienced / systematic


class EmailToken(Base):
    """Одноразовые токены: подтверждение email, magic link, сброс пароля."""

    __tablename__ = "email_tokens"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    purpose: Mapped[str] = mapped_column(String(16))  # verify / magic / reset
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    user_agent: Mapped[str | None] = mapped_column(String(255))


class Watchlist(Base):
    __tablename__ = "watchlists"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    name: Mapped[str] = mapped_column(String(64), default="Основной")


class WatchlistItem(Base):
    __tablename__ = "watchlist_items"
    __table_args__ = (UniqueConstraint("watchlist_id", "instrument_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    watchlist_id: Mapped[int] = mapped_column(ForeignKey("watchlists.id"), index=True)
    instrument_id: Mapped[int] = mapped_column(ForeignKey("instruments.id"))
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class JournalEntry(Base):
    __tablename__ = "journal_entries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    signal_id: Mapped[int | None] = mapped_column(ForeignKey("signals.id"))
    instrument_id: Mapped[int] = mapped_column(ForeignKey("instruments.id"))
    direction: Mapped[str] = mapped_column(String(5))
    entry_price: Mapped[Decimal] = mapped_column(PRICE)
    entry_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    stop_loss: Mapped[Decimal | None] = mapped_column(PRICE)
    take_profits: Mapped[list[Any]] = mapped_column(JSONB, default=list)
    size: Mapped[Decimal | None] = mapped_column(Numeric(28, 10))
    exit_price: Mapped[Decimal | None] = mapped_column(PRICE)
    exit_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    realized_r: Mapped[Decimal | None] = mapped_column(Numeric(8, 3))
    realized_quote: Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    fees: Mapped[Decimal | None] = mapped_column(Numeric(18, 4))
    tags: Mapped[list[Any]] = mapped_column(JSONB, default=list)
    note: Mapped[str | None] = mapped_column(Text)
    screenshot_url: Mapped[str | None] = mapped_column(String(512))
    source: Mapped[str] = mapped_column(String(8), default="manual")  # manual / signal / import
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class NotificationSettings(Base):
    """Настройки уведомлений (план 3.11): каналы, типы, градации, инструменты, тихие часы."""

    __tablename__ = "notification_settings"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), primary_key=True)
    email_digest: Mapped[str] = mapped_column(String(8), default="daily")  # daily / weekly / off
    email_signals: Mapped[bool] = mapped_column(Boolean, default=False)
    """Письмо о каждом новом сигнале (с учётом градаций, инструментов, тихих часов)."""
    email_events: Mapped[bool] = mapped_column(Boolean, default=False)
    """Письма о событиях: вход, TP, безубыток, стоп, истечение."""
    grades: Mapped[list[Any]] = mapped_column(JSONB, default=lambda: ["A", "B", "C"])
    scope: Mapped[str] = mapped_column(String(10), default="all")  # all / watchlist
    quiet_from: Mapped[int | None] = mapped_column(Integer)  # час UTC, начало тихих часов
    quiet_to: Mapped[int | None] = mapped_column(Integer)
    daily_limit: Mapped[int] = mapped_column(Integer, default=20)
    sent_day: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    sent_today: Mapped[int] = mapped_column(Integer, default=0)
    unsubscribe_token: Mapped[str] = mapped_column(String(64), unique=True)
    telegram_chat_id: Mapped[str | None] = mapped_column(String(32))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class NotificationLog(Base):
    """Что и кому отправлено — для лимитов, повторов и аудита."""

    __tablename__ = "notification_log"
    __table_args__ = (UniqueConstraint("user_id", "channel", "kind", "ref"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    channel: Mapped[str] = mapped_column(String(10))  # email / telegram / push
    kind: Mapped[str] = mapped_column(String(16))  # signal / event / digest / test
    ref: Mapped[str] = mapped_column(String(64))  # public_id сигнала, id события, дата дайджеста
    sent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
