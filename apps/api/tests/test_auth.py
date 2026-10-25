"""Чистые части аутентификации и статистики (без БД)."""

from __future__ import annotations

import hashlib
import hmac
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from fastapi import HTTPException

from app import auth
from app.models import User
from app.stats import stats_payload, worst_drawdowns
from engine.backtest import BacktestTrade, TradeResult, TradeStatus
from engine.scoring import Grade
from engine.structure import Direction


def test_password_hash_and_verify() -> None:
    h = auth.hash_password("correct horse battery")
    assert h.startswith("$argon2id$")
    assert auth.verify_password("correct horse battery", h)
    assert not auth.verify_password("wrong", h)
    assert not auth.verify_password("x", None)


def test_access_token_roundtrip_and_rejection() -> None:
    user = User(id=42, email="a@b.c", role="user")
    token = auth.make_access_token(user)
    payload = auth.decode_access_token(token)
    assert payload["sub"] == "42" and payload["role"] == "user"
    with pytest.raises(HTTPException):
        auth.decode_access_token(token + "x")


def test_telegram_signature() -> None:
    bot = "123:ABC"
    data = {"id": 7, "first_name": "Al", "auth_date": int(datetime.now(tz=UTC).timestamp())}
    check = "\n".join(sorted(f"{k}={v}" for k, v in data.items())).encode()
    secret = hashlib.sha256(bot.encode()).digest()
    data["hash"] = hmac.new(secret, check, hashlib.sha256).hexdigest()
    assert auth.verify_telegram_payload(dict(data), bot)
    assert not auth.verify_telegram_payload({**data, "first_name": "Bob"}, bot)
    old = {**data, "auth_date": int((datetime.now(tz=UTC) - timedelta(days=3)).timestamp())}
    check = "\n".join(sorted(f"{k}={v}" for k, v in old.items() if k != "hash")).encode()
    old["hash"] = hmac.new(secret, check, hashlib.sha256).hexdigest()
    assert not auth.verify_telegram_payload(old, bot)
    assert not auth.verify_telegram_payload({"id": 1}, bot)


def _trade(r: str, status: TradeStatus, day: int) -> BacktestTrade:
    t = datetime(2026, 1, 1, tzinfo=UTC) + timedelta(days=day)
    res = TradeResult(status, Decimal(r), None, None, 0, 0, 0, Decimal(0), Decimal(0), Decimal(0))
    return BacktestTrade(
        "X",
        Direction.UP,
        t,
        Grade.A,
        80,
        Decimal(2),
        Decimal(1),
        Decimal(0),
        Decimal(2),
        Decimal(3),
        Decimal(4),
        res,
        t + timedelta(hours=8),
    )


def test_worst_drawdowns_and_payload() -> None:
    trades = [
        _trade("2", TradeStatus.CLOSED_TP3, 0),
        _trade("-1", TradeStatus.CLOSED_SL, 1),
        _trade("-1.5", TradeStatus.CLOSED_SL, 2),
        _trade("3", TradeStatus.CLOSED_TP3, 3),
        _trade("-0.5", TradeStatus.CLOSED_SL, 4),
    ]
    dd = worst_drawdowns(trades)
    assert dd[0]["depth_r"] == 2.5 and dd[1]["depth_r"] == 0.5
    payload = stats_payload(trades)
    assert payload["metrics"]["closed"] == 5 and payload["equity"][-1]["r"] == 2.0
    assert "A" in payload["by_grade"] and "2026-01" in payload["by_month"]
    assert stats_payload([])["equity"] == [] and worst_drawdowns([]) == []
