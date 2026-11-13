"""API-ключи для чтения (план 3.10: «API-ключ для чтения истории — Premium»).

Ключ ``pk_<43 символа>`` показывается один раз; в базе — sha256 и префикс для списка.
Что открывает ключ — :data:`KEY_ENDPOINTS` и :func:`key_scope` (ADR-0017): только GET и только
эндпоинты со страницы /api-docs. Только Premium и лимит запросов на ключ — в ``auth.api_key_user``:
она общая для ``current_user``, ``optional_user`` и роутеров открытых данных (/v1, /v1/chart).
"""

from __future__ import annotations

import secrets
from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.requests import HTTPConnection

from app import auth
from app.models import ApiKey, User

PREFIX = "pk_"
KEYS_LIMIT = 5
API_RATE = (600, 60)  # запросов в минуту на ключ

# Эндпоинты, открытые ключу (ADR-0017), — ровно список страницы /api-docs
# (apps/web/src/lib/apiDocs.ts; тест сверяет оба списка): рыночные данные, сигналы, статистика,
# журнал и алерты владельца ключа. Список закрытый: новый эндпоинт по ключу недоступен, пока его не
# внесут сюда и в документацию. Личные разделы (профиль, выгрузка данных, ключи, сессии, платежи)
# сюда не входят — их читает только сайт по токену.
KEY_ENDPOINTS = frozenset(
    {
        "/v1/signals",
        "/v1/signals/{public_id}",
        "/v1/signals/{public_id}/candles",
        "/v1/stats",
        "/v1/stats/trades",
        "/v1/stats/export.csv",
        "/v1/stats/patterns",
        "/v1/stats/figures",
        "/v1/chart/candles",
        "/v1/chart/layers",
        "/v1/chart/patterns",
        "/v1/chart/figures",
        "/v1/chart/derivatives",
        "/v1/screener",
        "/v1/screener/export.csv",
        "/v1/instruments",
        "/v1/prices",
        "/v1/journal",
        "/v1/journal/analytics",
        "/v1/alerts",
    }
)
READ_ONLY = "API-ключ даёт только чтение"
OUT_OF_SCOPE = "API-ключ не даёт доступа к этому разделу (список — на странице /api-docs)"


def new_key() -> tuple[str, str, str]:
    """(сырой ключ, префикс для списка, sha256 для хранения)."""
    raw = PREFIX + secrets.token_urlsafe(32)
    return raw, raw[:10], auth.sha256(raw)


def looks_like_key(value: str) -> bool:
    return value.startswith(PREFIX) and 30 <= len(value) <= 80


def find_user(db: Session, raw: str, now: datetime | None = None) -> User | None:
    """Пользователь по ключу; отозванный или неизвестный — None. Отмечает время использования."""
    if not looks_like_key(raw):
        return None
    row = db.scalar(select(ApiKey).where(ApiKey.key_hash == auth.sha256(raw)))
    if row is None or row.revoked_at is not None:
        return None
    user = db.get(User, row.user_id)
    if user is None or user.deleted_at is not None:
        return None
    row.last_used_at = now or datetime.now(tz=UTC)
    db.commit()
    return user


def key_scope(conn: HTTPConnection) -> None:
    """Куда пускает ``X-API-Key``: запрос не GET — 403 «только чтение», эндпоинт не из
    :data:`KEY_ENDPOINTS` — 403 «не даёт доступа к этому разделу». Без заголовка — ничего.

    Зависимость всего приложения (``app.main``): так закрыт любой эндпоинт, в том числе новый и
    тот, что ключ не читает (админка, служебные). Её же вызывает ``auth._api_key_user`` —
    пользователь по ключу не появляется за пределами списка, как бы ни было собрано приложение.
    Эндпоинт сравнивается по шаблону пути, который выбрал FastAPI (``/v1/signals/{public_id}``),
    а не по адресу запроса. Сокет (``/v1/ws``) ключ не читает — вход там токеном в адресе."""
    if conn.scope["type"] != "http" or "x-api-key" not in conn.headers:
        return
    if conn.scope["method"] != "GET":
        raise HTTPException(403, READ_ONLY)
    route = conn.scope.get("route")
    if getattr(route, "path_format", None) not in KEY_ENDPOINTS:
        raise HTTPException(403, OUT_OF_SCOPE)
