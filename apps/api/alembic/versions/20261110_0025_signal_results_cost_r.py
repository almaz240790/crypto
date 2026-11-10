"""signal_results.cost_r: вычтенные из результата комиссия и проскальзывание в R (задача 3,
план 2.11). У строк, записанных до этой ревизии, столбец NULL: их результат без комиссий.

Ветка писалась на базе 0021 (ревизия 0023) и при сведении с областью сигнала (0022), архивом
версии 1.0.0 (0023) и входом в админку (0024) стала ревизией 0025 после 0024.

Revision ID: 0025
Revises: 0024
Create Date: 2026-11-10
"""

import sqlalchemy as sa
from alembic import op

revision = "0025"
down_revision = "0024"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("signal_results", sa.Column("cost_r", sa.Numeric(8, 3), nullable=True))


def downgrade() -> None:
    op.drop_column("signal_results", "cost_r")
