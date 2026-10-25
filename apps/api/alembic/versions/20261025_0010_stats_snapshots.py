"""Снимки статистики (этап 2.4).

Revision ID: 0010
Revises: 0009
Create Date: 2026-10-25
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "stats_snapshots",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("scope", sa.String(16), nullable=False, index=True),
        sa.Column(
            "strategy_version_id",
            sa.Integer,
            sa.ForeignKey("strategy_versions.id", ondelete="CASCADE"),
            index=True,
        ),
        sa.Column("instrument_id", sa.Integer, sa.ForeignKey("instruments.id", ondelete="CASCADE")),
        sa.Column("grade", sa.String(1)),
        sa.Column("period_start", TS),
        sa.Column("period_end", TS, nullable=False),
        sa.Column("metrics", postgresql.JSONB, nullable=False),
        sa.Column("computed_at", TS, nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("scope in ('live','forward')", name="ck_stats_snapshots_scope"),
    )
    # один снимок на ключ; NULL в ключе считается значением
    op.create_index(
        "uq_stats_snapshots_key",
        "stats_snapshots",
        ["scope", "strategy_version_id", "instrument_id", "grade"],
        unique=True,
        postgresql_nulls_not_distinct=True,
    )


def downgrade() -> None:
    op.drop_table("stats_snapshots")
