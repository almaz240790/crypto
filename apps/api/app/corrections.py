"""Исправления исходов сигналов и разовые задания выкладки (задание «сигналы», задачи 7 и 10).

Лёгкий модуль для читателей (API, слой графика, уведомитель); само задание пересчёта — в
``app.retrack``.

- ``current_event`` — условие «событие не заменено исправлением» для выборок ``signal_events``:
  исходные строки не меняются, заменённые перечислены в ``signal_corrections``.
- ``job_done`` — завершено ли разовое задание выкладки (``deploy_jobs``).
- ``forward_notice_shown`` — показывать ли плашку над форвард-статистикой: она говорит, что
  старые результаты недействительны и пересчёт «в работе», поэтому после пересчёта форварда
  (``RETRACK_JOB``) снимается сама, без правки настроек на хостинге. ``FORWARD_NOTICE=false``
  выключает её и раньше.
"""

from __future__ import annotations

from sqlalchemy import ColumnElement, any_, exists
from sqlalchemy.orm import Session

from app.config import settings
from app.models import DeployJob, SignalCorrection, SignalEvent

RETRACK_JOB = "retrack-forward-2026-10-26"
"""Пересчёт форвард-сигналов, закрытых с ошибкой сроков (сделка через 15 минут вместо 60 часов)
или записанных без комиссий, — с 26.10.2026 (``app.retrack``)."""
VOIDED = "voided"
"""Статус сигнала «результат недействителен»: исход записан с ошибкой учёта и не пересчитан —
в статистику не входит (``app.stats.load_trades``)."""
CORRECTION_SOURCE = "retrack"
"""``signal_events.source`` событий, записанных исправлением. Уведомления по ним не уходят."""


def current_event() -> ColumnElement[bool]:
    """Условие на ``SignalEvent``: событие не заменено исправлением исхода."""
    return ~exists().where(
        SignalCorrection.signal_id == SignalEvent.signal_id,
        SignalEvent.id == any_(SignalCorrection.superseded_event_ids),
    )


def job_done(db: Session, name: str) -> bool:
    return db.get(DeployJob, name) is not None


def forward_notice_shown(db: Session) -> bool:
    """Плашка над форвард-статистикой: включена настройкой и форвард ещё не пересчитан."""
    return settings.forward_notice and not job_done(db, RETRACK_JOB)
