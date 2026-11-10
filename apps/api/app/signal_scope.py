"""Область сигнала: forward или live (план 2.11, правило 5 — «смешивать запрещено»).

Область пишется в ``signals.scope`` при публикации из статуса версии стратегии в этот момент и
дальше не меняется (триггер БД, миграция 0022). Все читатели — лента, карточка, анализ,
статистика и её снимки, CSV, уведомления, журнал, слой графика — берут область отсюда, а не из
текущего статуса версии. Поэтому:
- перевод версии forward → live не делает её прошлые форвард-сигналы live-сигналами, а по
  открытым форвард-сигналам такой версии уведомления не уходят;
- возврат live → forward (замена live-версии) не убирает её live-историю: live — это все
  сигналы со ``scope = 'live'``, в том числе версий, которые потом ушли в forward или archived
  (план 2.11, правило 4 — публикуется полная история);
- форвард по явной версии — вся её форвард-история, даже если версия уже archived или live.
"""

from __future__ import annotations

from sqlalchemy import ColumnElement, and_, select

from app.models import Signal, StrategyVersion
from app.models.signals import SIGNAL_SCOPES

FORWARD_DEFAULT_VERSION_STATUSES = ("forward", "live")
"""Чья форвард-история входит в форвард без явной версии: версий, которые сейчас в форварде или
в live. Форвард-сигналы архивных версий и версий, возвращённых в backtest, — только по явной
версии. Выбор одной версии по умолчанию для форварда — задача 2 пакета."""


def scope_at_publication(version_status: str) -> str | None:
    """Область нового сигнала по статусу версии в момент записи. ``None`` — версия сейчас
    сигналы не публикует (backtest, archived), кандидат не пишется."""
    return version_status if version_status in SIGNAL_SCOPES else None


def scope_filter(scope: str, strategy_version_id: int | None = None) -> ColumnElement[bool]:
    """Условие на ``Signal`` для выборки области ``scope`` (ORM-запросы)."""
    if scope not in SIGNAL_SCOPES:
        raise ValueError(f"неизвестная область сигнала: {scope}")
    cond = Signal.scope == scope
    if strategy_version_id is not None:
        return and_(cond, Signal.strategy_version_id == strategy_version_id)
    if scope == "forward":
        return and_(
            cond,
            Signal.strategy_version_id.in_(
                select(StrategyVersion.id).where(
                    StrategyVersion.status.in_(FORWARD_DEFAULT_VERSION_STATUSES)
                )
            ),
        )
    return cond
