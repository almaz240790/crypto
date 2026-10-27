"""Журнал запросов к LLM: стоимость, кэш, постпроверка (этап 2B.14).

Revision ID: 0016
Revises: 0015
Create Date: 2026-10-27
"""

import sqlalchemy as sa
from alembic import op

revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "llm_requests",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id"), index=True),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("model", sa.String(48), nullable=False),
        sa.Column("prompt_version", sa.String(32), nullable=False),
        sa.Column("cache_key", sa.String(120)),
        sa.Column("input_tokens", sa.Integer, nullable=False, server_default="0"),
        sa.Column("output_tokens", sa.Integer, nullable=False, server_default="0"),
        sa.Column("cost_usd", sa.Numeric(10, 6), nullable=False, server_default="0"),
        sa.Column("outcome", sa.String(12), nullable=False),
        sa.Column("latency_ms", sa.Integer),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now(), index=True),
        sa.CheckConstraint(
            "outcome in ('ok','rejected','error','budget','refusal')", name="ck_llm_outcome"
        ),
    )


def downgrade() -> None:
    op.drop_table("llm_requests")
