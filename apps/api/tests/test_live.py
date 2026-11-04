"""WebSocket /v1/ws: подписка, pong, адресная рассылка, живые тики (без Redis и БД)."""

from __future__ import annotations

import asyncio
import json
import queue
import time
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
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
        self.closed = False

    async def send_text(self, text: str) -> None:
        self.sent.append(json.loads(text))

    async def close(self) -> None:
        self.closed = True


def _client(*symbols: str, user_id: int | None = None, **opts: Any) -> Client:
    c = Client(FakeWs(), user_id)  # type: ignore[arg-type]
    c.subscribe(set(symbols), **opts)
    return c


def _pending(c: Client) -> dict[str, dict[str, Any]]:
    return {k: json.loads(v) for k, v in c.pending.items()}


def _outbox(c: Client) -> list[dict[str, Any]]:
    return [json.loads(m) for m in c.outbox]


def test_broadcast_filters_by_symbol_and_auth_without_waiting_for_sockets() -> None:
    h = Hub()
    guest, pro = _client("BTCUSDT"), _client("ETHUSDT", user_id=7)
    h.clients.update({guest, pro})
    h.broadcast({"t": "price", "s": "BTCUSDT", "p": "1"}, symbol="BTCUSDT")
    h.broadcast({"t": "signal", "id": "x"}, authed_only=True)
    # в очередь отправки клиента (пишет только его задача), не в сокет из слушателя
    assert _outbox(guest) == [{"t": "price", "s": "BTCUSDT", "p": "1"}]
    assert _outbox(pro) == [{"t": "signal", "id": "x"}]


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


def test_client_throttles_per_symbol_and_keeps_only_latest() -> None:
    c = _client("BTCUSDT", "ETHUSDT")
    c.offer("BTCUSDT", '{"p":"1"}')
    _, sent, wait = c.due(100.0)
    assert sent == ['{"p":"1"}'] and wait is None
    # в ту же секунду: два тика BTC — уйдёт только последний и не раньше чем через секунду
    c.offer("BTCUSDT", '{"p":"2"}')
    c.offer("BTCUSDT", '{"p":"3"}')
    c.offer("ETHUSDT", '{"p":"10"}')  # другой символ — без ожидания
    msgs, sent, wait = c.due(100.4)
    assert msgs == [] and sent == ['{"p":"10"}'] and wait == pytest.approx(0.6)
    assert c.dropped == 1 and len(c.pending) == 1  # очередь не растёт: один ключ — одно сообщение
    _, sent, wait = c.due(101.0)
    assert sent == ['{"p":"3"}'] and wait is None
    # отписка снимает неотправленное и историю отправок
    c.offer("ETHUSDT", '{"p":"11"}')
    c.subscribe({"BTCUSDT"})
    assert c.pending == {} and set(c.sent_at) == {"BTCUSDT"}


def test_on_prices_fans_out_to_subscribers_with_keepalive_and_forming() -> None:
    h = Hub()
    btc, eth, none = _client("BTCUSDT"), _client("ETHUSDT"), _client()
    h.clients.update({btc, eth, none})
    h.on_prices({"at": "A1", "p": {"BTCUSDT": "100.5", "ETHUSDT": "2000"}}, now=10.0)
    assert _pending(btc) == {"BTCUSDT": {"t": "tick", "s": "BTCUSDT", "p": "100.5", "at": "A1"}}
    assert _pending(eth)["ETHUSDT"]["p"] == "2000" and none.pending == {}
    for c in (btc, eth):
        c.due(10.0)
    # BTC изменился, ETH нет: ETH повторится через TICK_KEEPALIVE и только с сообщением тикера
    h.on_prices({"at": "A2", "p": {"BTCUSDT": "100.6"}}, now=11.0)
    assert _pending(btc)["BTCUSDT"]["p"] == "100.6" and eth.pending == {}
    forming = {"t": 60, "o": "1", "at": "2026-11-04T08:00:59.100+00:00"}
    h.on_prices({"at": "A3", "c": {"ETHUSDT": forming}}, now=13.0)  # не тикер
    assert set(eth.pending) == {"f:ETHUSDT"}
    # момент снимка (at внутри свечи) доходит до клиента как есть
    assert _pending(eth)["f:ETHUSDT"] == {"t": "forming", "s": "ETHUSDT", "tf": "1m", "c": forming}
    h.on_prices({"at": "A4", "p": {}}, now=13.0)
    assert _pending(eth)["ETHUSDT"] == {"t": "tick", "s": "ETHUSDT", "p": "2000", "at": "A4"}
    st = h.status()
    assert st["ticks_in"] == 3 and st["prices"] == 2 and st["prices_at"] == "A4"


