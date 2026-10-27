"""Синхронизация рисунков (план 2A.5, задача 2B.7): последняя запись побеждает по ``updated_at``
(unix-мс клиента), удаление мягкое. ``resolve`` — чистая функция, применяется и на сервере, и
(в TypeScript) на клиенте, чтобы два устройства сходились к одному состоянию.
"""

from __future__ import annotations

from typing import Any

DrawingDict = dict[str, Any]


def resolve(server: DrawingDict | None, incoming: DrawingDict) -> DrawingDict:
    """Какая версия остаётся: с большим ``updated_at``; при равенстве — удаление сильнее."""
    if server is None:
        return incoming
    su, iu = int(server.get("updated_at", 0)), int(incoming.get("updated_at", 0))
    if iu > su:
        return incoming
    if iu < su:
        return server
    # равные метки: сохраняем удалённую версию, если хоть одна удалена
    return incoming if incoming.get("deleted_at") else server


def merge(server_items: list[DrawingDict], client_items: list[DrawingDict]) -> list[DrawingDict]:
    """Слияние двух списков по ``client_id`` правилом ``resolve``."""
    by_id: dict[str, DrawingDict] = {d["client_id"]: d for d in server_items}
    for d in client_items:
        by_id[d["client_id"]] = resolve(by_id.get(d["client_id"]), d)
    return sorted(by_id.values(), key=lambda d: int(d.get("updated_at", 0)))
