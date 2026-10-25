"""signal_tracking: состояние инкрементального трекера по сигналу (этап 2.3).

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-25
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "signal_tracking",
        sa.Column("signal_id", sa.Integer, sa.ForeignKey("signals.id"), primary_key=True),
        sa.Column("state", JSONB, nullable=False),
        sa.Column("timeframe", sa.String(4), nullable=False, server_default="1m"),
        sa.Column("last_candle_time", sa.DateTime(timezone=True)),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )


def downgrade() -> None:
    op.drop_table("signal_tracking")