def test_prime_sends_last_price_only_while_ticker_is_alive() -> None:
    h = Hub()
    h.on_prices({"at": "A1", "p": {"BTCUSDT": "7"}}, now=50.0)
    c = _client("BTCUSDT", "XRPUSDT")
    h.prime(c, now=52.0)
    assert _pending(c) == {"BTCUSDT": {"t": "tick", "s": "BTCUSDT", "p": "7", "at": "A1"}}
    late = _client("BTCUSDT")
    h.prime(late, now=50.0 + live.PRICES_FRESH + 1)  # тикер молчит — «онлайн» не изображаем
    assert late.pending == {}


def test_stale_symbols_are_not_kept_alive_or_primed() -> None:
    """B3: стрим инструмента молчит и REST недоступен (market-data шлёт его в "stale"): прежняя
    цена не повторяется как живая — у клиента честно «без связи», а не замершая цена с «онлайн»."""
    h = Hub()
    c = _client("BTCUSDT", "ETHUSDT")
    h.clients.add(c)
    h.on_prices({"at": "A1", "p": {"BTCUSDT": "1", "ETHUSDT": "3000"}}, now=0.0)
    c.due(0.0)
    for i in range(1, 5):
        h.on_prices({"at": f"A{i + 1}", "p": {}, "stale": ["ETHUSDT"]}, now=i * 3.0)
        c.due(i * 3.0)
    assert c.sent_at["ETHUSDT"] == 0.0 and c.sent_at["BTCUSDT"] == 12.0
    late = _client("ETHUSDT", "BTCUSDT")
    h.prime(late, now=12.0)
    assert set(late.pending) == {"BTCUSDT"}
    # ETH снова с ценой — снова живой
    h.on_prices({"at": "A9", "p": {"ETHUSDT": "3001"}}, now=13.0)
    assert _pending(c)["ETHUSDT"]["p"] == "3001"


def test_tick_text_built_once_per_symbol_and_batched_for_many_symbols(monkeypatch: Any) -> None:
    """B8: текст тика — один на символ и сообщение, не на клиента; ленте (batch) — один кадр в
    секунду на все её символы, без формирующихся минут."""
    calls: list[str] = []
    real = live._compact

    def counting(payload: dict[str, Any]) -> str:
        calls.append(str(payload.get("t")))
        return real(payload)

    monkeypatch.setattr(live, "_compact", counting)
    h = Hub()
    symbols = [f"S{i}USDT" for i in range(50)]
    terminals = [_client("S0USDT") for _ in range(100)]
    feeds = [_client(*symbols, batch=True, forming=False) for _ in range(100)]
    h.clients.update(terminals + feeds)
    candle = {"t": 60, "o": "1"}
    h.on_prices({"at": "A1", "p": dict.fromkeys(symbols, "1"), "c": {"S0USDT": candle}}, now=0.0)
    assert calls.count("tick") == 50 and calls.count("forming") == 1  # не 100 × 50
    _, frames, _ = feeds[0].due(0.0)
    assert len(frames) == 1  # одна пачка вместо 50 кадров
    assert json.loads(frames[0]) == {"t": "ticks", "at": "A1", "p": dict.fromkeys(symbols, "1")}
    _, frames, _ = terminals[0].due(0.0)
    assert [json.loads(f)["t"] for f in frames] == ["tick", "forming"]
    # пачка — не чаще раза в секунду; неизменные цены повторяются тоже пачкой
    h.on_prices({"at": "A2", "p": {"S1USDT": "2"}}, now=0.5)
    _, frames, wait = feeds[0].due(0.5)
    assert frames == [] and wait == pytest.approx(0.5)
    h.on_prices({"at": "A3", "p": {}}, now=3.0)
    _, frames, _ = feeds[0].due(3.0)
    frame = json.loads(frames[0])
    assert frame["at"] == "A3" and frame["p"]["S1USDT"] == "2" and len(frame["p"]) == 50


