"""Разбор событий Binance в market-data и тикер живых цен (без сети, БД и Redis)."""

from __future__ import annotations

import asyncio
import json
import time
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import httpx
import pytest

from app.workers import market_data as mdmod
from app.workers.market_data import CHANNEL_PRICES, RATE_LIMIT_PAUSE, MarketData
from engine.candles import Candle, Timeframe


class FakeRedis:
    """Публикации и ключи — в память; ``fail`` — Redis недоступен."""

    def __init__(self) -> None:
        self.published: list[tuple[str, dict[str, Any]]] = []
        self.keys: dict[str, Any] = {}
        self.fail = False

    async def publish(self, channel: str, data: str) -> int:
        if self.fail:
            raise ConnectionError("redis down")
        self.published.append((channel, json.loads(data)))
        return 1

    async def set(self, key: str, value: Any) -> None:
        self.keys[key] = value


def _md() -> MarketData:
    md = MarketData(redis=FakeRedis())
    md.symbols = {"BTCUSDT": 1}
    return md


def _prices(md: MarketData) -> list[dict[str, Any]]:
    return [m for ch, m in md.redis.published if ch == CHANNEL_PRICES]


KLINE = {
    "s": "BTCUSDT",
    "i": "4h",
    "t": 1704067200000,
    "o": "42000.1",
    "h": "42500",
    "l": "41800",
    "c": "42300",
    "v": "1234.5",
    "q": "52000000",
    "n": 1000,
    "x": False,
}


def test_kline_open_then_closed_and_event() -> None:
    md = _md()
    md.on_kline(KLINE)
    key = (1, "4h", datetime(2024, 1, 1, tzinfo=UTC))
    assert md.candle_buffer[key]["is_closed"] is False and md.closed_events == []
    md.on_kline({**KLINE, "c": "42400", "x": True})
    assert md.candle_buffer[key]["close"] == Decimal("42400") and md.candle_buffer[key]["is_closed"]
    assert md.closed_events[0]["tf"] == "4h"
    assert md.closed_events[0]["close_time"] == "2024-01-01T04:00:00+00:00"
    md.on_kline({**KLINE, "s": "UNKNOWN"})
    assert len(md.candle_buffer) == 1


def test_force_order_aggregation_by_minute_and_side() -> None:
    md = _md()
    t = 1704067230000  # 00:00:30
    md.on_force_order({"s": "BTCUSDT", "S": "SELL", "q": "2", "ap": "42000", "T": t})
    md.on_force_order({"s": "BTCUSDT", "S": "BUY", "q": "1", "ap": "42000", "T": t + 10_000})
    md.on_force_order({"s": "BTCUSDT", "S": "SELL", "q": "1", "ap": "42000", "T": t + 60_000})
    minute = datetime(2024, 1, 1, 0, 0, tzinfo=UTC)
    assert md.liq_buffer[(1, minute)] == [Decimal(84000), Decimal(42000)]
    assert md.liq_buffer[(1, datetime(2024, 1, 1, 0, 1, tzinfo=UTC))][0] == Decimal(42000)


def test_streams_are_chunked() -> None:
    md = _md()
    md.symbols = {f"S{i}USDT": i for i in range(40)}
    chunks = md._streams()
    assert sum(len(c) for c in chunks) == 40 * 5
    assert all(len(c) <= 150 for c in chunks) and len(chunks) == 2


def test_put_candle_rest_fallback_publishes_closed_once() -> None:
    md = _md()
    t0 = datetime(2026, 10, 25, 12, 0, tzinfo=UTC)
    c = Candle(t0, Decimal(1), Decimal(2), Decimal(1), Decimal("1.5"), Decimal(10))
    md._put_candle("BTCUSDT", 1, "1m", c, closed=True)
    md._put_candle("BTCUSDT", 1, "1m", c, closed=True)  # повторный опрос той же свечи
    assert len(md.closed_events) == 1 and md.closed_events[0]["close"] == "1.5"
    md._put_candle(
        "BTCUSDT",
        1,
        "1m",
        Candle(t0, Decimal(1), Decimal(2), Decimal(1), Decimal(1), Decimal(1)),
        closed=False,
    )
    assert len(md.closed_events) == 1 and md.candle_buffer[(1, "1m", t0)]["is_closed"] is False


