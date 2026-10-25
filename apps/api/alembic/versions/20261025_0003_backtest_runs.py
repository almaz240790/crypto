"""backtest_runs: результаты прогонов бэктеста (план, раздел 7).

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-25
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "backtest_runs",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("strategy_version", sa.String(64), nullable=False),
        sa.Column("params", JSONB, nullable=False),
        sa.Column("period_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("period_end", sa.DateTime(timezone=True), nullable=False),
        sa.Column("instruments", JSONB, nullable=False),
        sa.Column("execution", JSONB, nullable=False),
        sa.Column("result_summary", JSONB, nullable=False),
        sa.Column("trades", JSONB, nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("created_by", sa.String(64)),
        sa.Column("note", sa.Text),
    )


def downgrade() -> None:
    op.drop_table("backtest_runs")