def test_snapshot_from_key_primes_after_restart_only_when_fresh() -> None:
    """B2: хаб стартовал после market-data (перезапуск API) — цены из ключа prices:last сразу,
    а не после следующего изменения; несвежий ключ (тикер стоит) за живое не выдаём."""
    now_iso = datetime.now(tz=UTC).isoformat()
    h = Hub()
    c = _client("XRPUSDT")
    h.clients.add(c)
    assert h.load_snapshot(json.dumps({"at": now_iso, "p": {"XRPUSDT": "0.5"}}), now=100.0)
    assert _pending(c) == {"XRPUSDT": {"t": "tick", "s": "XRPUSDT", "p": "0.5", "at": now_iso}}
    assert h.status()["snapshots"] == 1
    late = _client("XRPUSDT")
    h.prime(late, now=101.0)
    assert _pending(late)["XRPUSDT"]["p"] == "0.5"
    old = (datetime.now(tz=UTC) - timedelta(seconds=live.PRICES_FRESH + 5)).isoformat()
    h2 = Hub()
    assert not h2.load_snapshot(json.dumps({"at": old, "p": {"XRPUSDT": "0.5"}}), now=100.0)
    assert not h2.load_snapshot(b"not json") and not h2.load_snapshot(None)
    assert h2.prices == {}


def test_slow_client_is_dropped_instead_of_queueing(monkeypatch: Any) -> None:
    monkeypatch.setattr(live, "SEND_TIMEOUT", 0.05)

    class SlowWs(FakeWs):
        async def send_text(self, text: str) -> None:
            await asyncio.sleep(10)

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


def test_stuck_client_does_not_block_ticks_of_others(monkeypatch: Any) -> None:
    """B1: раньше broadcast ждал send_text каждого клиента без таймаута прямо в слушателе Redis —
    зависший клиент останавливал тики всем."""
    monkeypatch.setattr(live, "SEND_TIMEOUT", 0.3)

    class StuckWs(FakeWs):
        async def send_text(self, text: str) -> None:
            await asyncio.sleep(3600)

    async def run() -> None:
        h = Hub()
        stuck = Client(StuckWs(), None)  # type: ignore[arg-type]
        stuck.subscribe({"BTCUSDT"})
        ok = _client("BTCUSDT")
        h.clients.update({stuck, ok})
        tasks = [asyncio.create_task(c.pump(h)) for c in (stuck, ok)]
        h.broadcast({"t": "price", "s": "BTCUSDT", "p": "1", "at": "x"}, symbol="BTCUSDT")
        for i in range(3):
            h.on_prices({"at": f"A{i}", "p": {"BTCUSDT": str(i)}})
            await asyncio.sleep(0.05)
        await asyncio.sleep(live.TICK_MIN_INTERVAL + 0.1)
        got = [m.get("p") for m in ok.ws.sent if m["t"] == "tick"]  # type: ignore[attr-defined]
        assert got[0] == "0" and got[-1] == "2"  # здоровый клиент получил тики сразу
        assert stuck not in h.clients and stuck.ws.closed  # type: ignore[attr-defined]
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    asyncio.run(run())


class FakePubSub:
    """Подписка Redis из потока теста: сообщения — в обычную очередь; ``("!", …)`` — обрыв."""

    def __init__(self, q: queue.Queue[tuple[str, Any]]) -> None:
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
            if channel == "!":
                raise ConnectionError("redis connection lost")
            yield {"type": "message", "channel": channel.encode(), "data": json.dumps(data)}


class FakeRedis:
    def __init__(self, q: queue.Queue[tuple[str, Any]]) -> None:
        self.q = q
        self.subs: list[FakePubSub] = []
        self.keys: dict[str, str] = {}

    def pubsub(self) -> FakePubSub:
        self.subs.append(FakePubSub(self.q))
        return self.subs[-1]

    async def get(self, key: str) -> str | None:
        return self.keys.get(key)

    async def aclose(self) -> None:
        return None


