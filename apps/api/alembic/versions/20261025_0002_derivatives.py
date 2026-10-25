"""Деривативные ряды: funding_rates, open_interest, long_short_ratios, liquidations (hypertables).

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-25
"""

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

RATE = sa.Numeric(12, 8)
QTY = sa.Numeric(28, 10)
TS = sa.DateTime(timezone=True)


def _hypertable(table: str, time_col: str) -> None:
    op.execute(
        f"SELECT create_hypertable('{table}', '{time_col}', chunk_time_interval => INTERVAL '90 days', "
        "if_not_exists => TRUE)"
    )


def upgrade() -> None:
    op.create_table(
        "funding_rates",
        sa.Column("instrument_id", sa.Integer, sa.ForeignKey("instruments.id"), nullable=False),
        sa.Column("funding_time", TS, nullable=False),
        sa.Column("rate", RATE, nullable=False),
        sa.Column("interval_hours", sa.Integer),
        sa.PrimaryKeyConstraint("instrument_id", "funding_time"),
    )
    _hypertable("funding_rates", "funding_time")

    op.create_table(
        "open_interest",
        sa.Column("instrument_id", sa.Integer, sa.ForeignKey("instruments.id"), nullable=False),
        sa.Column("time", TS, nullable=False),
        sa.Column("oi_contracts", QTY, nullable=False),
        sa.Column("oi_quote", QTY, nullable=False),
        sa.PrimaryKeyConstraint("instrument_id", "time"),
    )
    _hypertable("open_interest", "time")

    op.create_table(
        "long_short_ratios",
        sa.Column("instrument_id", sa.Integer, sa.ForeignKey("instruments.id"), nullable=False),
        sa.Column("time", TS, nullable=False),
        sa.Column("top_traders_ratio", RATE, nullable=False),
        sa.Column("global_ratio", RATE, nullable=False),
        sa.Column("taker_ratio", RATE),
        sa.PrimaryKeyConstraint("instrument_id", "time"),
    )
    _hypertable("long_short_ratios", "time")

    op.create_table(
        "liquidations",
        sa.Column("instrument_id", sa.Integer, sa.ForeignKey("instruments.id"), nullable=False),
        sa.Column("time", TS, nullable=False),
        sa.Column("long_usd", QTY, nullable=False, server_default="0"),
        sa.Column("short_usd", QTY, nullable=False, server_default="0"),
        sa.Column("source", sa.String(16), nullable=False, server_default="stream"),
        sa.PrimaryKeyConstraint("instrument_id", "time"),
    )
    _hypertable("liquidations", "time")


def downgrade() -> None:
    for table in ("liquidations", "long_short_ratios", "open_interest", "funding_rates"):
        op.drop_table(table)
