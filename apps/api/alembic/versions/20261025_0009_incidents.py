"""Инциденты для статус-страницы (этап 2.16).

Revision ID: 0009
Revises: 0008
Create Date: 2026-10-25
"""

import sqlalchemy as sa
from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "incidents",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("component", sa.String(32), nullable=False, index=True),
        sa.Column("severity", sa.String(10), nullable=False),
        sa.Column("message", sa.Text, nullable=False),
        sa.Column("opened_at", TS, nullable=False, server_default=sa.func.now()),
        sa.Column("closed_at", TS),
        sa.Column("alerted_at", TS),
        sa.CheckConstraint("severity in ('degraded','down')", name="ck_incidents_severity"),
    )


def downgrade() -> None:
    op.drop_table("incidents")
