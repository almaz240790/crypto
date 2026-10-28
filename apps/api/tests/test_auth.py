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


def test_promote_owner_by_email_case_and_spaces() -> None:
    owners = {"boss@example.com"}
    u = User(id=1, email=" Boss@Example.com", role="user")
    assert auth.promote_owner(u, owners) and u.role == "owner"
    assert u.email_verified_at is not None  # адрес владельца подтверждён настройками сервера
    assert not auth.promote_owner(u, owners)  # уже владелец
    admin = User(
        id=2, email="boss@example.com", role="admin", email_verified_at=datetime.now(tz=UTC)
    )
    assert not auth.promote_owner(admin, owners) and admin.role == "admin"
    other = User(id=3, email="user@example.com", role="user")
    assert not auth.promote_owner(other, owners) and other.role == "user"
    assert other.email_verified_at is None


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


def test_journal_realized_r() -> None:
    from app.models import JournalEntry
    from app.routers.user import _realized_r

    e = JournalEntry(
        direction="long", entry_price=Decimal(100), stop_loss=Decimal(95), exit_price=Decimal(110)
    )
    assert _realized_r(e) == Decimal(2)
    s = JournalEntry(
        direction="short", entry_price=Decimal(100), stop_loss=Decimal(105), exit_price=Decimal(97)
    )
    assert _realized_r(s) == Decimal("0.6")
    assert (
        _realized_r(
            JournalEntry(
                direction="long", entry_price=Decimal(100), stop_loss=None, exit_price=Decimal(1)
            )
        )
        is None
    )
    bad = JournalEntry(
        direction="long", entry_price=Decimal(100), stop_loss=Decimal(120), exit_price=Decimal(110)
    )
    assert _realized_r(bad) is None


def test_r_histogram_entry_type_and_run_trades() -> None:
    from app.stats import r_histogram, trade_rows, trades_from_run

    run_trades = [
        {
            "symbol": "BTCUSDT",
            "direction": "up",
            "signal_time": "2026-01-02T00:00:00+00:00",
            "grade": "A",
            "score": 80,
            "rr_tp2": "2.5",
            "entry": "100",
            "stop": "98",
            "status": "closed_tp3",
            "realized_r": "2.9",
            "tp_hits": 3,
            "mfe_r": "3",
            "mae_r": "0.2",
            "exit_time": "2026-01-03T00:00:00+00:00",
            "facts": [],
        },
        {
            "symbol": "ETHUSDT",
            "direction": "down",
            "signal_time": "2026-01-04T00:00:00+00:00",
            "grade": "B",
            "score": 65,
            "rr_tp2": "2.1",
            "entry": "50",
            "stop": "52",
            "status": "closed_sl",
            "realized_r": "-1",
            "tp_hits": 0,
            "mfe_r": "0.3",
            "mae_r": "1",
            "exit_time": None,
            "facts": [],
        },
        {
            "symbol": "ETHUSDT",
            "direction": "down",
            "signal_time": "2026-01-05T00:00:00+00:00",
            "grade": "C",
            "score": 50,
            "rr_tp2": "2",
            "entry": "50",
            "stop": "52",
            "status": "expired",
            "realized_r": "0",
            "tp_hits": 0,
            "mfe_r": "0",
            "mae_r": "0",
            "exit_time": None,
            "facts": [],
        },
    ]
    trades = trades_from_run(run_trades, "limit")
    assert [t.result.closed for t in trades] == [True, True, False]
    payload = stats_payload(trades)
    assert payload["metrics"]["closed"] == 2 and payload["metrics"]["expired"] == 1
    assert set(payload["by_entry_type"]) == {"limit"}
    hist = r_histogram(trades)
    assert sum(b["n"] for b in hist) == 2
    assert next(b for b in hist if b["from"] == -1 and b["to"] == -0.5)["n"] == 1
    assert hist[-1]["to"] is None and hist[0]["from"] is None
    rows = trade_rows(trades)
    assert rows[0]["entry_type"] == "limit" and rows[0]["realized_r"] == 2.9
    assert rows[2]["realized_r"] is None and rows[1]["direction"] == "short"
