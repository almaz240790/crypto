"""Уведомления о тестовых сигналах (ADR-0013): подписка по желанию, по умолчанию выключена.

``notification_settings.email_test_signals`` и ``push_test_signals`` — письма и push о новых
форвард-сигналах («тестовых») и сменах их статуса. Уведомления о live-сигналах не меняются.

Ветка писалась на базе 0024; ревизия 0025 — комиссии в результатах сигналов (ветка
feat/tracker-fees-v2), поэтому эта ревизия — 0026 после 0025 и сливается после неё.

Revision ID: 0026
Revises: 0025
Create Date: 2026-11-10
"""

import sqlalchemy as sa
from alembic import op

revision = "0026"
down_revision = "0025"
branch_labels = None
depends_on = None

COLUMNS = ("email_test_signals", "push_test_signals")


def upgrade() -> None:
    for name in COLUMNS:
        op.add_column(
            "notification_settings",
            sa.Column(name, sa.Boolean, nullable=False, server_default=sa.false()),
        )


def downgrade() -> None:
    for name in reversed(COLUMNS):
        op.drop_column("notification_settings", name)
