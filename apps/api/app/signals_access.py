"""Сигналы — только для владельца, пока не начаты продажи (ADR-0013).

Один выключатель — ``settings.signals_public`` (переменная ``SIGNALS_PUBLIC``, по умолчанию
выключен). Пока он выключен, всё о торговых сигналах видят только роли admin и owner:

- лента, карточка, анализ и свечи сигнала, статистика сигналов (live, форвард, бэктест, сделки,
  CSV, прогоны) и версии стратегии отвечают остальным 404 — как будто таких адресов нет
  (``app.routers.public.signals_viewer`` и ``signals_member``); слой сигналов на графике пуст;
- события сигналов в сокете уходят только клиентам admin и owner (``app.live``);
- письма и push о сигналах и дайджест получают только admin и owner; журнал остальных не
  сопоставляет сделки с сигналами и не сравнивает их с системой (``app.notify``,
  ``app.routers.user``);
- публичная статус-страница не показывает движок сигналов и трекер сделок
  (:func:`hide_signal_components`); в админке на вкладке «Система» они остаются.

Отработка паттернов и фигур (``/v1/stats/patterns``, ``/v1/stats/figures``), скринер и график —
не сигналы и открыты как раньше. Код сигналов не удалён, а закрыт: включённый выключатель
возвращает поведение, которое было до ADR-0013 (тесты API идут с включённым выключателем —
``tests/conftest.py``; матрица доступа с выключенным — ``tests/test_signals_access.py``).
"""

from __future__ import annotations

from typing import Any, Protocol

from app.config import settings

STAFF_ROLES = frozenset({"admin", "owner"})
"""Кто видит сигналы, пока они закрыты."""

SIGNAL_COMPONENTS = frozenset({"engine", "tracker"})
"""Компоненты монитора (``app.monitor``), которые есть только у сигналов."""

_RANK = {"ok": 0, "degraded": 1, "down": 2}


class _HasRole(Protocol):
    role: str


def is_staff(user: _HasRole | None) -> bool:
    return user is not None and user.role in STAFF_ROLES


def signals_open(user: _HasRole | None) -> bool:
    """Видит ли пользователь (``None`` — без входа) сигналы, их статистику и версии стратегии."""
    return settings.signals_public or is_staff(user)


def hide_signal_components(payload: dict[str, Any]) -> dict[str, Any]:
    """Публичный вид статус-страницы, пока сигналы закрыты: без строк движка сигналов и трекера,
    без их инцидентов; общий статус — по оставшимся компонентам (сбой движка, которого публика
    не видит, не красит ей страницу). Исходный словарь не меняется."""
    comps = [c for c in payload.get("components", []) if c.get("key") not in SIGNAL_COMPONENTS]
    incidents = [
        i for i in payload.get("incidents", []) if i.get("component") not in SIGNAL_COMPONENTS
    ]
    worst = max((_RANK.get(str(c.get("status")), 0) for c in comps), default=0)
    status = next(k for k, v in _RANK.items() if v == worst)
    return {**payload, "status": status, "components": comps, "incidents": incidents}
