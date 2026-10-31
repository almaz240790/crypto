"""HTTP-кэш ответов /v1/chart (план 2B.4): Cache-Control по варианту ответа, слабый ETag и 304.

Правила (таблица спецификации «Данные графика: API»). Свежесть общего кэша (edge) и
``stale-while-revalidate`` уходят только в ``CDN-Cache-Control`` (RFC 9213): Cloudflare его
читает, браузер — нет. Браузеру — ``Cache-Control: public, max-age=0, must-revalidate``: каждый
повтор идёт на сервер с If-None-Match и получает 304 или свежие данные, устаревший ответ из
своего кэша браузер не отдаёт (иначе после смены таймфрейма текущая свеча теряла бы минуты).

- свечи ТФ ≥ 1h без ``before`` — edge 10 с + 30 с stale;
- свечи ТФ ≥ 1h с ``before`` в прошлом — история, не меняется: браузер 1 ч, edge сутки
  (единственный вариант, где браузер берёт ответ из кэша без запроса);
- свечи 1m/5m/15m зависят от тарифа — ``private, no-store``;
- layers ``view=chart`` — только структура, от пользователя не зависит — edge 30 с + 60 с;
- layers без ``view`` содержат сигналы по правам пользователя — ``private, no-cache``;
- signals — ``private, no-store``;
- found, patterns, figures — edge 60 с + 300 с; derivatives — 30 с + 60 с;
- любая ошибка (4xx/5xx) — ``no-store``; любой ответ под ``/v1/chart`` без своего Cache-Control
  (раскладки ``/v1/chart/layout(s)``, POST) — ``private, no-store`` (middleware
  :class:`NoStoreByDefault`): общий кэш не сохранит то, что не помечено публичным явно.

ETag считается по телу без изменчивых полей (``server_time``, ``structure.at``): 304 означает
«данные те же». Время сервера клиент берёт из заголовка ``Date``. Edge-кэш Cloudflare требует
Cache Rule только для публичных эндпоинтов ``/v1/chart/{candles,layers,patterns,figures,found,
derivatives}`` (eligible, respect origin, query string в ключе) — это настройка production, её
включает владелец (план 10.4). Без правила заголовки дают браузерный кэш истории и 304.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from fastapi import Request, Response
from fastapi.encoders import jsonable_encoder
from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send


@dataclass(frozen=True, slots=True)
class Policy:
    """Политика кэша ответа: ``Cache-Control`` (браузер и все кэши) и ``CDN-Cache-Control``
    (только CDN; ``None`` — CDN следует ``Cache-Control``)."""

    cache_control: str
    cdn: str | None = None


REVALIDATE = "public, max-age=0, must-revalidate"
"""Браузер хранит ответ, но перед каждым использованием переспрашивает (304)."""

CANDLES_LATEST = Policy(REVALIDATE, "max-age=10, stale-while-revalidate=30")
CANDLES_HISTORY = Policy("public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400")
LAYERS_CHART = Policy(REVALIDATE, "max-age=30, stale-while-revalidate=60")
OBJECTS = Policy(REVALIDATE, "max-age=60, stale-while-revalidate=300")
"""found, patterns, figures."""
DERIVATIVES = Policy(REVALIDATE, "max-age=30, stale-while-revalidate=60")
PRIVATE_NO_CACHE = Policy("private, no-cache")
"""Зависит от пользователя, но можно переспросить с If-None-Match (layers без view)."""
PRIVATE_NO_STORE = Policy("private, no-store")
"""Зависит от прав пользователя: внутридневные свечи, сигналы; и всё без явной политики."""
NO_STORE = "no-store"
"""Ошибки."""

VOLATILE = ("server_time", "structure.at")
"""Поля (путь через точку), которые не входят в ETag: меняются на каждый запрос или пересчёт
слоёв (``structure.at`` — время расчёта), данных не меняют."""


def render(payload: Any) -> bytes:
    """Тело JSON как у JSONResponse: UTF-8 без экранирования, без пробелов, без NaN."""
    return json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
        default=jsonable_encoder,
    ).encode("utf-8")


def _without(payload: Any, path: list[str]) -> Any:
    """Копия словаря без поля по пути; копируются только словари на пути, остальное — то же."""
    if not isinstance(payload, dict) or path[0] not in payload:
        return payload
    head, rest = path[0], path[1:]
    out = dict(payload)
    if rest:
        inner = _without(out[head], rest)
        if inner is out[head]:
            return payload
        out[head] = inner
    else:
        del out[head]
    return out


def etag_for(payload: Any, body: bytes | None = None, volatile: Iterable[str] = VOLATILE) -> str:
    """Слабый ETag ``W/"<sha1[:16]>"`` по телу без изменчивых полей."""
    stable = payload
    for path in volatile:
        stable = _without(stable, path.split("."))
    data = body if stable is payload and body is not None else render(stable)
    return f'W/"{hashlib.sha1(data, usedforsecurity=False).hexdigest()[:16]}"'


def etag_matches(if_none_match: str | None, etag: str) -> bool:
    """Слабое сравнение (RFC 9110, 13.1.2): ``W/`` не учитывается, ``*`` совпадает с любым."""
    if not if_none_match:
        return False
    opaque = etag.removeprefix("W/")
    for raw in if_none_match.split(","):
        tag = raw.strip()
        if tag == "*" or tag.removeprefix("W/") == opaque:
            return True
    return False


def json_response(request: Request, payload: Any, policy: Policy) -> Response:
    """JSON-ответ с Cache-Control (и CDN-Cache-Control) и ETag; совпал If-None-Match — 304 без
    тела с теми же заголовками."""
    body = render(payload)
    etag = etag_for(payload, body)
    headers = {"Cache-Control": policy.cache_control, "ETag": etag}
    if policy.cdn is not None:
        headers["CDN-Cache-Control"] = policy.cdn
    if etag_matches(request.headers.get("if-none-match"), etag):
        return Response(status_code=304, headers=headers)
    return Response(body, media_type="application/json", headers=headers)


class NoStoreByDefault:
    """ASGI-middleware для ответов под ``prefix``: код ≥ 400 — ``Cache-Control: no-store``
    (вместо любого другого); ответ без Cache-Control — ``private, no-store``.

    Ловит всё — HTTPException обработчиков, 422 валидации, 401 зависимостей, 404/405 маршрутов —
    чтобы ни браузер, ни edge не запомнили ошибку. Обработчики, которые не задают политику сами
    (раскладки пользователя, POST), тоже не попадают в общий кэш: публичным ответ делает только
    явная политика :func:`json_response`. ``CDN-Cache-Control`` у ошибок убирается.
    """

    def __init__(self, app: ASGIApp, prefix: str = "/v1/chart") -> None:
        self.app = app
        self.prefix = prefix

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not str(scope.get("path", "")).startswith(self.prefix):
            await self.app(scope, receive, send)
            return

        async def send_with_default(message: Message) -> None:
            if message["type"] == "http.response.start":
                message.setdefault("headers", [])
                headers = MutableHeaders(scope=message)
                if int(message["status"]) >= 400:
                    headers["cache-control"] = NO_STORE
                    if "cdn-cache-control" in headers:
                        del headers["cdn-cache-control"]
                elif "cache-control" not in headers:
                    headers["cache-control"] = PRIVATE_NO_STORE.cache_control
            await send(message)

        await self.app(scope, receive, send_with_default)