# --- живые цены (план 2A.3, ADR-0010) ---------------------------------------------------------


class Binance:
    """Поддельный ``/fapi/v1/ticker/price``: ответы по очереди, счётчик запросов."""

    def __init__(self, *responses: Any) -> None:
        self.responses = list(responses)
        self.calls: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        r = self.responses.pop(0) if len(self.responses) > 1 else self.responses[0]
        if isinstance(r, Exception):
            raise r
        if isinstance(r, httpx.Response):
            return r
        return httpx.Response(200, json=r, headers={"X-MBX-USED-WEIGHT-1M": "42"})

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self))


def _tick(**prices: str) -> list[dict[str, Any]]:
    return [{"symbol": s, "price": p, "time": 1} for s, p in prices.items()]


def _cycles(md: MarketData, binance: Binance, n: int) -> None:
    async def run() -> None:
        async with binance.client() as client:
            for _ in range(n):
                await md.ticker_cycle(client)

    asyncio.run(run())


def test_ticker_one_request_for_all_symbols_and_only_changed_prices() -> None:
    md = _md()
    md.symbols = {"BTCUSDT": 1, "ETHUSDT": 2}
    binance = Binance(
        _tick(BTCUSDT="67000.10", ETHUSDT="2500.00", DOGEUSDT="0.1"),
        _tick(BTCUSDT="67000.20", ETHUSDT="2500.00", DOGEUSDT="0.2"),
        _tick(BTCUSDT="67000.20", ETHUSDT="2500.00"),
    )
    _cycles(md, binance, 3)
    assert len(binance.calls) == 3  # один запрос на цикл, без symbol — вес 2
    assert all("symbol" not in c.url.params for c in binance.calls)
    assert str(binance.calls[0].url).startswith(mdmod.TICKER_URL)
    msgs = _prices(md)
    # только наши инструменты, цены без хвостовых нулей; дальше — только изменившиеся
    assert [m["p"] for m in msgs] == [
        {"BTCUSDT": "67000.1", "ETHUSDT": "2500"},
        {"BTCUSDT": "67000.2"},
        {},  # без изменений сообщение всё равно уходит: поток цен жив
    ]
    assert all(datetime.fromisoformat(m["at"]).tzinfo is not None for m in msgs)
    assert md.n_ticks == 3 and md.n_tick_prices == 3 and md.used_weight == 42
    st = md.status()
    assert st["ticks"] == 3 and st["prices_mode"] == "rest" and st["used_weight_1m"] == 42


@pytest.mark.parametrize("code", [418, 429])
def test_ticker_rate_limit_pauses_ticker_and_candle_polling(code: int) -> None:
    md = _md()
    binance = Binance(httpx.Response(code, headers={"Retry-After": "7"}), _tick(BTCUSDT="1"))
    _cycles(md, binance, 3)
    # после 418/429 — пауза не короче RATE_LIMIT_PAUSE: второй и третий циклы без запросов
    assert len(binance.calls) == 1
    assert md.poll_pause_until >= time.time() + RATE_LIMIT_PAUSE - 5
    assert _prices(md) == [] and md.n_ticks == 0


def test_ticker_timeout_and_bad_json_do_not_break_the_loop() -> None:
    md = _md()
    binance = Binance(
        httpx.ReadTimeout("timeout"),
        httpx.Response(500),
        httpx.Response(200, content=b"not json"),
        _tick(BTCUSDT="5"),
    )
    _cycles(md, binance, 4)
    assert md.n_ticker_errors == 3
    assert [m["p"] for m in _prices(md)] == [{"BTCUSDT": "5"}]
    assert md.poll_pause_until == 0.0  # 500 и таймаут — не лимит, пауза не нужна


def test_ticker_loop_runs_every_second_and_survives_redis_errors(monkeypatch: Any) -> None:
    monkeypatch.setattr(mdmod, "TICKER_EVERY", 0.01)
    md = _md()
    md.redis.fail = True
    binance = Binance(_tick(BTCUSDT="1"))

    async def run() -> None:
        task = asyncio.create_task(md.ticker(httpx.MockTransport(binance)))
        await asyncio.sleep(0.08)
        md.redis.fail = False
        await asyncio.sleep(0.05)
        md.stop.set()
        await asyncio.wait_for(task, 1)

    asyncio.run(run())
    assert len(binance.calls) >= 4  # цикл не упал на ошибках Redis
    assert md.n_ticker_errors >= 1 and md.n_ticks >= 1