Broker = tuple[queue.Queue[tuple[str, Any]], FakeRedis, Hub]


@pytest.fixture
def broker(monkeypatch: Any) -> Broker:
    """Свежий хаб API на поддельном Redis: сообщения канала — ``q.put((channel, data))``."""
    from app import main

    q: queue.Queue[tuple[str, Any]] = queue.Queue()
    redis = FakeRedis(q)
    fresh = Hub()
    monkeypatch.setattr(live, "hub", fresh)
    monkeypatch.setattr(main, "hub", fresh)
    monkeypatch.setattr(live.aioredis, "from_url", lambda *a, **k: redis)
    return q, redis, fresh


CANDLE = {"t": 1704067200, "o": "1", "h": "2", "l": "1", "c": "1.5", "v": "3"}
CLOSED = {
    "symbol": "BTCUSDT",
    "instrument_id": 1,
    "tf": "1m",
    "open_time": "2024-01-01T00:00:00+00:00",
    "close_time": "2024-01-01T00:01:00+00:00",
    "close": "1.5",
}
PRICE = {"t": "price", "s": "BTCUSDT", "p": "1.5", "at": "2024-01-01T00:01:00+00:00"}


def test_ws_ticks_end_to_end_throttled_and_backward_compatible(
    broker: Broker, monkeypatch: Any
) -> None:
    q, redis, fresh = broker
    monkeypatch.setattr(live, "_candle_row", lambda i, t: CANDLE)

    with TestClient(app) as tc, tc.websocket_connect("/v1/ws") as ws:
        ws.send_text(json.dumps({"sub": ["btcusdt"]}))
        assert ws.receive_json() == {"t": "subscribed", "n": 1}
        # прежний протокол: закрытая минута → price и candle (старый market-data — свеча из БД)
        q.put(("candles.closed", CLOSED))
        assert ws.receive_json() == PRICE
        assert ws.receive_json() == {"t": "candle", "s": "BTCUSDT", "tf": "1m", "c": CANDLE}
        assert redis.subs[0].channels == ("candles.closed", "signals.status", "prices.live")
        # тики: только подписанный символ, первый — сразу
        q.put(("prices.live", {"at": "A1", "p": {"BTCUSDT": "100.5", "ETHUSDT": "2000"}}))
        assert ws.receive_json() == {"t": "tick", "s": "BTCUSDT", "p": "100.5", "at": "A1"}
        t0 = time.monotonic()
        # три сообщения за доли секунды: формирующаяся минута уходит сразу, из тиков — последний
        q.put(("prices.live", {"at": "A2", "p": {"BTCUSDT": "100.6"}}))
        q.put(("prices.live", {"at": "A3", "p": {"BTCUSDT": "100.7", "ETHUSDT": "2001"}}))
        q.put(("prices.live", {"at": "A3", "c": {"BTCUSDT": CANDLE, "ETHUSDT": CANDLE}}))
        assert ws.receive_json() == {"t": "forming", "s": "BTCUSDT", "tf": "1m", "c": CANDLE}
        assert ws.receive_json() == {"t": "tick", "s": "BTCUSDT", "p": "100.7", "at": "A3"}
        assert time.monotonic() - t0 >= live.TICK_MIN_INTERVAL - 0.15
        ws.send_text('{"ping": 1}')
        assert ws.receive_json() == {"t": "pong"}
        st = fresh.status()
        assert st["ticks_in"] == 3 and st["ticks_sent"] == 3 and st["ticks_dropped"] >= 1
    assert fresh.task is None and fresh.worker is None and not fresh.clients


