"""Исправления исходов форвард-сигналов (задание «сигналы», задачи 7 и 10; ADR-0012).

- ``signal_corrections`` — исправление записанного исхода сигнала: что было (статус, строка
  ``signal_results``, состояние трекера — архив), что стало, какие события заменены
  (``superseded_event_ids``) и событие-пояснение. Исходные строки ``signal_events`` не меняются
  и не удаляются; одно исправление на сигнал и задание (повторный запуск ничего не меняет).
- ``deploy_jobs`` — отметка о завершении разового задания выкладки (пересчёт форварда при старте
  трекера). По ней API снимает плашку над форвард-статистикой.
- Новый статус сигнала ``voided`` (результат недействителен, в статистику не входит) и типы
  событий ``corrected`` и ``voided`` (пояснение исправления).

Откат возвращает сигналам прежний статус, строки ``signal_results`` и ``signal_tracking`` из
архива, удаляет события исправления (``source = 'retrack'``) и обе таблицы.

Revision ID: 0026
Revises: 0025
Create Date: 2026-11-10
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import ARRAY, JSONB

revision = "0026"
down_revision = "0025"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)
_STATUSES = (
    "'pending','active','tp1_hit','tp2_hit','closed_tp3','closed_be',"
    "'closed_sl','closed_time','expired','cancelled'"
)
_EVENTS = "'created','activated','tp1','tp2','tp3','be','sl','time_stop','expired','cancelled'"


def _checks(statuses: str, events: str) -> None:
    op.drop_constraint("ck_signals_status", "signals", type_="check")
    op.create_check_constraint("ck_signals_status", "signals", f"status in ({statuses})")
    op.drop_constraint("ck_signal_events_type", "signal_events", type_="check")
    op.create_check_constraint("ck_signal_events_type", "signal_events", f"type in ({events})")


def upgrade() -> None:
    _checks(_STATUSES + ",'voided'", _EVENTS + ",'corrected','voided'")
    op.create_table(
        "signal_corrections",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("signal_id", sa.Integer, sa.ForeignKey("signals.id"), nullable=False),
        sa.Column("job", sa.String(64), nullable=False),
        sa.Column("kind", sa.String(8), nullable=False),
        sa.Column("status_before", sa.String(16), nullable=False),
        sa.Column("status_after", sa.String(16), nullable=False),
        sa.Column("result_before", JSONB),
        sa.Column("result_after", JSONB),
        sa.Column("tracking_before", JSONB),
        sa.Column(
            "superseded_event_ids",
            ARRAY(sa.Integer),
            nullable=False,
            server_default=sa.text("'{}'::integer[]"),
        ),
        sa.Column("note_event_id", sa.Integer, sa.ForeignKey("signal_events.id")),
        sa.Column("note", sa.Text, nullable=False),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("signal_id", "job", name="uq_signal_corrections_signal_job"),
        sa.CheckConstraint("kind in ('retrack','fees','void')", name="ck_signal_corrections_kind"),
    )
    op.create_index("ix_signal_corrections_signal_id", "signal_corrections", ["signal_id"])
    op.create_table(
        "deploy_jobs",
        sa.Column("name", sa.String(64), primary_key=True),
        sa.Column("completed_at", TS, nullable=False),
        sa.Column("summary", JSONB, nullable=False, server_default="{}"),
    )


def downgrade() -> None:
    # первое исправление по сигналу — состояние до задания
    first = "SELECT DISTINCT ON (signal_id) * FROM signal_corrections ORDER BY signal_id, id"
    op.execute(
        f"UPDATE signals s SET status = c.status_before FROM ({first}) c WHERE c.signal_id = s.id"
    )
    op.execute(
        "DELETE FROM signal_results r USING signal_corrections c WHERE r.signal_id = c.signal_id"
    )
    op.execute(
        "INSERT INTO signal_results SELECT (jsonb_populate_record(NULL::signal_results, "
        f"c.result_before)).* FROM ({first}) c WHERE c.result_before IS NOT NULL"
    )
    op.execute(
        "DELETE FROM signal_tracking t USING signal_corrections c WHERE t.signal_id = c.signal_id"
    )
    op.execute(
        "INSERT INTO signal_tracking SELECT (jsonb_populate_record(NULL::signal_tracking, "
        f"c.tracking_before)).* FROM ({first}) c WHERE c.tracking_before IS NOT NULL"
    )
    op.drop_table("deploy_jobs")
    op.drop_index("ix_signal_corrections_signal_id", table_name="signal_corrections")
    op.drop_table("signal_corrections")
    op.execute("DELETE FROM signal_events WHERE source = 'retrack'")
    _checks(_STATUSES, _EVENTS)
