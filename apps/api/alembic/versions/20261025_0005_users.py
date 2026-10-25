"""Пользователи, входы, риск-профиль, токены, вотчлист, журнал (этап 2.5).

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-25
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)
PRICE = sa.Numeric(24, 10)


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("email", sa.String(255), nullable=False, unique=True),
        sa.Column("email_verified_at", TS),
        sa.Column("password_hash", sa.String(255)),
        sa.Column("name", sa.String(100)),
        sa.Column("country", sa.String(2)),
        sa.Column("locale", sa.String(5), nullable=False, server_default="ru"),
        sa.Column("timezone", sa.String(64), nullable=False, server_default="UTC"),
        sa.Column("theme", sa.String(8), nullable=False, server_default="system"),
        sa.Column("role", sa.String(16), nullable=False, server_default="user"),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.Column("deleted_at", TS),
        sa.Column("terms_accepted_at", TS),
        sa.Column("marketing_opt_in", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.CheckConstraint("role in ('user','support','admin','owner')", name="ck_users_role"),
    )
    op.create_table(
        "auth_identities",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id"), nullable=False, index=True),
        sa.Column("provider", sa.String(16), nullable=False),
        sa.Column("provider_user_id", sa.String(128), nullable=False),
        sa.Column("data", JSONB, nullable=False, server_default="{}"),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("provider", "provider_user_id"),
    )
    op.create_table(
        "risk_profiles",
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id"), primary_key=True),
        sa.Column("deposit", sa.Numeric(18, 2)),
        sa.Column("risk_pct", sa.Numeric(5, 2), nullable=False, server_default="1.00"),
        sa.Column("exchange", sa.String(16), nullable=False, server_default="binance"),
        sa.Column("market_type", sa.String(8), nullable=False, server_default="futures"),
        sa.Column("default_leverage", sa.Integer, nullable=False, server_default="3"),
        sa.Column("experience", sa.String(16)),
    )
    op.create_table(
        "email_tokens",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id"), nullable=False, index=True),
        sa.Column("purpose", sa.String(16), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("expires_at", TS, nullable=False),
        sa.Column("used_at", TS),
    )
    op.create_table(
        "refresh_tokens",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id"), nullable=False, index=True),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("expires_at", TS, nullable=False),
        sa.Column("revoked_at", TS),
        sa.Column("user_agent", sa.String(255)),
    )
    op.create_table(
        "watchlists",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id"), nullable=False, index=True),
        sa.Column("name", sa.String(64), nullable=False, server_default="Основной"),
    )
    op.create_table(
        "watchlist_items",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "watchlist_id", sa.Integer, sa.ForeignKey("watchlists.id"), nullable=False, index=True
        ),
        sa.Column("instrument_id", sa.Integer, sa.ForeignKey("instruments.id"), nullable=False),
        sa.Column("added_at", TS, nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("watchlist_id", "instrument_id"),
    )
    op.create_table(
        "journal_entries",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id"), nullable=False, index=True),
        sa.Column("signal_id", sa.Integer, sa.ForeignKey("signals.id")),
        sa.Column("instrument_id", sa.Integer, sa.ForeignKey("instruments.id"), nullable=False),
        sa.Column("direction", sa.String(5), nullable=False),
        sa.Column("entry_price", PRICE, nullable=False),
        sa.Column("entry_at", TS, nullable=False),
        sa.Column("stop_loss", PRICE),
        sa.Column("take_profits", JSONB, nullable=False, server_default="[]"),
        sa.Column("size", sa.Numeric(28, 10)),
        sa.Column("exit_price", PRICE),
        sa.Column("exit_at", TS),
        sa.Column("realized_r", sa.Numeric(8, 3)),
        sa.Column("realized_quote", sa.Numeric(18, 2)),
        sa.Column("fees", sa.Numeric(18, 4)),
        sa.Column("tags", JSONB, nullable=False, server_default="[]"),
        sa.Column("note", sa.Text),
        sa.Column("screenshot_url", sa.String(512)),
        sa.Column("source", sa.String(8), nullable=False, server_default="manual"),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", TS, nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("direction in ('long','short')", name="ck_journal_direction"),
    )


def downgrade() -> None:
    for t in (
        "journal_entries",
        "watchlist_items",
        "watchlists",
        "refresh_tokens",
        "email_tokens",
        "risk_profiles",
        "auth_identities",
        "users",
    ):
        op.drop_table(t)
