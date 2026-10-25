"""Схема этапа 0: инструменты, свечи (hypertable), стратегии, сигналы, события, результаты.

Инварианты (план, раздел 7):
- signals: торговые поля неизменяемы после вставки (триггер);
- strategy_versions.params неизменяемы после создания (триггер).

Revision ID: 0001
Revises:
Create Date: 2026-10-25
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

PRICE = sa.Numeric(24, 10)
QTY = sa.Numeric(28, 10)
R = sa.Numeric(8, 3)
TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS timescaledb")

    op.create_table(
        "instruments",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("exchange", sa.String(16), nullable=False),
        sa.Column("symbol", sa.String(32), nullable=False),
        sa.Column("base", sa.String(16), nullable=False),
        sa.Column("quote", sa.String(16), nullable=False),
        sa.Column("market_type", sa.String(8), nullable=False),
        sa.Column("tick_size", PRICE, nullable=False),
        sa.Column("lot_size", QTY, nullable=False),
        sa.Column("min_notional", PRICE, nullable=False, server_default="0"),
        sa.Column("is_active", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("avg_volume_30d", PRICE),
        sa.Column("listed_at", TS),
        sa.Column("delisted_at", TS),
        sa.UniqueConstraint("exchange", "symbol", "market_type"),
        sa.CheckConstraint("market_type in ('spot','futures')", name="ck_instruments_market_type"),
    )

    op.create_table(
        "candles",
        sa.Column("instrument_id", sa.Integer, sa.ForeignKey("instruments.id"), nullable=False),
        sa.Column("timeframe", sa.String(4), nullable=False),
        sa.Column("open_time", TS, nullable=False),
        sa.Column("open", PRICE, nullable=False),
        sa.Column("high", PRICE, nullable=False),
        sa.Column("low", PRICE, nullable=False),
        sa.Column("close", PRICE, nullable=False),
        sa.Column("volume", QTY, nullable=False),
        sa.Column("quote_volume", QTY, nullable=False, server_default="0"),
        sa.Column("trades", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("is_closed", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.PrimaryKeyConstraint("instrument_id", "timeframe", "open_time"),
        sa.CheckConstraint(
            "low <= open and open <= high and low <= close and close <= high",
            name="ck_candles_ohlc",
        ),
        sa.CheckConstraint(
            "timeframe in ('1m','5m','15m','1h','4h','1d','1w')", name="ck_candles_timeframe"
        ),
    )
    op.execute(
        "SELECT create_hypertable('candles', 'open_time', chunk_time_interval => INTERVAL '30 days', "
        "if_not_exists => TRUE)"
    )
    op.execute(
        "ALTER TABLE candles SET (timescaledb.compress, "
        "timescaledb.compress_segmentby = 'instrument_id, timeframe', "
        "timescaledb.compress_orderby = 'open_time')"
    )
    op.execute(
        "SELECT add_compression_policy('candles', INTERVAL '30 days', if_not_exists => TRUE)"
    )

    op.create_table(
        "strategies",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("slug", sa.String(64), nullable=False, unique=True),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("description_public", sa.Text, nullable=False, server_default=""),
    )

    op.create_table(
        "strategy_versions",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("strategy_id", sa.Integer, sa.ForeignKey("strategies.id"), nullable=False),
        sa.Column("version", sa.String(32), nullable=False),
        sa.Column("params", JSONB, nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="backtest"),
        sa.Column("created_by", sa.String(64)),
        sa.Column("approved_by", sa.String(64)),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.Column("activated_at", TS),
        sa.Column("changelog", sa.Text, nullable=False, server_default=""),
        sa.UniqueConstraint("strategy_id", "version"),
        sa.CheckConstraint(
            "status in ('backtest','forward','live','archived')", name="ck_strategy_versions_status"
        ),
    )
    op.execute(
        """
        CREATE FUNCTION strategy_versions_params_immutable() RETURNS trigger AS $$
        BEGIN
            IF NEW.params IS DISTINCT FROM OLD.params THEN
                RAISE EXCEPTION 'strategy_versions.params неизменяемы: создайте новую версию';
            END IF;
            RETURN NEW;
        END $$ LANGUAGE plpgsql;
        """
    )
    op.execute(
        "CREATE TRIGGER trg_strategy_versions_immutable BEFORE UPDATE ON strategy_versions "
        "FOR EACH ROW EXECUTE FUNCTION strategy_versions_params_immutable()"
    )

    op.create_table(
        "signals",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("public_id", sa.String(16), nullable=False, unique=True),
        sa.Column(
            "strategy_version_id", sa.Integer, sa.ForeignKey("strategy_versions.id"), nullable=False
        ),
        sa.Column("instrument_id", sa.Integer, sa.ForeignKey("instruments.id"), nullable=False),
        sa.Column("direction", sa.String(5), nullable=False),
        sa.Column("candle_close_time", TS, nullable=False),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.Column("entry_market", PRICE, nullable=False),
        sa.Column("entry_limit", PRICE),
        sa.Column("stop_loss", PRICE, nullable=False),
        sa.Column("tp1", PRICE, nullable=False),
        sa.Column("tp2", PRICE, nullable=False),
        sa.Column("tp3", PRICE, nullable=False),
        sa.Column("rr_tp2", R, nullable=False),
        sa.Column("score", sa.Integer, nullable=False),
        sa.Column("grade", sa.String(1), nullable=False),
        sa.Column("score_breakdown", JSONB, nullable=False, server_default="{}"),
        sa.Column("rationale_facts", JSONB, nullable=False, server_default="{}"),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("input_hash", sa.String(64), nullable=False),
        sa.Column("correlated_signal_id", sa.Integer, sa.ForeignKey("signals.id")),
        sa.Column("news_flag", sa.String(64)),
        sa.Column("session_label", sa.String(16)),
        sa.UniqueConstraint("strategy_version_id", "instrument_id", "candle_close_time"),
        sa.CheckConstraint("direction in ('long','short')", name="ck_signals_direction"),
        sa.CheckConstraint("grade in ('A','B','C')", name="ck_signals_grade"),
        sa.CheckConstraint("score between 0 and 100", name="ck_signals_score"),
        sa.CheckConstraint(
            "status in ('pending','active','tp1_hit','tp2_hit','closed_tp3','closed_be',"
            "'closed_sl','closed_time','expired','cancelled')",
            name="ck_signals_status",
        ),
    )
    op.create_index("ix_signals_status", "signals", ["status"])
    op.create_index("ix_signals_instrument_time", "signals", ["instrument_id", "candle_close_time"])
    op.execute(
        """
        CREATE FUNCTION signals_trade_fields_immutable() RETURNS trigger AS $$
        BEGIN
            IF NEW.direction IS DISTINCT FROM OLD.direction
               OR NEW.candle_close_time IS DISTINCT FROM OLD.candle_close_time
               OR NEW.entry_market IS DISTINCT FROM OLD.entry_market
               OR NEW.entry_limit IS DISTINCT FROM OLD.entry_limit
               OR NEW.stop_loss IS DISTINCT FROM OLD.stop_loss
               OR NEW.tp1 IS DISTINCT FROM OLD.tp1
               OR NEW.tp2 IS DISTINCT FROM OLD.tp2
               OR NEW.tp3 IS DISTINCT FROM OLD.tp3
               OR NEW.rr_tp2 IS DISTINCT FROM OLD.rr_tp2
               OR NEW.score IS DISTINCT FROM OLD.score
               OR NEW.grade IS DISTINCT FROM OLD.grade
               OR NEW.score_breakdown IS DISTINCT FROM OLD.score_breakdown
               OR NEW.rationale_facts IS DISTINCT FROM OLD.rationale_facts
               OR NEW.input_hash IS DISTINCT FROM OLD.input_hash
               OR NEW.strategy_version_id IS DISTINCT FROM OLD.strategy_version_id
               OR NEW.instrument_id IS DISTINCT FROM OLD.instrument_id
               OR NEW.created_at IS DISTINCT FROM OLD.created_at
            THEN
                RAISE EXCEPTION 'торговые поля signals неизменяемы после публикации';
            END IF;
            RETURN NEW;
        END $$ LANGUAGE plpgsql;
        """
    )
    op.execute(
        "CREATE TRIGGER trg_signals_immutable BEFORE UPDATE ON signals "
        "FOR EACH ROW EXECUTE FUNCTION signals_trade_fields_immutable()"
    )
    op.execute(
        """
        CREATE FUNCTION signals_no_delete() RETURNS trigger AS $$
        BEGIN
            RAISE EXCEPTION 'сигналы не удаляются: используйте статус cancelled с причиной';
        END $$ LANGUAGE plpgsql;
        """
    )
    op.execute(
        "CREATE TRIGGER trg_signals_no_delete BEFORE DELETE ON signals FOR EACH ROW EXECUTE FUNCTION signals_no_delete()"
    )

    op.create_table(
        "signal_events",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("signal_id", sa.Integer, sa.ForeignKey("signals.id"), nullable=False),
        sa.Column("type", sa.String(16), nullable=False),
        sa.Column("price", PRICE),
        sa.Column("occurred_at", TS, nullable=False),
        sa.Column("source", sa.String(16), nullable=False, server_default="tracker"),
        sa.Column("note", sa.Text),
        sa.CheckConstraint(
            "type in ('created','activated','tp1','tp2','tp3','be','sl','time_stop','expired','cancelled')",
            name="ck_signal_events_type",
        ),
    )
    op.create_index("ix_signal_events_signal_id", "signal_events", ["signal_id"])

    op.create_table(
        "signal_results",
        sa.Column("signal_id", sa.Integer, sa.ForeignKey("signals.id"), primary_key=True),
        sa.Column("realized_r", R, nullable=False),
        sa.Column("realized_r_tp1_only", R),
        sa.Column("realized_r_full_tp2", R),
        sa.Column("duration_hours", sa.Numeric(10, 2)),
        sa.Column("max_favorable_r", R),
        sa.Column("max_adverse_r", R),
        sa.Column("closed_at", TS, nullable=False),
        sa.Column("entry_type_used", sa.String(8), nullable=False, server_default="market"),
    )


def downgrade() -> None:
    op.drop_table("signal_results")
    op.drop_table("signal_events")
    op.execute("DROP TRIGGER IF EXISTS trg_signals_no_delete ON signals")
    op.execute("DROP TRIGGER IF EXISTS trg_signals_immutable ON signals")
    op.drop_table("signals")
    op.execute("DROP FUNCTION IF EXISTS signals_no_delete()")
    op.execute("DROP FUNCTION IF EXISTS signals_trade_fields_immutable()")
    op.execute("DROP TRIGGER IF EXISTS trg_strategy_versions_immutable ON strategy_versions")
    op.drop_table("strategy_versions")
    op.execute("DROP FUNCTION IF EXISTS strategy_versions_params_immutable()")
    op.drop_table("strategies")
    op.drop_table("candles")
    op.drop_table("instruments")
