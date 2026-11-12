"""Необязательный вход на публичных эндпоинтах (optional_user): нет токена — гость; токен есть, но
недействителен или истёк — 401, а не тихий гость (аудит TSA-1: Pro с истёкшим access-токеном
получал «1m–15m на тарифе Pro» и терял слой сигналов, а клиент токен не обновлял). Пользователь
по токену удалён или не найден — 401, заблокирован — 403, как у ``current_user`` (ревью PR #162).
API-ключ на тех же эндпоинтах — ``test_api_key_public.py``."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any

import jwt
import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app import auth
from app.config import settings
from app.models import User


class _Db:
    """Сессия без БД: get(User, pk) — пользователь из словаря."""

    def __init__(self, users: dict[int, User]) -> None:
        self.users = users

    def get(self, model: Any, pk: int) -> User | None:
        assert model is User
        return self.users.get(pk)


def optional_user(request: Request, db: Any) -> User | None:
    """``auth.optional_user`` вне FastAPI: зависимость ``api_key_user`` вызывается явно."""
    return auth.optional_user(request, db, auth.api_key_user(request, db))


def _request(authorization: str | None) -> Request:
    headers = [] if authorization is None else [(b"authorization", authorization.encode())]
    return Request({"type": "http", "method": "GET", "path": "/", "headers": headers})


def _token(user_id: int, exp: datetime) -> str:
    payload = {"sub": str(user_id), "role": "admin", "iat": int(exp.timestamp()) - 900}
    payload["exp"] = int(exp.timestamp())
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


ADMIN = User(id=7, email="a@example.com", role="admin")
DELETED = User(
    id=8, email="d@example.com", role="user", deleted_at=datetime(2026, 11, 1, tzinfo=UTC)
)
BLOCKED = User(
    id=9, email="b@example.com", role="user", blocked_at=datetime(2026, 11, 1, tzinfo=UTC)
)


def test_no_token_is_guest_valid_token_is_user() -> None:
    db: Any = _Db({7: ADMIN})
    assert optional_user(_request(None), db) is None
    # не Bearer (Basic, пустой заголовок) — тоже гость: токена нет
    assert optional_user(_request("Basic Zm9vOmJhcg=="), db) is None
    assert optional_user(_request(""), db) is None
    fresh = _token(7, datetime.now(tz=UTC) + timedelta(minutes=10))
    assert optional_user(_request(f"Bearer {fresh}"), db) is ADMIN


@pytest.mark.parametrize(
    ("user_id", "status"),
    [(8, 401), (10, 401)],
    ids=["deleted", "missing"],
)
def test_token_of_inactive_account_is_error_not_user(user_id: int, status: int) -> None:
    """Токен действителен, но аккаунт удалён или не найден — 401, как у ``current_user``. Было:
    удалённый получал данные своего тарифа, а токен несуществующего пользователя — ответ гостя."""
    db: Any = _Db({7: ADMIN, 8: DELETED, 9: BLOCKED})
    fresh = _token(user_id, datetime.now(tz=UTC) + timedelta(minutes=10))
    with pytest.raises(HTTPException) as e:
        optional_user(_request(f"Bearer {fresh}"), db)
    assert e.value.status_code == status


def test_token_of_blocked_account_is_guest() -> None:
    """Заблокированный по токену сайта на открытых страницах — гость: без данных тарифа (было —
    данные тарифа) и без 403 (вход и обновление токена блокировку не проверяют, 403 ломал бы
    график и ленту). На закрытых эндпоинтах — 403, как раньше."""
    db: Any = _Db({7: ADMIN, 8: DELETED, 9: BLOCKED})
    fresh = _token(9, datetime.now(tz=UTC) + timedelta(minutes=10))
    assert optional_user(_request(f"Bearer {fresh}"), db) is None
    with pytest.raises(HTTPException) as e:
        auth.current_user(_request(f"Bearer {fresh}"), db, None)
    assert e.value.status_code == 403


@pytest.mark.parametrize(
    "bearer",
    [
        _token(7, datetime.now(tz=UTC) - timedelta(minutes=1)),  # истёк
        "garbage",  # не JWT
        jwt.encode(
            {"sub": "7", "exp": 4_000_000_000}, "чужой-ключ-подписи-длиной-32-байта", "HS256"
        ),
        "",  # «Bearer » без токена
    ],
    ids=["expired", "garbage", "foreign-signature", "empty"],
)
def test_present_but_invalid_token_is_401(bearer: str) -> None:
    with pytest.raises(HTTPException) as e:
        optional_user(_request(f"Bearer {bearer}"), _Db({7: ADMIN}))
    assert e.value.status_code == 401


def test_chart_candles_expired_token_401_not_guest_403(monkeypatch: pytest.MonkeyPatch) -> None:
    """Сквозь эндпоинт: истёкший токен на 1m — 401 (клиент обновит токен и повторит), свежий — 200,
    без токена — 403 гостя (минутные ТФ закрыты)."""
    from fastapi.testclient import TestClient

    from app.main import app
    from app.routers import chart

    monkeypatch.setattr(
        chart,
        "_instrument",
        lambda db, symbol: SimpleNamespace(id=1, symbol="BTCUSDT", tick_size=None),
    )
    monkeypatch.setattr(chart, "load_candles", lambda *a, **k: ([], False))
    monkeypatch.setattr(chart, "current_candle", lambda *a, **k: None)
    app.dependency_overrides[auth.get_db] = lambda: _Db({7: ADMIN})
    try:
        client = TestClient(app)
        url = "/v1/chart/candles?symbol=BTCUSDT&tf=1m"
        now = datetime.now(tz=UTC)
        expired = client.get(
            url, headers={"authorization": f"Bearer {_token(7, now - timedelta(minutes=1))}"}
        )
        assert expired.status_code == 401, expired.text
        fresh = client.get(
            url, headers={"authorization": f"Bearer {_token(7, now + timedelta(minutes=10))}"}
        )
        assert fresh.status_code == 200, fresh.text
        guest = client.get(url)
        assert guest.status_code == 403, guest.text
    finally:
        app.dependency_overrides.pop(auth.get_db, None)
