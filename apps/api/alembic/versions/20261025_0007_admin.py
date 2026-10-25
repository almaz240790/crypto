"""Админка: заявки на смену статуса версий (четыре глаза), аудит-лог, блокировка (этап 2.14).

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-25
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.add_column("users", sa.Column("blocked_at", TS))
    op.add_column("users", sa.Column("blocked_reason", sa.String(255)))
    op.create_table(
        "status_change_requests",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "strategy_version_id",
            sa.Integer,
            sa.ForeignKey("strategy_versions.id"),
            nullable=False,
            index=True,
        ),
        sa.Column("from_status", sa.String(16), nullable=False),
        sa.Column("to_status", sa.String(16), nullable=False),
        sa.Column("reason", sa.Text, nullable=False),
        sa.Column("requested_by", sa.Integer, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("decided_by", sa.Integer, sa.ForeignKey("users.id")),
        sa.Column("decision", sa.String(10), nullable=False, server_default="pending"),
        sa.Column("decision_note", sa.Text),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.Column("decided_at", TS),
        sa.CheckConstraint("decision in ('pending','applied','rejected')", name="ck_scr_decision"),
    )
    op.create_table(
        "admin_audit",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("actor_id", sa.Integer, sa.ForeignKey("users.id"), nullable=False, index=True),
        sa.Column("action", sa.String(48), nullable=False),
        sa.Column("target", sa.String(128), nullable=False),
        sa.Column("payload", JSONB, nullable=False, server_default="{}"),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("admin_audit")
    op.drop_table("status_change_requests")
    op.drop_column("users", "blocked_reason")
    op.drop_column("users", "blocked_at")
