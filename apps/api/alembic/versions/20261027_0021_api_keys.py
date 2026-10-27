"""API-ключи пользователей для чтения (план 3.10, 3.12: Premium).

Revision ID: 0021
Revises: 0020
Create Date: 2026-10-27
"""

import sqlalchemy as sa
from alembic import op

revision = "0021"
down_revision = "0020"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "api_keys",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id"), nullable=False, index=True),
        sa.Column("name", sa.String(60), nullable=False),
        sa.Column("prefix", sa.String(12), nullable=False),
        sa.Column("key_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.Column("last_used_at", TS),
        sa.Column("revoked_at", TS),
    )


def downgrade() -> None:
    op.drop_table("api_keys")
