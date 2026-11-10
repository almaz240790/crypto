"""Отдельный вход в админку (ADR-0011): сеансы админки и попытки входа без пользователя в аудите.

- ``admin_sessions`` — сеансы админки (8 ч с входа, 1 ч без действий, отзыв при смене пароля
  и отключении 2FA).
- ``admin_audit.actor_id`` может быть пустым: так пишутся попытки входа с неизвестным адресом.
- ``two_factor_secrets.last_step`` — номер последнего принятого шага TOTP: один и тот же код
  не принимается второй раз ни на сайте, ни в админке.

Откат удаляет такие строки аудита (без пользователя их не к чему привязать), таблицу сеансов
и столбец ``last_step``.

Ветка писалась параллельно с областью сигнала (0022) и архивом версии 1.0.0 (0023) и при сведении
стала ревизией 0024 после 0023.

Revision ID: 0024
Revises: 0023
Create Date: 2026-11-05
"""

import sqlalchemy as sa
from alembic import op

revision = "0024"
down_revision = "0023"
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
        sa.Column("revoked_reason", sa.String(16)),
        sa.Column("ip", sa.String(64)),
        sa.Column("user_agent", sa.String(255)),
    )
    op.alter_column("admin_audit", "actor_id", existing_type=sa.Integer, nullable=True)
    op.add_column("two_factor_secrets", sa.Column("last_step", sa.BigInteger))


def downgrade() -> None:
    op.drop_column("two_factor_secrets", "last_step")
    op.execute("DELETE FROM admin_audit WHERE actor_id IS NULL")
    op.alter_column("admin_audit", "actor_id", existing_type=sa.Integer, nullable=False)
    op.drop_table("admin_sessions")
