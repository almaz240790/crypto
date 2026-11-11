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

import re
from typing import Any, Protocol

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from app.config import settings

STAFF_ROLES = frozenset({"admin", "owner"})
"""Кто видит сигналы, пока они закрыты."""

SIGNAL_COMPONENTS = frozenset({"engine", "tracker"})
"""Компоненты монитора (``app.monitor``), которые есть только у сигналов."""

_RANK = {"ok": 0, "degraded": 1, "down": 2}

SIGNAL_PATHS = frozenset(
    {
        "/v1/signals",
        "/v1/signals/summary",
        "/v1/stats",
        "/v1/stats/trades",
        "/v1/stats/export.csv",
        "/v1/stats/runs",
        "/v1/strategies",
    }
)
"""Закрытые адреса API (``app.routers.public``); карточка сигнала — :data:`_SIGNAL_CARD`."""

_SIGNAL_CARD = re.compile(r"^/v1/signals/[^/]+(?:/analysis|/candles)?$")

SCHEMA_SIGNAL_FIELDS: dict[str, tuple[str, ...]] = {
    "JournalIn": ("signal_id",),
    "NotificationsIn": ("email_signals", "push_signals"),
    "UserOut": ("signals",),
}
"""Поля публичных моделей, которые есть только у сигналов: из схемы ``/docs`` их убирает
:func:`scrub_signal_fields`, сами поля API принимает и отдаёт как раньше."""


class _HasRole(Protocol):
    role: str


def is_staff(user: _HasRole | None) -> bool:
    return user is not None and user.role in STAFF_ROLES


def signals_open(user: _HasRole | None) -> bool:
    """Видит ли пользователь (``None`` — без входа) сигналы, их статистику и версии стратегии."""
    return settings.signals_public or is_staff(user)


def is_signal_path(path: str) -> bool:
    """Адрес закрытого раздела сигналов (со слэшем в конце или без)."""
    bare = path.rstrip("/")
    return bare in SIGNAL_PATHS or _SIGNAL_CARD.match(bare) is not None


class HideClosedSignalRoutes:
    """Пока сигналы закрыты, их адреса неотличимы от несуществующих: на любой метод, кроме GET,
    и на адрес со слэшем в конце — 404 (без 405 «метод не разрешён» и 307 «без слэша»). GET без
    слэша решают сами эндпоинты: гостю и пользователю 404, admin и owner — данные. Предзапросы
    CORS (OPTIONS) отвечает ``CORSMiddleware`` снаружи, одинаково для всех адресов."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and not settings.signals_public:
            path, method = scope["path"], scope["method"]
            if is_signal_path(path) and (method != "GET" or path.endswith("/")):
                await JSONResponse({"detail": "Not Found"}, status_code=404)(scope, receive, send)
                return
        await self.app(scope, receive, send)


def scrub_signal_fields(schema: dict[str, Any]) -> dict[str, Any]:
    """Схема OpenAPI без полей сигналов (:data:`SCHEMA_SIGNAL_FIELDS`), пока они закрыты.
    Меняет словарь на месте и возвращает его."""
    models = schema.get("components", {}).get("schemas", {})
    for name, fields in SCHEMA_SIGNAL_FIELDS.items():
        model = models.get(name)
        if model is None:
            continue
        props = model.get("properties", {})
        for f in fields:
            props.pop(f, None)
        if "required" in model:
            model["required"] = [r for r in model["required"] if r not in fields]
    return schema


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
