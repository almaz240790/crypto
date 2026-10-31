"""HTTP-кэш ответов /v1/chart (план 2B.4): Cache-Control по варианту ответа, слабый ETag и 304.

Правила (таблица спецификации «Данные графика: API»):

- свечи ТФ ≥ 1h без ``before`` — короткий общий кэш (edge 10 с + 30 с stale);
- свечи ТФ ≥ 1h с ``before`` в прошлом — история, не меняется: браузер 1 ч, edge сутки;
- свечи 1m/5m/15m зависят от тарифа — ``private, no-store``;
- layers ``view=chart`` — только структура, от пользователя не зависит — общий кэш 30 с;
- layers без ``view`` содержат сигналы по правам пользователя — ``private, no-cache``;
- signals — ``private, no-store``;
- found, patterns, figures — общий кэш 60 с; derivatives — 30 с;
- любая ошибка (4xx) — ``no-store`` (middleware :class:`NoStoreErrors`).

ETag считается по телу без изменчивых полей (``server_time``): 304 означает «данные те же».
Время сервера клиент берёт из заголовка ``Date``. Edge-кэш Cloudflare требует Cache Rule для
``/v1/chart/*`` — это настройка production, её включает владелец (план 10.4); без неё заголовки
дают браузерный кэш истории и 304.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable
from typing import Any

from fastapi import Request, Response
from fastapi.encoders import jsonable_encoder
from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

CANDLES_LATEST = "public, max-age=0, s-maxage=10, stale-while-revalidate=30"
CANDLES_HISTORY = "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400"
LAYERS_CHART = "public, max-age=0, s-maxage=30, stale-while-revalidate=60"
OBJECTS = "public, max-age=0, s-maxage=60, stale-while-revalidate=300"
"""found, patterns, figures."""
DERIVATIVES = "public, max-age=0, s-maxage=30, stale-while-revalidate=60"
PRIVATE_NO_CACHE = "private, no-cache"
"""Зависит от пользователя, но можно переспросить с If-None-Match (layers без view)."""
PRIVATE_NO_STORE = "private, no-store"
"""Зависит от прав пользователя: внутридневные свечи, сигналы."""
NO_STORE = "no-store"
"""Ошибки."""

VOLATILE = ("server_time",)
"""Поля верхнего уровня, которые не входят в ETag: меняются на каждый запрос, данных не меняют."""


def render(payload: Any) -> bytes:
    """Тело JSON как у JSONResponse: UTF-8 без экранирования, без пробелов, без NaN."""
    return json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
        default=jsonable_encoder,
    ).encode("utf-8")


def etag_for(payload: Any, body: bytes | None = None, volatile: Iterable[str] = VOLATILE) -> str:
    """Слабый ETag ``W/"<sha1[:16]>"`` по телу без изменчивых полей."""
    skip = set(volatile)
    if isinstance(payload, dict) and skip & payload.keys():
        stable = render({k: v for k, v in payload.items() if k not in skip})
    else:
        stable = body if body is not None else render(payload)
    return f'W/"{hashlib.sha1(stable, usedforsecurity=False).hexdigest()[:16]}"'


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


def json_response(request: Request, payload: Any, cache_control: str) -> Response:
    """JSON-ответ с Cache-Control и ETag; совпал If-None-Match — 304 без тела с теми же
    заголовками."""
    body = render(payload)
    etag = etag_for(payload, body)
    headers = {"Cache-Control": cache_control, "ETag": etag}
    if etag_matches(request.headers.get("if-none-match"), etag):
        return Response(status_code=304, headers=headers)
    return Response(body, media_type="application/json", headers=headers)


class NoStoreErrors:
    """ASGI-middleware: ответы с кодом ≥ 400 под ``prefix`` получают ``Cache-Control: no-store``.

    Ловит всё — HTTPException обработчиков, 422 валидации, 401 зависимостей, 404/405 маршрутов —
    чтобы ни браузер, ни edge не запомнили ошибку.
    """

    def __init__(self, app: ASGIApp, prefix: str = "/v1/chart") -> None:
        self.app = app
        self.prefix = prefix

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not str(scope.get("path", "")).startswith(self.prefix):
            await self.app(scope, receive, send)
            return

        async def send_with_no_store(message: Message) -> None:
            if message["type"] == "http.response.start" and int(message["status"]) >= 400:
                message.setdefault("headers", [])
                MutableHeaders(scope=message)["cache-control"] = NO_STORE
            await send(message)

        await self.app(scope, receive, send_with_no_store)
