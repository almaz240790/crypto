"""WebSocket /v1/ws: подписка, pong, адресная рассылка (без Redis и БД)."""

from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi.testclient import TestClient

from app import auth
from app.live import Client, Hub, hub
from app.main import app
from app.models import User


class FakeWs:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_text(self, text: str) -> None:
        self.sent.append(json.loads(text))


def test_broadcast_filters_by_symbol_and_auth() -> None:
    h = Hub()
    guest, pro = Client(FakeWs(), None), Client(FakeWs(), 7)  # type: ignore[arg-type]
    guest.symbols = {"BTCUSDT"}
    pro.symbols = {"ETHUSDT"}
    h.clients.update({guest, pro})
    asyncio.run(h.broadcast({"t": "price", "s": "BTCUSDT", "p": "1"}, symbol="BTCUSDT"))
    asyncio.run(h.broadcast({"t": "signal", "id": "x"}, authed_only=True))
    assert guest.ws.sent == [{"t": "price", "s": "BTCUSDT", "p": "1"}]  # type: ignore[attr-defined]
    assert pro.ws.sent == [{"t": "signal", "id": "x"}]  # type: ignore[attr-defined]


def test_ws_subscribe_and_pong(monkeypatch: Any) -> None:
    async def no_start(self: Hub) -> None:  # не трогаем Redis
        return None

    monkeypatch.setattr(Hub, "start", no_start)
    token = auth.make_access_token(User(id=5, email="a@b.c", role="user"))
    with TestClient(app).websocket_connect(f"/v1/ws?token={token}") as ws:
        ws.send_text(json.dumps({"sub": ["btcusdt", "ETHUSDT"]}))
        assert ws.receive_json() == {"t": "subscribed", "n": 2}
        ws.send_text('{"ping": 1}')
        assert ws.receive_json() == {"t": "pong"}
        assert any(c.user_id == 5 and "BTCUSDT" in c.symbols for c in hub.clients)
    assert not any(c.user_id == 5 for c in hub.clients)
