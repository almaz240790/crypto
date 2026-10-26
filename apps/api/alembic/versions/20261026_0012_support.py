"""Обращения в поддержку (этап 3.6).

Revision ID: 0012
Revises: 0011
Create Date: 2026-10-26
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "support_tickets",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id"), index=True),
        sa.Column("email", sa.String(255), nullable=False),
        sa.Column("subject", sa.String(200), nullable=False),
        sa.Column("message", sa.Text, nullable=False),
        sa.Column("context", postgresql.JSONB, nullable=False, server_default="{}"),
        sa.Column("status", sa.String(16), nullable=False, server_default="open"),
        sa.Column("reply", sa.Text),
        sa.Column("replied_by", sa.Integer, sa.ForeignKey("users.id")),
        sa.Column("replied_at", TS),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("status in ('open','answered','closed')", name="ck_tickets_status"),
    )


def downgrade() -> None:
    op.drop_table("support_tickets")
