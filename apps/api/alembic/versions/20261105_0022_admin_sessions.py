"""Отдельный вход в админку (ADR-0011): сеансы админки и попытки входа без пользователя в аудите.

- ``admin_sessions`` — сеансы админки (8 ч с входа, 1 ч без действий, отзыв при смене пароля
  и отключении 2FA).
- ``admin_audit.actor_id`` может быть пустым: так пишутся попытки входа с неизвестным адресом.

Откат удаляет такие строки аудита (без пользователя их не к чему привязать) и таблицу сеансов.

Revision ID: 0022
Revises: 0021
Create Date: 2026-11-05
"""

import sqlalchemy as sa
from alembic import op

revision = "0022"
down_revision = "0021"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "admin_sessions",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id"), nullable=False, index=True),
        sa.Column("method", sa.String(16), nullable=False),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("last_seen_at", TS, nullable=False),
        sa.Column("expires_at", TS, nullable=False),
        sa.Column("revoked_at", TS),
        sa.Column("ip", sa.String(64)),
        sa.Column("user_agent", sa.String(255)),
    )
    op.alter_column("admin_audit", "actor_id", existing_type=sa.Integer, nullable=True)


def downgrade() -> None:
    op.execute("DELETE FROM admin_audit WHERE actor_id IS NULL")
    op.alter_column("admin_audit", "actor_id", existing_type=sa.Integer, nullable=False)
    op.drop_table("admin_sessions")
