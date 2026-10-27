"""Алерты на графике: alerts, alert_triggers, каналы алертов в настройках (этап 2B.13).

Revision ID: 0015
Revises: 0014
Create Date: 2026-10-27
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)
PRICE = sa.Numeric(24, 10)


def upgrade() -> None:
    op.create_table(
        "alerts",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id"), nullable=False, index=True),
        sa.Column("instrument_id", sa.Integer, sa.ForeignKey("instruments.id"), index=True),
        sa.Column("timeframe", sa.String(4)),
        sa.Column("type", sa.String(12), nullable=False),
        sa.Column("condition", postgresql.JSONB, nullable=False, server_default="{}"),
        sa.Column("frequency", sa.String(14), nullable=False, server_default="once"),
        sa.Column("expires_at", TS),
        sa.Column("status", sa.String(10), nullable=False, server_default="active"),
        sa.Column("drawing_client_id", sa.String(40)),
        sa.Column("note", sa.String(140)),
        sa.Column("last_triggered_at", TS),
        sa.Column("triggers_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint(
            "type in ('price','indicator','zone','structure','pattern')", name="ck_alerts_type"
        ),
        sa.CheckConstraint(
            "frequency in ('once','every','once_per_bar')", name="ck_alerts_frequency"
        ),
        sa.CheckConstraint(
            "status in ('active','triggered','expired','paused')", name="ck_alerts_status"
        ),
    )
    op.create_index("ix_alerts_active", "alerts", ["status", "type", "instrument_id"])
    op.create_table(
        "alert_triggers",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "alert_id",
            sa.Integer,
            sa.ForeignKey("alerts.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("triggered_at", TS, nullable=False),
        sa.Column("price", PRICE),
        sa.Column("details", postgresql.JSONB, nullable=False, server_default="{}"),
        sa.Column("notified", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("alert_id", "triggered_at", name="uq_alert_triggers_once"),
    )
    op.add_column(
        "notification_settings",
        sa.Column("email_alerts", sa.Boolean, nullable=False, server_default=sa.false()),
    )
    op.add_column(
        "notification_settings",
        sa.Column("push_alerts", sa.Boolean, nullable=False, server_default=sa.true()),
    )


def downgrade() -> None:
    op.drop_column("notification_settings", "push_alerts")
    op.drop_column("notification_settings", "email_alerts")
    op.drop_table("alert_triggers")
    op.drop_index("ix_alerts_active", table_name="alerts")
    op.drop_table("alerts")