@pytest.mark.parametrize("db", ["slow", "down"])
def test_db_trouble_on_closed_minute_does_not_delay_or_stop_ticks(
    broker: Broker, monkeypatch: Any, db: str
) -> None:
    """B1: чтение закрытой минуты из БД (медленное или с ошибкой) раньше шло в слушателе Redis —
    тики стояли, а ошибка обрывала подписку на 5 с. Теперь тики идут, подписка одна, price — из
    события."""
    q, redis, fresh = broker
    monkeypatch.setattr(live, "DB_TIMEOUT", 0.5)

    def candle_row(i: int, t: str) -> dict[str, Any]:
        if db == "slow":
            time.sleep(2)
        raise RuntimeError("db down")

    monkeypatch.setattr(live, "_candle_row", candle_row)
    with TestClient(app) as tc, tc.websocket_connect("/v1/ws") as ws:
        ws.send_text(json.dumps({"sub": ["BTCUSDT"]}))
        assert ws.receive_json() == {"t": "subscribed", "n": 1}
        q.put(("candles.closed", CLOSED))
        t0 = time.monotonic()
        q.put(("prices.live", {"at": "A1", "p": {"BTCUSDT": "100.5"}}))
        assert ws.receive_json() == {"t": "tick", "s": "BTCUSDT", "p": "100.5", "at": "A1"}
        assert time.monotonic() - t0 < 0.4  # не ждёт БД
        assert ws.receive_json() == PRICE  # price закрытой минуты — из события
        q.put(("prices.live", {"at": "A2", "p": {"BTCUSDT": "100.6"}}))
        assert ws.receive_json()["p"] == "100.6"
        assert len(redis.subs) == 1  # подписка не оборвалась
        assert fresh.last_error is not None and "candle row" in fresh.last_error


def test_closed_minute_with_candle_in_event_skips_db(broker: Broker, monkeypatch: Any) -> None:
    q, _, _ = broker

    def no_db(i: int, t: str) -> None:
        raise AssertionError("БД не нужна: свеча в событии")

    monkeypatch.setattr(live, "_candle_row", no_db)
    candle = {**CANDLE, "c": "1.6"}
    with TestClient(app) as tc, tc.websocket_connect("/v1/ws") as ws:
        ws.send_text(json.dumps({"sub": ["BTCUSDT"]}))
        assert ws.receive_json()["t"] == "subscribed"
        q.put(("candles.closed", {**CLOSED, "candle": candle}))
        assert ws.receive_json() == {**PRICE, "p": "1.6"}
        assert ws.receive_json() == {"t": "candle", "s": "BTCUSDT", "tf": "1m", "c": candle}


def test_listener_reads_last_prices_on_resubscribe(broker: Broker, monkeypatch: Any) -> None:
    """B2: обрыв Redis — пока хаб переподключался, XRP сменил цену и стоит; после переподписки
    хаб берёт цены из ключа, а не повторяет старую с новым временем."""
    q, redis, fresh = broker
    monkeypatch.setattr(live, "RETRY_SECONDS", 0.05)
    with TestClient(app) as tc, tc.websocket_connect("/v1/ws") as ws:
        ws.send_text(json.dumps({"sub": ["XRPUSDT"]}))
        assert ws.receive_json()["t"] == "subscribed"
        q.put(("prices.live", {"at": datetime.now(tz=UTC).isoformat(), "p": {"XRPUSDT": "0.5"}}))
        assert ws.receive_json()["p"] == "0.5"
        at = datetime.now(tz=UTC).isoformat()
        redis.keys[live.PRICES_KEY] = json.dumps({"at": at, "p": {"XRPUSDT": "0.501"}})
        q.put(("!", None))  # обрыв: сообщение с 0.501 ушло, пока хаб не был подписан
        assert ws.receive_json() == {"t": "tick", "s": "XRPUSDT", "p": "0.501", "at": at}
        assert len(redis.subs) == 2 and fresh.prices["XRPUSDT"] == "0.501"


def test_batch_and_forming_options_over_websocket(broker: Broker) -> None:
    q, _, _ = broker
    with TestClient(app) as tc, tc.websocket_connect("/v1/ws") as ws:
        ws.send_text(json.dumps({"sub": ["BTCUSDT", "ETHUSDT"], "batch": True, "forming": False}))
        assert ws.receive_json() == {"t": "subscribed", "n": 2}
        q.put(("prices.live", {"at": "A1", "c": {"BTCUSDT": CANDLE}}))
        q.put(("prices.live", {"at": "A1", "p": {"BTCUSDT": "1", "ETHUSDT": "2"}}))
        assert ws.receive_json() == {
            "t": "ticks",
            "at": "A1",
            "p": {"BTCUSDT": "1", "ETHUSDT": "2"},
        }
