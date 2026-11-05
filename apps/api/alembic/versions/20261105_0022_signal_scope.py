"""Область сигнала ``signals.scope`` (forward | live) фиксируется при публикации (план 2.11, правило 5).

До этой миграции область сигнала определялась текущим статусом версии стратегии. При выпуске
версии в live её форвард-история задним числом стала бы live-историей, а при замене live-версии
live-история ушла бы в forward. Теперь область пишется в сигнал при вставке и дальше не меняется:
столбец добавлен в список неизменяемых полей триггера ``signals_trade_fields_immutable``.

Заполнение существующих строк: все сигналы — ``forward``. Это верно, только если ни одна версия
никогда не была в live. Миграция сначала проверяет это по трём источникам:
- ``strategy_versions``: нет версии в статусе live и ни у одной не заполнен ``activated_at``
  (его ставит только подтверждение заявки в live, ``admin.decide_status_request``);
- ``status_change_requests``: нет применённой заявки с переходом в live;
- ``admin_audit``: нет записи ``version.status`` с переходом в live.
Если след live найден, миграция останавливается с ошибкой: область таких сигналов человек
определяет вручную (см. текст ошибки). Смену статуса прямым ``UPDATE`` в БД без заявки и аудита
проверка не увидит; код такого пути не содержит.

Откат удаляет столбец и возвращает прежнюю функцию триггера. Если в БД уже есть live-сигналы,
откат останавливается: без столбца их область восстановить нельзя.

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

SCOPES = ("forward", "live")
BACKFILL_SCOPE = "forward"

# Торговые поля из миграции 0001: порядок и состав те же, чтобы откат вернул функцию как была.
TRADE_FIELDS = (
    "direction",
    "candle_close_time",
    "entry_market",
    "entry_limit",
    "stop_loss",
    "tp1",
    "tp2",
    "tp3",
    "rr_tp2",
    "score",
    "grade",
    "score_breakdown",
    "rationale_facts",
    "input_hash",
    "strategy_version_id",
    "instrument_id",
    "created_at",
)


def _trigger_function(fields: tuple[str, ...]) -> str:
    cond = "\n               OR ".join(f"NEW.{f} IS DISTINCT FROM OLD.{f}" for f in fields)
    return f"""
        CREATE OR REPLACE FUNCTION signals_trade_fields_immutable() RETURNS trigger AS $$
        BEGIN
            IF {cond}
            THEN
                RAISE EXCEPTION 'торговые поля signals неизменяемы после публикации';
            END IF;
            RETURN NEW;
        END $$ LANGUAGE plpgsql;
        """


def live_traces(conn: sa.Connection) -> list[str]:
    """Следы того, что какая-либо версия была в live. Пустой список — live не было никогда."""
    out: list[str] = []
    for vid, version, status, activated_at in conn.execute(
        sa.text(
            "select id, version, status, activated_at from strategy_versions "
            "where status = 'live' or activated_at is not null order by id"
        )
    ).all():
        out.append(
            f"strategy_versions id={vid} ({version}): status={status}, activated_at={activated_at}"
        )
    for rid, vid, decided_at in conn.execute(
        sa.text(
            "select id, strategy_version_id, decided_at from status_change_requests "
            "where to_status = 'live' and decision = 'applied' order by id"
        )
    ).all():
        out.append(
            f"status_change_requests id={rid}: версия id={vid} переведена в live {decided_at}"
        )
    for aid, target, created_at in conn.execute(
        sa.text(
            "select id, target, created_at from admin_audit "
            "where action = 'version.status' and payload->>'to' = 'live' order by id"
        )
    ).all():
        out.append(f"admin_audit id={aid}: {target} → live {created_at}")
    return out


def upgrade() -> None:
    conn = op.get_bind()
    traces = live_traces(conn)
    if traces:
        raise RuntimeError(
            "Миграция 0022 остановлена: найдены следы того, что версия стратегии была в live.\n"
            + "\n".join(f"  - {t}" for t in traces)
            + "\nЗаполнить signals.scope = 'forward' для всех сигналов нельзя: часть из них могла "
            "быть опубликована как live. Нужно решение человека: по датам перевода в live и "
            "обратно (admin_audit) определить, какие сигналы версии опубликованы, пока она была "
            "live, и заполнить область вручную отдельным скриптом (план 2.11, правило 5)."
        )
    op.add_column("signals", sa.Column("scope", sa.String(8), nullable=True))
    # заполнение до замены функции триггера: прежняя функция scope не проверяет
    op.execute(
        sa.text("UPDATE signals SET scope = :scope WHERE scope IS NULL").bindparams(
            scope=BACKFILL_SCOPE
        )
    )
    op.alter_column("signals", "scope", nullable=False)
    op.create_check_constraint(
        "ck_signals_scope", "signals", "scope in (" + ",".join(f"'{s}'" for s in SCOPES) + ")"
    )
    op.execute(_trigger_function((*TRADE_FIELDS, "scope")))


def downgrade() -> None:
    conn = op.get_bind()
    live = conn.execute(sa.text("select count(*) from signals where scope = 'live'")).scalar_one()
    if live:
        raise RuntimeError(
            f"Откат 0022 остановлен: в signals {live} live-сигналов. Без столбца scope их "
            "область восстановить нельзя (план 2.11, правило 5). Сначала сохраните "
            "public_id и scope этих сигналов, затем решите, нужен ли откат."
        )
    op.execute(_trigger_function(TRADE_FIELDS))
    op.drop_constraint("ck_signals_scope", "signals", type_="check")
    op.drop_column("signals", "scope")
