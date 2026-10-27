"""Графические фигуры: отметки, события, отработка, агрегаты (этап 4B.6).

Revision ID: 0017
Revises: 0016
Create Date: 2026-10-27
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)
PRICE = sa.Numeric(24, 10)
ATR = sa.Numeric(18, 6)


def upgrade() -> None:
    op.create_table(
        "figures",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "instrument_id", sa.Integer, sa.ForeignKey("instruments.id"), nullable=False, index=True
        ),
        sa.Column("timeframe", sa.String(4), nullable=False),
        sa.Column("type", sa.String(24), nullable=False),
        sa.Column("direction", sa.String(4)),
        sa.Column("status", sa.String(12), nullable=False),
        sa.Column("scale", sa.Integer, nullable=False),
        sa.Column("start_time", TS, nullable=False),
        sa.Column("end_time", TS, nullable=False),
        sa.Column("known_time", TS, nullable=False),
        sa.Column("confirm_time", TS),
        sa.Column("invalidated_time", TS),
        sa.Column("geometry", postgresql.JSONB, nullable=False, server_default="{}"),
        sa.Column("breakout_level", PRICE),
        sa.Column("target", PRICE),
        sa.Column("invalidation", PRICE),
        sa.Column("quality", sa.Numeric(6, 4), nullable=False),
        sa.Column("metrics", postgresql.JSONB, nullable=False, server_default="{}"),
        sa.Column("rules_version", sa.String(32), nullable=False),
        sa.Column("source", sa.String(8), nullable=False, server_default="live"),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", TS, nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint(
            "instrument_id",
            "timeframe",
            "type",
            "start_time",
            "end_time",
            "rules_version",
            name="uq_figures_geometry",
        ),
        sa.CheckConstraint(
            "status in ('forming','confirmed','invalidated')", name="ck_figures_status"
        ),
    )
    op.create_index(
        "ix_figures_instrument_tf_end", "figures", ["instrument_id", "timeframe", "end_time"]
    )
    op.execute(
        """
        CREATE FUNCTION figures_immutable() RETURNS trigger AS $$
        BEGIN
            IF OLD.status <> 'forming' AND (
               NEW.geometry IS DISTINCT FROM OLD.geometry
               OR NEW.confirm_time IS DISTINCT FROM OLD.confirm_time
               OR NEW.breakout_level IS DISTINCT FROM OLD.breakout_level
               OR NEW.target IS DISTINCT FROM OLD.target
               OR NEW.status IS DISTINCT FROM OLD.status) THEN
                RAISE EXCEPTION 'подтверждённая фигура не меняется (план 2A.10.4)';
            END IF;
            RETURN NEW;
        END $$ LANGUAGE plpgsql;
        """
    )
    op.execute(
        "CREATE TRIGGER trg_figures_immutable BEFORE UPDATE ON figures "
        "FOR EACH ROW EXECUTE FUNCTION figures_immutable()"
    )
    op.create_table(
        "figure_events",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("figure_id", sa.Integer, sa.ForeignKey("figures.id"), nullable=False, index=True),
        sa.Column("type", sa.String(24), nullable=False),
        sa.Column("occurred_at", TS, nullable=False),
        sa.Column("details", postgresql.JSONB, nullable=False, server_default="{}"),
    )
    op.create_table(
        "figure_outcomes",
        sa.Column("figure_id", sa.Integer, sa.ForeignKey("figures.id"), primary_key=True),
        sa.Column("horizon_bars", sa.Integer, nullable=False),
        sa.Column("target_hit", sa.Boolean),
        sa.Column("invalidation_hit", sa.Boolean),
        sa.Column("move_atr_favorable", ATR),
        sa.Column("move_atr_adverse", ATR),
        sa.Column("bars_to_target", sa.Integer),
        sa.Column("evaluated_at", TS, nullable=False, server_default=sa.func.now()),
    )
    op.create_table(
        "figure_stats_snapshots",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("type", sa.String(24), nullable=False, index=True),
        sa.Column("timeframe", sa.String(4), nullable=False),
        sa.Column("scope", sa.String(8), nullable=False),
        sa.Column("year", sa.Integer),
        sa.Column("n", sa.Integer, nullable=False),
        sa.Column("success_rate", sa.Numeric(6, 4)),
        sa.Column("ci_low", sa.Numeric(6, 4)),
        sa.Column("ci_high", sa.Numeric(6, 4)),
        sa.Column("avg_move_atr", ATR),
        sa.Column("avg_adverse_atr", ATR),
        sa.Column("avg_bars_to_target", sa.Numeric(8, 2)),
        sa.Column("computed_at", TS, nullable=False, server_default=sa.func.now()),
    )
    op.execute("ALTER TABLE alerts DROP CONSTRAINT IF EXISTS ck_alerts_type")
    op.create_check_constraint(
        "ck_alerts_type",
        "alerts",
        "type in ('price','indicator','zone','structure','pattern','figure')",
    )


def downgrade() -> None:
    op.execute("ALTER TABLE alerts DROP CONSTRAINT IF EXISTS ck_alerts_type")
    op.create_check_constraint(
        "ck_alerts_type", "alerts", "type in ('price','indicator','zone','structure','pattern')"
    )
    op.drop_table("figure_stats_snapshots")
    op.drop_table("figure_outcomes")
    op.drop_table("figure_events")
    op.execute("DROP TRIGGER IF EXISTS trg_figures_immutable ON figures")
    op.execute("DROP FUNCTION IF EXISTS figures_immutable")
    op.drop_index("ix_figures_instrument_tf_end", table_name="figures")
    op.drop_table("figures")
