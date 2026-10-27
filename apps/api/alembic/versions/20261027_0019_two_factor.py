"""2FA (TOTP) — план 3.12, v2: секрет, включение, резервные коды.

Revision ID: 0019
Revises: 0018
Create Date: 2026-10-27
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0019"
down_revision = "0018"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "two_factor_secrets",
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id"), primary_key=True),
        sa.Column("secret", sa.String(64), nullable=False),
        sa.Column("enabled_at", TS),
        sa.Column("backup_codes", JSONB, nullable=False, server_default="[]"),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("two_factor_secrets")
