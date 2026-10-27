"""Рисунки и раскладки терминала (этап 2B.7).

Revision ID: 0013
Revises: 0012
Create Date: 2026-10-27
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "drawings",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id"), nullable=False, index=True),
        sa.Column("client_id", sa.String(40), nullable=False),
        sa.Column(
            "instrument_id", sa.Integer, sa.ForeignKey("instruments.id"), nullable=False, index=True
        ),
        sa.Column("timeframe", sa.String(4)),
        sa.Column("type", sa.String(20), nullable=False),
        sa.Column("points", postgresql.JSONB, nullable=False, server_default="[]"),
        sa.Column("style", postgresql.JSONB, nullable=False, server_default="{}"),
        sa.Column("text", sa.String(140)),
        sa.Column("levels", postgresql.JSONB),
        sa.Column("locked", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("updated_at", sa.BigInteger, nullable=False),
        sa.Column("deleted_at", sa.BigInteger),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.Column("synced_at", TS, nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("user_id", "client_id", name="uq_drawings_user_client"),
    )
    op.create_table(
        "chart_layouts",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id"), nullable=False, index=True),
        sa.Column("name", sa.String(60)),
        sa.Column("data", postgresql.JSONB, nullable=False, server_default="{}"),
        sa.Column("updated_at", sa.BigInteger, nullable=False),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("user_id", "name", name="uq_chart_layouts_user_name"),
    )


def downgrade() -> None:
    op.drop_table("chart_layouts")
    op.drop_table("drawings")
