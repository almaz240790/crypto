"""Разметка кандидатов фигур людьми (план 2A.10.2, раздел 7; задача 4B.2).

Revision ID: 0018
Revises: 0017
Create Date: 2026-10-27
"""

import sqlalchemy as sa
from alembic import op

revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "ml_labels",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "candidate_figure_id",
            sa.Integer,
            sa.ForeignKey("figures.id"),
            nullable=False,
            index=True,
        ),
        sa.Column("labeler_id", sa.Integer, sa.ForeignKey("users.id"), nullable=False, index=True),
        sa.Column("label", sa.String(12), nullable=False),
        sa.Column("figure_type", sa.String(24)),
        sa.Column("labeled_at", TS, nullable=False, server_default=sa.func.now()),
        sa.Column("time_spent_s", sa.Integer, nullable=False, server_default="0"),
        sa.UniqueConstraint("candidate_figure_id", "labeler_id", name="uq_ml_labels_once"),
        sa.CheckConstraint("label in ('figure','not_figure','unsure')", name="ck_ml_labels_label"),
    )


def downgrade() -> None:
    op.drop_table("ml_labels")
