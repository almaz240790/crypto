"""WebSocket /v1/ws: подписка, pong, адресная рассылка, живые тики (без Redis и БД)."""

from __future__ import annotations

import asyncio
import json
import queue
import time
from collections.abc import AsyncIterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import auth, live
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


# --- живые цены: канал prices.live → тики клиентам (план 2A.3, ADR-0010) ---------------------


def _client(*symbols: str, user_id: int | None = None) -> Client:
    c = Client(FakeWs(), user_id)  # type: ignore[arg-type]
    c.subscribe(set(symbols))
    return c


def test_client_throttles_per_symbol_and_keeps_only_latest() -> None:
    c = _client("BTCUSDT", "ETHUSDT")
    c.offer("BTCUSDT", {"t": "tick", "s": "BTCUSDT", "p": "1"})
    sent, wait = c.due(100.0)
    assert [m["p"] for m in sent] == ["1"] and wait is None
    # в ту же секунду: два тика BTC — уйдёт только последний и не раньше чем через секунду
    c.offer("BTCUSDT", {"t": "tick", "s": "BTCUSDT", "p": "2"})
    c.offer("BTCUSDT", {"t": "tick", "s": "BTCUSDT", "p": "3"})
    c.offer("ETHUSDT", {"t": "tick", "s": "ETHUSDT", "p": "10"})  # другой символ — без ожидания
    sent, wait = c.due(100.4)
    assert [m["p"] for m in sent] == ["10"] and wait == pytest.approx(0.6)
    assert c.dropped == 1 and len(c.pending) == 1  # очередь не растёт: один ключ — одно сообщение
    sent, wait = c.due(101.0)
    assert [m["p"] for m in sent] == ["3"] and wait is None
    # отписка снимает неотправленное и историю отправок
    c.offer("ETHUSDT", {"t": "tick", "s": "ETHUSDT", "p": "11"})
    c.subscribe({"BTCUSDT"})
    assert c.pending == {} and set(c.sent_at) == {"BTCUSDT"}


def test_on_prices_fans_out_to_subscribers_with_keepalive_and_forming() -> None:
    h = Hub()
    btc, eth, none = _client("BTCUSDT"), _client("ETHUSDT"), _client()
    h.clients.update({btc, eth, none})
    h.on_prices({"at": "A1", "p": {"BTCUSDT": "100.5", "ETHUSDT": "2000"}}, now=10.0)
    assert btc.pending == {"BTCUSDT": {"t": "tick", "s": "BTCUSDT", "p": "100.5", "at": "A1"}}
    assert eth.pending["ETHUSDT"]["p"] == "2000" and none.pending == {}
    for c in (btc, eth):
        c.due(10.0)
    # BTC изменился, ETH нет: ETH повторится через TICK_KEEPALIVE и только с сообщением тикера
    h.on_prices({"at": "A2", "p": {"BTCUSDT": "100.6"}}, now=11.0)
    assert btc.pending["BTCUSDT"]["p"] == "100.6" and eth.pending == {}
    h.on_prices({"at": "A3", "c": {"ETHUSDT": {"t": 60, "o": "1"}}}, now=13.0)  # не тикер
    assert set(eth.pending) == {"f:ETHUSDT"}
    assert eth.pending["f:ETHUSDT"] == {
        "t": "forming",
        "s": "ETHUSDT",
        "tf": "1m",
        "c": {"t": 60, "o": "1"},
    }
    h.on_prices({"at": "A4", "p": {}}, now=13.0)
    assert eth.pending["ETHUSDT"] == {"t": "tick", "s": "ETHUSDT", "p": "2000", "at": "A4"}
    st = h.status()
    assert st["ticks_in"] == 3 and st["prices"] == 2 and st["prices_at"] == "A4"


def test_prime_sends_last_price_only_while_ticker_is_alive() -> None:
    h = Hub()
    h.on_prices({"at": "A1", "p": {"BTCUSDT": "7"}}, now=50.0)
    c = _client("BTCUSDT", "XRPUSDT")
    h.prime(c, now=52.0)
    assert c.pending == {"BTCUSDT": {"t": "tick", "s": "BTCUSDT", "p": "7", "at": "A1"}}
    late = _client("BTCUSDT")
    h.prime(late, now=50.0 + live.PRICES_FRESH + 1)  # тикер молчит — «онлайн» не изображаем
    assert late.pending == {}


