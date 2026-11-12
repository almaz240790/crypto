"""Признак ``signals.published``: строка — опубликованный сигнал, а не кандидат для анализа.

Движок отдаёт и кандидатов, которые не публикуются: ниже порога публикации (``Grade.NONE`` —
«сохраняется для анализа, но не показывается») и отложенные из-за новостей высокой важности
(план 2.5: «помечаются „отложен“»). Их пишет ``forward.write_candidate`` с пометками
``rationale_facts.publishable`` / ``rationale_facts.deferred``, но читатели — лента, карточка,
статистика, письма и push, трекер — пометок не смотрели: такие кандидаты рассылались, велись и
считались как обычные сигналы (кандидат ниже порога — с градацией C).

Столбец вычисляемый (``GENERATED ALWAYS … STORED``) из ``rationale_facts``, которые неизменяемы
после публикации (триггер ``signals_trade_fields_immutable``): у существующих строк он заполняется
сам, вставить или изменить его нельзя, расходиться с пометками он не может. Строка без пометок
(записанная до них) — опубликованный сигнал, как и раньше.

Откат удаляет столбец.

Revision ID: 0026
Revises: 0025
Create Date: 2026-11-12
"""

import sqlalchemy as sa
from alembic import op

revision = "0026"
down_revision = "0025"
branch_labels = None
depends_on = None

PUBLISHED_SQL = (
    "coalesce((rationale_facts ->> 'publishable')::boolean, true) "
    "AND NOT coalesce((rationale_facts ->> 'deferred')::boolean, false)"
)
"""Опубликован ли сигнал — то же выражение, что в модели ``app.models.Signal.published``."""


def upgrade() -> None:
    op.add_column(
        "signals",
        sa.Column(
            "published", sa.Boolean, sa.Computed(PUBLISHED_SQL, persisted=True), nullable=False
        ),
    )


def downgrade() -> None:
    op.drop_column("signals", "published")
