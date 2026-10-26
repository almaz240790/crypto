"""Подписки, платежи, промокоды, баланс (этап 3.1).

Revision ID: 0011
Revises: 0010
Create Date: 2026-10-26
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)
MONEY = sa.Numeric(12, 2)


def upgrade() -> None:
    op.create_table(
        "subscriptions",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id"), nullable=False, unique=True),
        sa.Column("plan", sa.String(16), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("provider", sa.String(16), nullable=False, server_default="crypto"),
        sa.Column("current_period_end", TS, nullable=False),
        sa.Column("trial_end", TS),
        sa.Column("reminded_7", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("reminded_3", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("reminded_0", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", TS, nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("plan in ('pro','premium')", name="ck_subscriptions_plan"),
        sa.CheckConstraint(
            "status in ('trialing','active','expired')", name="ck_subscriptions_status"
        ),
    )
    op.create_table(
        "payments",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("public_id", sa.String(24), nullable=False, unique=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id"), nullable=False, index=True),
        sa.Column("plan", sa.String(16), nullable=False),
        sa.Column("months", sa.Integer, nullable=False),
        sa.Column("price_usd", MONEY, nullable=False),
        sa.Column("discount_usd", MONEY, nullable=False, server_default="0"),
        sa.Column("balance_applied_usd", MONEY, nullable=False, server_default="0"),
        sa.Column("amount_due_usd", MONEY, nullable=False),
        sa.Column("promo_code", sa.String(32)),
        sa.Column("provider", sa.String(16), nullable=False),
        sa.Column("provider_invoice_id", sa.String(64), index=True),
        sa.Column("provider_payment_id", sa.String(64), index=True),
        sa.Column("invoice_url", sa.Text),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("pay_currency", sa.String(16)),
        sa.Column("actually_paid", sa.Numeric(30, 12)),
        sa.Column("actually_paid_usd", MONEY),
        sa.Column("tx_hash", sa.String(128)),
        sa.Column("raw", postgresql.JSONB, nullable=False, server_default="{}"),
        sa.Column("expires_at", TS),
        sa.Column("paid_at", TS),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", TS, nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint(
            "status in ('pending','paid','underpaid','expired','failed','refunded')",
            name="ck_payments_status",
        ),
    )
    op.create_table(
        "promo_codes",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("code", sa.String(32), nullable=False, unique=True),
        sa.Column("percent", sa.Integer, nullable=False, server_default="0"),
        sa.Column("fixed_usd", MONEY, nullable=False, server_default="0"),
        sa.Column("plan", sa.String(16)),
        sa.Column("max_uses", sa.Integer),
        sa.Column("used", sa.Integer, nullable=False, server_default="0"),
        sa.Column("expires_at", TS),
        sa.Column("active", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("percent between 0 and 100", name="ck_promo_percent"),
    )
    op.create_table(
        "balance_entries",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id"), nullable=False, index=True),
        sa.Column("amount_usd", MONEY, nullable=False),
        sa.Column("kind", sa.String(24), nullable=False),
        sa.Column("payment_id", sa.Integer, sa.ForeignKey("payments.id")),
        sa.Column("note", sa.String(255)),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
    )


def downgrade() -> None:
    for t in ("balance_entries", "promo_codes", "payments", "subscriptions"):
        op.drop_table(t)
