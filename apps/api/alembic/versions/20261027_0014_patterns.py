"""Свечные паттерны: версии правил, отметки, события, отработка, агрегаты (этап 2B.11).

Revision ID: 0014
Revises: 0013
Create Date: 2026-10-27
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)
ATR = sa.Numeric(18, 6)


def upgrade() -> None:
    op.create_table(
        "pattern_rules_versions",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("version", sa.String(32), nullable=False, unique=True),
        sa.Column("rules", postgresql.JSONB, nullable=False, server_default="{}"),
        sa.Column("changelog", sa.String(500)),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.Column("created_by", sa.Integer, sa.ForeignKey("users.id")),
    )
    op.create_table(
        "patterns",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "instrument_id", sa.Integer, sa.ForeignKey("instruments.id"), nullable=False, index=True
        ),
        sa.Column("timeframe", sa.String(4), nullable=False),
        sa.Column("type", sa.String(24), nullable=False),
        sa.Column("direction", sa.String(4)),
        sa.Column("status", sa.String(20), nullable=False, server_default="confirmed"),
        sa.Column("start_time", TS, nullable=False),
        sa.Column("confirm_time", TS, nullable=False),
        sa.Column("candle_close_time", TS, nullable=False, index=True),
        sa.Column("geometry", postgresql.JSONB, nullable=False, server_default="{}"),
        sa.Column("quality_score", sa.Numeric(6, 4)),
        sa.Column("context", postgresql.JSONB, nullable=False, server_default="{}"),
        sa.Column("is_significant", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column(
            "rules_version_id",
            sa.Integer,
            sa.ForeignKey("pattern_rules_versions.id"),
            nullable=False,
        ),
        sa.Column("ml_model_id", sa.Integer),
        sa.Column("ml_probability", sa.Numeric(6, 4)),
        sa.Column("source", sa.String(8), nullable=False, server_default="live"),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint(
            "instrument_id",
            "timeframe",
            "type",
            "candle_close_time",
            "rules_version_id",
            name="uq_patterns_candle",
        ),
        sa.CheckConstraint("status in ('confirmed','outcome_recorded')", name="ck_patterns_status"),
        sa.CheckConstraint("source in ('backfill','live')", name="ck_patterns_source"),
    )
    op.create_index(
        "ix_patterns_instrument_tf_time",
        "patterns",
        ["instrument_id", "timeframe", "candle_close_time"],
    )
    op.execute(
        """
        CREATE FUNCTION patterns_immutable() RETURNS trigger AS $$
        BEGIN
            IF NEW.type IS DISTINCT FROM OLD.type
               OR NEW.direction IS DISTINCT FROM OLD.direction
               OR NEW.start_time IS DISTINCT FROM OLD.start_time
               OR NEW.confirm_time IS DISTINCT FROM OLD.confirm_time
               OR NEW.candle_close_time IS DISTINCT FROM OLD.candle_close_time
               OR NEW.geometry IS DISTINCT FROM OLD.geometry
               OR NEW.context IS DISTINCT FROM OLD.context
               OR NEW.is_significant IS DISTINCT FROM OLD.is_significant
               OR NEW.rules_version_id IS DISTINCT FROM OLD.rules_version_id THEN
                RAISE EXCEPTION 'подтверждённый паттерн не меняется: только status через pattern_events';
            END IF;
            RETURN NEW;
        END $$ LANGUAGE plpgsql;
        """
    )
    op.execute(
        "CREATE TRIGGER trg_patterns_immutable BEFORE UPDATE ON patterns "
        "FOR EACH ROW EXECUTE FUNCTION patterns_immutable()"
    )
    op.create_table(
        "pattern_events",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "pattern_id", sa.Integer, sa.ForeignKey("patterns.id"), nullable=False, index=True
        ),
        sa.Column("type", sa.String(24), nullable=False),
        sa.Column("occurred_at", TS, nullable=False),
        sa.Column("details", postgresql.JSONB, nullable=False, server_default="{}"),
    )
    op.create_table(
        "pattern_outcomes",
        sa.Column("pattern_id", sa.Integer, sa.ForeignKey("patterns.id"), primary_key=True),
        sa.Column("horizon_bars", sa.Integer, primary_key=True),
        sa.Column("moved_expected", sa.Boolean),
        sa.Column("move_atr_favorable", ATR),
        sa.Column("move_atr_adverse", ATR),
        sa.Column("target_hit", sa.Boolean),
        sa.Column("evaluated_at", TS, nullable=False, server_default=sa.func.now()),
    )
    op.create_table(
        "pattern_stats_snapshots",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("type", sa.String(24), nullable=False, index=True),
        sa.Column("timeframe", sa.String(4), nullable=False),
        sa.Column("instrument_id", sa.Integer, sa.ForeignKey("instruments.id")),
        sa.Column("with_context", sa.Boolean),
        sa.Column("scope", sa.String(8), nullable=False),
        sa.Column("horizon_bars", sa.Integer, nullable=False),
        sa.Column("year", sa.Integer),
        sa.Column("period_start", TS),
        sa.Column("period_end", TS),
        sa.Column("n", sa.Integer, nullable=False),
        sa.Column("success_rate", sa.Numeric(6, 4)),
        sa.Column("ci_low", sa.Numeric(6, 4)),
        sa.Column("ci_high", sa.Numeric(6, 4)),
        sa.Column("avg_move_atr", ATR),
        sa.Column("avg_adverse_atr", ATR),
        sa.Column("computed_at", TS, nullable=False, server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("pattern_stats_snapshots")
    op.drop_table("pattern_outcomes")
    op.drop_table("pattern_events")
    op.execute("DROP TRIGGER IF EXISTS trg_patterns_immutable ON patterns")
    op.execute("DROP FUNCTION IF EXISTS patterns_immutable")
    op.drop_index("ix_patterns_instrument_tf_time", table_name="patterns")
    op.drop_table("patterns")
    op.drop_table("pattern_rules_versions")
