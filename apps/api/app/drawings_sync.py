"""Синхронизация рисунков (план 2A.5, задача 2B.7): последняя запись побеждает по ``updated_at``
(unix-мс клиента), удаление мягкое. ``resolve`` — чистая функция, применяется и на сервере, и
(в TypeScript) на клиенте, чтобы два устройства сходились к одному состоянию.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import Any

DrawingDict = dict[str, Any]

# Уровни Фибоначчи (план 2A.5; ADR-0009, «Рисование», дополнение 2026-11-11). Границы — те же, что
# у клиента (packages/charts, normalizeFibLevels): клиент всегда присылает уже приведённый набор.
FIB_LEVELS_MAX = 24
FIB_LEVEL_LIMIT = 10.0
FIB_LEVEL_DECIMALS = 3


def fib_levels(kind: str, levels: Sequence[float] | None) -> list[float] | None:
    """Уровни рисунка, как они хранятся: только у Фибоначчи, по возрастанию, без повторов, 3 знака.

    У остальных типов уровней нет — присланные не хранятся (запись — пакетная офлайн-очередь
    клиента: отказ из-за лишнего поля остановил бы всю очередь). ``None`` и пустой список — «уровни
    по умолчанию» (клиент рисует свой стандартный набор). Больше ``FIB_LEVELS_MAX`` значений, не
    число (NaN, бесконечность) или значение вне ±``FIB_LEVEL_LIMIT`` — ``ValueError``: такой набор
    клиент прислать не может, это ошибка запроса.
    """
    if kind != "fib" or levels is None:
        return None
    if len(levels) > FIB_LEVELS_MAX:
        raise ValueError(f"уровней Фибоначчи — не больше {FIB_LEVELS_MAX}")
    scale = 10**FIB_LEVEL_DECIMALS
    out: set[float] = set()
    for v in levels:
        if not math.isfinite(v) or abs(v) > FIB_LEVEL_LIMIT:
            raise ValueError("уровень Фибоначчи — число от −10 до 10")
        # округление как у Math.round клиента (половина — вверх); + 0.0 — «−0.0» хранится нулём
        out.add(math.floor(v * scale + 0.5) / scale + 0.0)
    return sorted(out) or None


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
