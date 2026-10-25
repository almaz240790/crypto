"""Web Push: подписки и флаги канала push (этап 2.15).

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-25
"""

import sqlalchemy as sa
from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.add_column(
        "notification_settings",
        sa.Column("push_signals", sa.Boolean, nullable=False, server_default=sa.true()),
    )
    op.add_column(
        "notification_settings",
        sa.Column("push_events", sa.Boolean, nullable=False, server_default=sa.true()),
    )
    op.create_table(
        "push_subscriptions",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id"), nullable=False, index=True),
        sa.Column("endpoint", sa.Text, nullable=False, unique=True),
        sa.Column("p256dh", sa.String(255), nullable=False),
        sa.Column("auth_key", sa.String(255), nullable=False),
        sa.Column("user_agent", sa.String(255)),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.Column("last_ok_at", TS),
        sa.Column("failures", sa.Integer, nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_table("push_subscriptions")
    op.drop_column("notification_settings", "push_events")
    op.drop_column("notification_settings", "push_signals")