def test_ws_mode_prices_from_klines_throttled_without_rest() -> None:
    md = _md()
    kl = {**KLINE, "i": "1m", "t": 1704067200000}
    md.on_kline({**kl, "c": "42001"})
    md.on_kline({**kl, "c": "42002", "h": "42600"})  # за секунду — только последняя цена
    binance = Binance(_tick(BTCUSDT="1"))
    _cycles(md, binance, 2)
    assert binance.calls == []  # стрим жив — REST-тикер не тратит вес
    assert [m["p"] for m in _prices(md)] == [{"BTCUSDT": "42002"}, {}]
    assert md.forming["BTCUSDT"] == {
        "t": 1704067200,
        "o": "42000.1",
        "h": "42600",
        "l": "41800",
        "c": "42002",
        "v": "1234.5",
    }
    assert md.status()["prices_mode"] == "ws"
    # закрытие минуты убирает её формирующуюся версию; старшие tf цену не трогают
    md.on_kline({**kl, "c": "42003", "x": True})
    assert "BTCUSDT" not in md.forming
    md.on_kline({**KLINE, "c": "41900"})
    assert md.ws_prices == {"BTCUSDT": "42003"}
    # стрим замолчал дольше TICKER_WS_FRESH — снова REST
    md.last_kline_at = time.time() - mdmod.TICKER_WS_FRESH - 1
    _cycles(md, binance, 1)
    assert len(binance.calls) == 1 and _prices(md)[-1]["p"] == {"BTCUSDT": "1"}


class FakeHistory:
    def __init__(self, now: datetime) -> None:
        m = now.replace(second=0, microsecond=0)
        self.m1 = [
            Candle(
                m - timedelta(minutes=1), Decimal(1), Decimal(3), Decimal(1), Decimal(2), Decimal(5)
            ),
            Candle(m, Decimal(2), Decimal(4), Decimal("1.5"), Decimal("3.25"), Decimal("0.5")),
        ]

    def fetch_rest(
        self, symbol: str, tf: Timeframe, start: datetime, end: datetime
    ) -> list[Candle]:
        return self.m1 if tf is Timeframe.M1 else []


def test_rest_poll_publishes_forming_minute_after_closed() -> None:
    md = _md()
    now = datetime.now(tz=UTC)
    history = FakeHistory(now)
    assert md._poll_symbol(history, "BTCUSDT", (Timeframe.M1,)) == 2  # type: ignore[arg-type]
    forming = md.forming["BTCUSDT"]
    assert forming["t"] == int(history.m1[1].open_time.timestamp())
    assert (forming["h"], forming["l"], forming["c"], forming["v"]) == ("4", "1.5", "3.25", "0.5")
    assert len(md.closed_events) == 1  # закрытая минута — по-прежнему в candles.closed
    asyncio.run(md.publish_forming())
    assert _prices(md) == [{"at": _prices(md)[0]["at"], "c": {"BTCUSDT": forming}}]
    assert md.forming == {} and md.n_forming == 1
    asyncio.run(md.publish_forming())  # пусто — ничего не публикуем
    assert len(_prices(md)) == 1


def test_rate_limited_poll_also_pauses_ticker() -> None:
    md = _md()

    class Limited:
        def fetch_rest(self, *a: Any) -> list[Candle]:
            req = httpx.Request("GET", "https://fapi.binance.com/fapi/v1/klines")
            resp = httpx.Response(429, request=req, headers={"Retry-After": "x"})
            raise httpx.HTTPStatusError("429", request=req, response=resp)

    assert md._poll_symbol(Limited(), "BTCUSDT", (Timeframe.M1,)) == 0  # type: ignore[arg-type]
    assert md.poll_pause_until >= time.time() + RATE_LIMIT_PAUSE - 5
    binance = Binance(_tick(BTCUSDT="1"))
    _cycles(md, binance, 1)
    assert binance.calls == []