def test_slow_client_is_dropped_instead_of_queueing(monkeypatch: Any) -> None:
    monkeypatch.setattr(live, "SEND_TIMEOUT", 0.05)

    class SlowWs(FakeWs):
        closed = False

        async def send_text(self, text: str) -> None:
            await asyncio.sleep(10)

        async def close(self) -> None:
            self.closed = True

    async def run() -> None:
        h = Hub()
        c = Client(SlowWs(), None)  # type: ignore[arg-type]
        c.subscribe({"BTCUSDT"})
        h.clients.add(c)
        task = asyncio.create_task(c.pump(h))
        h.on_prices({"at": "A", "p": {"BTCUSDT": "1"}})
        await asyncio.wait_for(task, 2)
        assert c not in h.clients and c.ws.closed  # type: ignore[attr-defined]
        assert h.last_error is not None and "TimeoutError" in h.last_error

    asyncio.run(run())


class FakePubSub:
    """Подписка Redis из потока теста: сообщения кладутся в обычную очередь."""

    def __init__(self, q: queue.Queue[tuple[str, dict[str, Any]]]) -> None:
        self.q = q
        self.channels: tuple[str, ...] = ()

    async def subscribe(self, *channels: str) -> None:
        self.channels = channels

    async def listen(self) -> AsyncIterator[dict[str, Any]]:
        while True:
            try:
                channel, data = self.q.get_nowait()
            except queue.Empty:
                await asyncio.sleep(0.005)
                continue
            yield {"type": "message", "channel": channel.encode(), "data": json.dumps(data)}


class FakeRedis:
    def __init__(self, q: queue.Queue[tuple[str, dict[str, Any]]]) -> None:
        self.q = q
        self.subs: list[FakePubSub] = []

    def pubsub(self) -> FakePubSub:
        self.subs.append(FakePubSub(self.q))
        return self.subs[-1]

    async def aclose(self) -> None:
        return None


def test_ws_ticks_end_to_end_throttled_and_backward_compatible(monkeypatch: Any) -> None:
    from app import main

    q: queue.Queue[tuple[str, dict[str, Any]]] = queue.Queue()
    redis = FakeRedis(q)
    fresh = Hub()
    monkeypatch.setattr(live, "hub", fresh)
    monkeypatch.setattr(main, "hub", fresh)
    monkeypatch.setattr(live.aioredis, "from_url", lambda *a, **k: redis)
    candle = {"t": 1704067200, "o": "1", "h": "2", "l": "1", "c": "1.5", "v": "3"}
    monkeypatch.setattr(live, "_candle_row", lambda i, t: candle)

    with TestClient(app) as tc, tc.websocket_connect("/v1/ws") as ws:
        ws.send_text(json.dumps({"sub": ["btcusdt"]}))
        assert ws.receive_json() == {"t": "subscribed", "n": 1}
        # прежний протокол: закрытая минута → price и candle
        q.put(
            (
                "candles.closed",
                {
                    "symbol": "BTCUSDT",
                    "instrument_id": 1,
                    "tf": "1m",
                    "open_time": "2024-01-01T00:00:00+00:00",
                    "close_time": "2024-01-01T00:01:00+00:00",
                    "close": "1.5",
                },
            )
        )
        assert ws.receive_json() == {
            "t": "price",
            "s": "BTCUSDT",
            "p": "1.5",
            "at": "2024-01-01T00:01:00+00:00",
        }
        assert ws.receive_json() == {"t": "candle", "s": "BTCUSDT", "tf": "1m", "c": candle}
        assert redis.subs[0].channels == ("candles.closed", "signals.status", "prices.live")
        # тики: только подписанный символ, первый — сразу
        q.put(("prices.live", {"at": "A1", "p": {"BTCUSDT": "100.5", "ETHUSDT": "2000"}}))
        assert ws.receive_json() == {"t": "tick", "s": "BTCUSDT", "p": "100.5", "at": "A1"}
        t0 = time.monotonic()
        # три сообщения за доли секунды: формирующаяся минута уходит сразу, из тиков — последний
        q.put(("prices.live", {"at": "A2", "p": {"BTCUSDT": "100.6"}}))
        q.put(("prices.live", {"at": "A3", "p": {"BTCUSDT": "100.7", "ETHUSDT": "2001"}}))
        q.put(("prices.live", {"at": "A3", "c": {"BTCUSDT": candle, "ETHUSDT": candle}}))
        assert ws.receive_json() == {"t": "forming", "s": "BTCUSDT", "tf": "1m", "c": candle}
        assert ws.receive_json() == {"t": "tick", "s": "BTCUSDT", "p": "100.7", "at": "A3"}
        assert time.monotonic() - t0 >= live.TICK_MIN_INTERVAL - 0.15
        ws.send_text('{"ping": 1}')
        assert ws.receive_json() == {"t": "pong"}
        st = fresh.status()
        assert st["ticks_in"] == 3 and st["ticks_sent"] == 3 and st["ticks_dropped"] >= 1
    assert fresh.task is None and not fresh.clients
