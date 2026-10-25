"""Настройки уведомлений и журнал отправок (этап 2.13).

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-25
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "notification_settings",
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id"), primary_key=True),
        sa.Column("email_digest", sa.String(8), nullable=False, server_default="daily"),
        sa.Column("email_signals", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("email_events", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("grades", JSONB, nullable=False, server_default='["A","B","C"]'),
        sa.Column("scope", sa.String(10), nullable=False, server_default="all"),
        sa.Column("quiet_from", sa.Integer),
        sa.Column("quiet_to", sa.Integer),
        sa.Column("daily_limit", sa.Integer, nullable=False, server_default="20"),
        sa.Column("sent_day", TS),
        sa.Column("sent_today", sa.Integer, nullable=False, server_default="0"),
        sa.Column("unsubscribe_token", sa.String(64), nullable=False, unique=True),
        sa.Column("telegram_chat_id", sa.String(32)),
        sa.Column("updated_at", TS, nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("email_digest in ('daily','weekly','off')", name="ck_notif_digest"),
        sa.CheckConstraint("scope in ('all','watchlist')", name="ck_notif_scope"),
    )
    op.create_table(
        "notification_log",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id"), nullable=False, index=True),
        sa.Column("channel", sa.String(10), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("ref", sa.String(64), nullable=False),
        sa.Column("sent_at", TS, nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("user_id", "channel", "kind", "ref", name="uq_notification_log"),
    )


def downgrade() -> None:
    op.drop_table("notification_log")
    op.drop_table("notification_settings")
