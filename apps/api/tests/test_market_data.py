"""Разбор событий Binance в market-data и тикер живых цен (без сети, БД и Redis)."""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any
from urllib.parse import urlparse

import httpx
import pytest

from app.workers import market_data as mdmod
from app.workers.market_data import CHANNEL_PRICES, RATE_LIMIT_PAUSE, MarketData
from engine.candles import Candle, Timeframe


class FakeRedis:
    """Публикации и ключи — в память; ``fail`` — Redis недоступен; ``log`` — порядок операций."""

    def __init__(self) -> None:
        self.published: list[tuple[str, dict[str, Any]]] = []
        self.keys: dict[str, Any] = {}
        self.ttl: dict[str, int | None] = {}
        self.log: list[str] = []
        self.fail = False
        self.fail_publish = False

    async def publish(self, channel: str, data: str) -> int:
        if self.fail or self.fail_publish:
            raise ConnectionError("redis down")
        self.published.append((channel, json.loads(data)))
        self.log.append(f"publish {channel}")
        return 1

    async def set(self, key: str, value: Any, ex: int | None = None) -> None:
        if self.fail:
            raise ConnectionError("redis down")
        self.keys[key] = value
        self.ttl[key] = ex
        self.log.append(f"set {key}")

    async def aclose(self) -> None:
        return None


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
KLINE_STREAMS = ("kline_1m", "kline_4h", "kline_1d", "kline_1w")


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
    # снимок незакрытой свечи, пришедший после её закрытия (ответ REST отстал от стрима), устарел:
    # раньше он перезаписывал закрытую строку незакрытой, а событие уже стояло в очереди
    md._put_candle(
        "BTCUSDT",
        1,
        "1m",
        Candle(t0, Decimal(1), Decimal(2), Decimal(1), Decimal(1), Decimal(1)),
        closed=False,
    )
    row = md.candle_buffer[(1, "1m", t0)]
    assert (
        len(md.closed_events) == 1 and row["is_closed"] is True and row["close"] == Decimal("1.5")
    )


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
    assert [m.get("full") for m in msgs] == [True, None, None]  # первое — все цены
    assert all("stale" not in m for m in msgs)
    assert all(datetime.fromisoformat(m["at"]).tzinfo is not None for m in msgs)
    assert md.n_ticks == 3 and md.n_tick_prices == 3 and md.used_weight == 42
    st = md.status()
    assert st["ticks"] == 3 and st["prices_mode"] == "rest" and st["used_weight_1m"] == 42
    # все цены — и в ключ для хаба API, с TTL
    key = json.loads(md.redis.keys[mdmod.PRICES_KEY])
    assert key["p"] == {"BTCUSDT": "67000.2", "ETHUSDT": "2500"} and key["at"] == msgs[-1]["at"]
    assert md.redis.ttl[mdmod.PRICES_KEY] == mdmod.PRICES_KEY_TTL


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
    forming = md.forming["BTCUSDT"]
    assert {k: v for k, v in forming.items() if k != "at"} == {
        "t": 1704067200,
        "o": "42000.1",
        "h": "42600",
        "l": "41800",
        "c": "42002",
        "v": "1234.5",
    }
    # момент снимка — у клиента тик новее снимка не откатывается к его close
    assert abs(datetime.fromisoformat(forming["at"]).timestamp() - time.time()) < 5
    assert md.status()["prices_mode"] == "ws"
    # закрытие минуты убирает её формирующуюся версию; старшие tf цену не трогают
    md.on_kline({**kl, "c": "42003", "x": True})
    assert "BTCUSDT" not in md.forming
    md.on_kline({**KLINE, "c": "41900"})
    assert md.ws_prices == {"BTCUSDT": "42003"}
    # стрим замолчал дольше TICKER_WS_FRESH — снова REST
    md.kline_at["BTCUSDT"] = time.time() - mdmod.TICKER_WS_FRESH - 1
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
    # момент снимка — после ответа биржи (с точностью до миллисекунды)
    assert datetime.fromisoformat(forming["at"]) >= now.replace(
        microsecond=now.microsecond // 1000 * 1000
    )
    assert len(md.closed_events) == 1  # закрытая минута — по-прежнему в candles.closed
    # минута целиком — в событии: хабу /v1/ws не нужно читать её из БД
    assert md.closed_events[0]["candle"] == {
        "t": int(history.m1[0].open_time.timestamp()),
        "o": "1",
        "h": "3",
        "l": "1",
        "c": "2",
        "v": "5",
    }
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


# --- поток цен без дыр: снимок целиком, частичный стрим, старт, Redis и лимиты Binance -------


def test_ticker_full_snapshot_every_n_cycles_and_key_before_publish(monkeypatch: Any) -> None:
    monkeypatch.setattr(mdmod, "TICKER_FULL_EVERY", 3)
    md = _md()
    md.symbols = {"BTCUSDT": 1, "XRPUSDT": 2}
    binance = Binance(*[_tick(BTCUSDT=str(100 + i), XRPUSDT="0.5") for i in range(4)])
    _cycles(md, binance, 4)
    msgs = _prices(md)
    # XRP стоит на месте, но каждое 3-е сообщение несёт все цены: хаб, пропустивший первое, догонит
    assert [m["p"] for m in msgs] == [
        {"BTCUSDT": "100", "XRPUSDT": "0.5"},
        {"BTCUSDT": "101"},
        {"BTCUSDT": "102"},
        {"BTCUSDT": "103", "XRPUSDT": "0.5"},
    ]
    assert [m.get("full") for m in msgs] == [True, None, None, True]
    assert md.status()["ticks_full"] == 2
    # ключ prices:last — до публикации: хаб подписался между ними — прочтёт ключ
    assert md.redis.log[:2] == [f"set {mdmod.PRICES_KEY}", f"publish {CHANNEL_PRICES}"]


def test_ticker_change_is_resent_when_publish_failed() -> None:
    md = _md()
    binance = Binance(_tick(BTCUSDT="1"), _tick(BTCUSDT="2"), _tick(BTCUSDT="2"))

    async def run() -> None:
        async with binance.client() as client:
            await md.ticker_cycle(client)
            md.redis.fail_publish = True
            with pytest.raises(ConnectionError):
                await md.ticker_cycle(client)
            md.redis.fail_publish = False
            await md.ticker_cycle(client)

    asyncio.run(run())
    # изменение 1 → 2 не потерялось: «опубликованная» цена обновляется только после публикации
    assert [m["p"] for m in _prices(md)] == [{"BTCUSDT": "1"}, {"BTCUSDT": "2"}]


def test_partial_stream_takes_silent_symbols_from_rest_or_marks_them_stale() -> None:
    md = _md()
    md.symbols = {"BTCUSDT": 1, "ETHUSDT": 2}
    kl = {**KLINE, "i": "1m", "t": 1704067200000}
    binance = Binance(_tick(BTCUSDT="1", ETHUSDT="3000"), _tick(BTCUSDT="1", ETHUSDT="3001"))
    # соединение ETH молчит (переподключается), BTC идёт по стриму
    md.on_kline({**kl, "c": "42000"})
    _cycles(md, binance, 1)
    md.on_kline({**kl, "c": "42001"})
    _cycles(md, binance, 1)
    assert len(binance.calls) == 2  # REST — ради ETH, хотя стрим BTC жив
    assert [m["p"] for m in _prices(md)] == [
        {"BTCUSDT": "42000", "ETHUSDT": "3000"},  # BTC — из стрима, не из REST
        {"BTCUSDT": "42001", "ETHUSDT": "3001"},
    ]
    st = md.status()
    assert st["prices_mode"] == "mixed" and st["stale_prices"] == 0
    # REST на паузе после 429: ETH без свежей цены — в stale (хаб не повторяет её как живую)
    md.poll_pause_until = time.time() + 60
    md.on_kline({**kl, "c": "42002"})
    _cycles(md, binance, 1)
    assert len(binance.calls) == 2
    assert _prices(md)[-1]["p"] == {"BTCUSDT": "42002"}
    assert _prices(md)[-1]["stale"] == ["ETHUSDT"] and md.status()["stale_prices"] == 1
    # ни одной свежей цены — сообщения нет: у клиентов честно «без связи»
    md.kline_at.clear()
    _cycles(md, binance, 1)
    assert len(_prices(md)) == 3


def test_full_snapshot_leaves_out_stale_symbols(monkeypatch: Any) -> None:
    monkeypatch.setattr(mdmod, "TICKER_FULL_EVERY", 1)
    md = _md()
    md.symbols = {"BTCUSDT": 1, "ETHUSDT": 2}
    md.last_prices = {"BTCUSDT": "1", "ETHUSDT": "3000"}
    md.poll_pause_until = time.time() + 60
    md.on_kline({**KLINE, "i": "1m", "c": "42010"})
    _cycles(md, Binance(_tick(BTCUSDT="9")), 1)
    msg = _prices(md)[-1]
    assert msg["full"] is True and msg["p"] == {"BTCUSDT": "42010"} and msg["stale"] == ["ETHUSDT"]
    assert json.loads(md.redis.keys[mdmod.PRICES_KEY])["p"] == {"BTCUSDT": "42010"}


def test_poller_polls_only_symbols_with_silent_stream(monkeypatch: Any) -> None:
    monkeypatch.setattr(mdmod, "POLL_EVERY", 0.01)
    md = _md()
    md.symbols = {"BTCUSDT": 1, "ETHUSDT": 2}
    md.kline_at["BTCUSDT"] = time.time() + 3600  # стрим BTC жив всё время теста
    polled: list[tuple[str, tuple[Timeframe, ...]]] = []

    def poll(history: Any, symbol: str, tfs: tuple[Timeframe, ...]) -> int:
        polled.append((symbol, tfs))
        return 1

    monkeypatch.setattr(md, "_poll_symbol", poll)

    async def run() -> None:
        task = asyncio.create_task(md.poller())
        await asyncio.sleep(0.15)
        md.stop.set()
        await asyncio.wait_for(task, 2)

    asyncio.run(run())
    assert polled and {s for s, _ in polled} == {"ETHUSDT"}
    assert polled[0][1] == mdmod.TIMEFRAMES  # первый цикл — все tf
    assert md.status()["mode"] == "mixed"


class FakeSession:
    """БД без закрытых свечей: догрузка запрашивает все tf."""

    def __enter__(self) -> FakeSession:
        return self

    def __exit__(self, *a: Any) -> None:
        return None

    def execute(self, *a: Any) -> Any:
        class Result:
            def scalar(self) -> None:
                return None

        return Result()

    def commit(self) -> None:
        return None


def test_backfill_stops_on_rate_limit_and_resumes_after_pause(monkeypatch: Any) -> None:
    monkeypatch.setattr(mdmod, "SessionLocal", FakeSession)
    monkeypatch.setattr(mdmod, "upsert_candles", lambda *a: None)
    md = _md()
    md.symbols = {"BTCUSDT": 1, "ETHUSDT": 2}
    calls: list[str] = []

    class Limited:
        def fetch_rest(self, symbol: str, *a: Any) -> list[Candle]:
            calls.append(symbol)
            req = httpx.Request("GET", "https://fapi.binance.com/fapi/v1/klines")
            resp = httpx.Response(429, request=req, headers={"Retry-After": "300"})
            raise httpx.HTTPStatusError("429", request=req, response=resp)

    class Ok:
        def fetch_rest(self, symbol: str, *a: Any) -> list[Candle]:
            calls.append(symbol)
            return []

    # первый же 429 останавливает догрузку и ставит общую паузу (раньше слала ещё сотни запросов)
    assert md.backfill(history=Limited()) is False
    assert calls == ["BTCUSDT"] and md.poll_pause_until >= time.time() + 290
    assert md.backfill_needed == {"BTCUSDT", "ETHUSDT"}
    # на паузе — ни одного запроса
    assert md.backfill(["ETHUSDT"], history=Ok()) is False and calls == ["BTCUSDT"]
    # после паузы недогруженное догружается, список очищается
    md.poll_pause_until = 0.0
    assert md.backfill(sorted(md.backfill_needed), history=Ok()) is True
    assert md.backfill_needed == set() and len(calls) == 1 + 2 * len(mdmod.TIMEFRAMES)


class FakeBinanceWs:
    """Соединение Binance: подтверждение подписки, затем сообщения сценария, затем тишина.
    Число в сценарии — пауза (секунды) перед следующим сообщением."""

    def __init__(self, script: list[Any]) -> None:
        self.script = [json.dumps({"result": None, "id": 1}), *script]

    async def __aenter__(self) -> FakeBinanceWs:
        return self

    async def __aexit__(self, *a: Any) -> None:
        return None

    async def send(self, msg: str) -> None:
        return None

    async def recv(self) -> str:
        while self.script and isinstance(self.script[0], float):
            await asyncio.sleep(self.script.pop(0))
        if not self.script:
            await asyncio.sleep(3600)
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return str(item)


class RestHistory:
    """REST Binance для сверки и догрузки: свечи по tf в окне запроса; ``log`` — порядок."""

    def __init__(self, candles: dict[Timeframe, list[Candle]], log: list[Any]) -> None:
        self.candles = candles
        self.log = log
        self.calls: list[tuple[str, Timeframe, datetime, datetime]] = []

    def fetch_rest(
        self, symbol: str, tf: Timeframe, start: datetime, end: datetime
    ) -> list[Candle]:
        self.calls.append((symbol, tf, start, end))
        self.log.append(("fetch", tf.value))
        return [c for c in self.candles.get(tf, []) if start <= c.open_time <= end]


def _run_connection(
    md: MarketData,
    monkeypatch: Any,
    scripts: list[list[Any]],
    seconds: float,
    rest: RestHistory | None = None,
) -> list[Any]:
    """Соединение по сценариям (по одному на подключение); возвращает вызовы догрузки. REST —
    ``rest`` (по умолчанию без свечей): сеть в тестах не трогаем."""
    backfills: list[Any] = []
    rest = rest if rest is not None else RestHistory({}, [])

    def backfill(symbols: Any = None, history: Any = None) -> bool:
        backfills.append(symbols)
        rest.log.append(("backfill", symbols))
        return True

    connects = iter(scripts)
    monkeypatch.setattr(md, "backfill", backfill)
    monkeypatch.setattr(mdmod, "BinanceHistory", lambda *a, **k: rest)
    monkeypatch.setattr(mdmod, "connect", lambda *a, **k: FakeBinanceWs(next(connects, [])))

    async def run() -> None:
        task = asyncio.create_task(md.connection(md._streams()[0], 0))
        await asyncio.sleep(seconds)
        md.stop.set()
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    asyncio.run(run())
    return backfills


def test_silent_stream_reconnects_without_backfill(monkeypatch: Any) -> None:
    monkeypatch.setattr(mdmod, "SILENCE_TIMEOUT", 0.02)
    monkeypatch.setattr(mdmod, "RECONNECT_MIN", 0.01)
    monkeypatch.setattr(mdmod, "RECONNECT_MAX", 0.02)
    md = _md()
    md.symbols = {"BTCUSDT": 1, "ETHUSDT": 2}
    # production: подписка подтверждена, данных нет — раньше каждые ~61 с догрузка (236 запросов)
    rest = RestHistory({}, [])
    backfills = _run_connection(md, monkeypatch, [[] for _ in range(50)], 0.3, rest)
    assert backfills == [] and rest.calls == []  # ни догрузки, ни сверки


def test_dropped_stream_with_data_resyncs_its_symbols_from_sync_point(monkeypatch: Any) -> None:
    monkeypatch.setattr(mdmod, "RECONNECT_MIN", 0.01)
    md = _md()
    md.symbols = {"BTCUSDT": 1}
    m = datetime.now(tz=UTC).replace(second=0, microsecond=0)
    for tf in mdmod.TIMEFRAMES:
        md.last_closed[(1, tf.value)] = m - tf.delta * 3
    kline = json.dumps({"e": "kline", "k": {**KLINE, "i": "1m"}})
    # сверка — когда по соединению пошли данные (раньше догрузка шла до подключения: свеча,
    # закрывшаяся между догрузкой и данными, терялась); без данных — без неё
    scripts = [[kline, 0.05, OSError("reset")], [], [kline]]
    monkeypatch.setattr(mdmod, "SILENCE_TIMEOUT", 0.05)
    rest = RestHistory({}, [])
    backfills = _run_connection(md, monkeypatch, scripts, 0.3, rest)
    assert backfills == [] and md.n_klines == 2
    # две сверки по 4 tf, каждая — от точки сверки (последней опубликованной), без БД
    assert len(rest.calls) == 2 * len(mdmod.TIMEFRAMES)
    assert {(tf, start) for _, tf, start, _ in rest.calls} == {
        (tf, m - tf.delta * 2) for tf in mdmod.TIMEFRAMES
    }
    assert md.held == {}  # сверенные пары больше не ждут


def _minute_candles(m: datetime) -> list[Candle]:
    """Минута ``m`` закрыта (high 105 — после обрыва), ``m + 1`` идёт."""
    return [
        Candle(m, Decimal(100), Decimal(105), Decimal(99), Decimal(104), Decimal(7)),
        Candle(
            m + timedelta(minutes=1),
            Decimal(104),
            Decimal(106),
            Decimal(103),
            Decimal(105),
            Decimal(1),
        ),
    ]


class MemDb:
    """БД свечей в памяти: запросы догрузки, ``upsert_candles`` (REST мимо буфера) и запись буфера.
    ``log`` — порядок записей: (откуда, инструмент, tf, open_time, is_closed)."""

    def __init__(self) -> None:
        self.rows: dict[tuple[int, str, datetime], bool] = {}
        self.log: list[tuple[str, int, str, datetime, bool]] = []

    def write(self, src: str, inst: int, tf: str, t: datetime, closed: bool) -> None:
        self.rows[(inst, tf, t)] = closed
        self.log.append((src, inst, tf, t, closed))

    def install(self, monkeypatch: Any, md: MarketData) -> MemDb:
        db = self

        class Session:
            def __enter__(self) -> Session:
                return self

            def __exit__(self, *a: Any) -> None:
                return None

            def execute(self, sql: Any, p: dict[str, Any]) -> Any:
                q = str(sql)
                keys = [k[2] for k, closed in db.rows.items() if k[:2] == (p["i"], p["tf"])]
                if "max(open_time)" in q:
                    vals = [t for t in keys if db.rows[(p["i"], p["tf"], t)]]
                    res = max(vals) if vals else None
                else:
                    vals = [
                        t
                        for t in keys
                        if not db.rows[(p["i"], p["tf"], t)] and p["w"] <= t <= p["due"]
                    ]
                    res = min(vals) if vals else None

                class Result:
                    def scalar(self) -> Any:
                        return res

                return Result()

            def commit(self) -> None:
                return None

        def upsert(s: Any, inst: int, tf: Timeframe, cs: list[Candle]) -> None:
            for c in cs:
                db.write("rest", inst, tf.value, c.open_time, True)

        def flush(candles: list[dict[str, Any]], liqs: Any) -> None:
            for c in candles:
                db.write(
                    "flush", c["instrument_id"], c["timeframe"], c["open_time"], c["is_closed"]
                )

        monkeypatch.setattr(mdmod, "SessionLocal", Session)
        monkeypatch.setattr(mdmod, "upsert_candles", upsert)
        monkeypatch.setattr(md, "_flush_sync", flush)
        return self

    def closed_in_order(self, inst: int, since: datetime) -> bool:
        """Трекер идёт от последней обработанной минуты: закрытая минута не должна появиться в БД
        раньше незакрытой (или отсутствующей) более старой — её он пропустил бы навсегда."""
        closed: set[datetime] = set()
        for _, i, tf, t, is_closed in self.log:
            if (i, tf) != (inst, "1m") or not is_closed or t <= since:
                continue
            m = since + timedelta(minutes=1)
            while m < t:
                if m not in closed:
                    return False
                m += timedelta(minutes=1)
            closed.add(t)
        return True


def _m1(t: datetime, high: int = 105) -> Candle:
    return Candle(t, Decimal(100), Decimal(high), Decimal(99), Decimal(104), Decimal(7))


def _closed_1m(md: MarketData) -> list[datetime]:
    return [
        datetime.fromisoformat(e["open_time"])
        for e in _closed(md) + md.closed_events + md.ready_events
        if e["tf"] == "1m"
    ]


def test_candle_closed_while_disconnected_is_written_closed_and_published(
    monkeypatch: Any,
) -> None:
    # MD-WS-HOLE: Binance после подписки шлёт только текущую свечу. Раньше минута, закрывшаяся
    # без соединения, оставалась в БД незакрытой (high со снимка до обрыва), без candles.closed,
    # и её не чинили ни опрос (стрим жив), ни следующая догрузка (начинает после последней
    # закрытой)
    monkeypatch.setattr(mdmod, "RECONNECT_MIN", 0.01)
    md = _md()
    db = MemDb().install(monkeypatch, md)
    m = datetime.now(tz=UTC).replace(second=0, microsecond=0) - timedelta(minutes=1)
    db.write("seed", 1, "1m", m - timedelta(minutes=1), True)
    ohlc = {"o": "100", "h": "101", "l": "99", "c": "100"}
    before = {**KLINE, **ohlc, "i": "1m", "t": int(m.timestamp() * 1000)}
    after = {**before, "t": int((m + timedelta(minutes=1)).timestamp() * 1000), "h": "106"}
    log: list[Any] = []
    rest = RestHistory({Timeframe.M1: _minute_candles(m)}, log)
    scripts = [
        [json.dumps({"e": "kline", "k": before}), 0.05, OSError("reset")],
        [json.dumps({"e": "kline", "k": after})],
    ]
    _run_connection(md, monkeypatch, scripts, 0.3, rest)
    asyncio.run(md.flush_once())
    # минута m закрыта в БД по REST (high 105 — после обрыва) и опубликована один раз
    assert db.rows[(1, "1m", m)] is True
    assert ("rest", 1, "1m", m, True) in db.log
    assert _closed_1m(md) == [m]
    # идущую минуту сверка не трогает — её пишет стрим
    assert md.candle_buffer == {} and db.rows[(1, "1m", m + timedelta(minutes=1))] is False
    # две сверки: после первых данных (точки сверки нет — по БД) и после переподключения
    assert len([x for x in log if x == ("fetch", "1m")]) == 2
    assert md.status()["resynced"] == 1


def test_resync_publishes_every_minute_closed_while_disconnected_however_long_it_took(
    monkeypatch: Any,
) -> None:
    # MD-RESYNC-WINDOW-LOSES-CLOSED-EVENTS / MD-HOLE-EVENT-NEVER-PUBLISHED (a): после обрыва
    # догрузка писала пропуск в БД без событий, а окно сверки (последние ~2 минуты) считалось
    # после неё — минута, закрывшаяся раньше, оставалась без candles.closed (в живом прогоне — у 54
    # из 59 инструментов). Теперь всё от точки сверки (последней опубликованной) — с событием
    md = _md()
    db = MemDb().install(monkeypatch, md)
    now = datetime.now(tz=UTC).replace(second=0, microsecond=0)
    synced = now - timedelta(minutes=6)
    db.write("seed", 1, "1m", synced, True)
    db.write("seed", 1, "1m", synced + timedelta(minutes=1), False)  # шла при обрыве
    md.last_closed[(1, "1m")] = synced
    minutes = [synced + timedelta(minutes=k) for k in range(7)]  # до идущей включительно
    rest = RestHistory({Timeframe.M1: [_m1(t) for t in minutes]}, [])
    assert md.resync(["BTCUSDT"], history=rest) == 5
    asyncio.run(md.flush_once())
    m1_calls = [c for c in rest.calls if c[1] is Timeframe.M1]
    assert m1_calls[0][2] == synced + timedelta(minutes=1)  # от точки сверки, не «now − 2 мин»
    assert _closed_1m(md) == minutes[1:6]  # каждая закрывшаяся — один раз, по порядку
    assert all(db.rows[(1, "1m", t)] for t in minutes[1:6])
    assert md.last_closed[(1, "1m")] == minutes[5]
    # события — после записи строк: в БД они попали раньше публикации
    assert md.closed_events == [] and md.ready_events == []


def test_stream_close_during_resync_waits_for_the_hole_and_both_are_published(
    monkeypatch: Any,
) -> None:
    # MD-GAP-ORDER-TRACKER-SKIP: сверка шла в фоне, а стрим уже писал закрытие следующей минуты —
    # она попадала в БД раньше пропущенной, трекер (догон от last_candle_time) пропускал дыру
    # навсегда. MD-HOLE-EVENT-NEVER-PUBLISHED (b): last_closed, сдвинутый стримом, глушил
    # событие пропущенной минуты. Теперь закрытия ждут сверки пары (hold)
    md = _md()
    db = MemDb().install(monkeypatch, md)
    now = datetime.now(tz=UTC).replace(second=0, microsecond=0)
    hole, nxt = now - timedelta(minutes=2), now - timedelta(minutes=1)
    synced = hole - timedelta(minutes=1)
    db.write("seed", 1, "1m", synced, True)
    db.write("seed", 1, "1m", hole, False)
    md.last_closed[(1, "1m")] = synced
    gen = md.hold(["BTCUSDT"])  # по новому соединению пошли данные
    # стрим закрывает следующую минуту раньше, чем сверка дошла до инструмента
    md.on_kline({**KLINE, "i": "1m", "t": int(nxt.timestamp() * 1000), "h": "42600", "x": True})
    asyncio.run(md.flush_once())
    assert db.rows.get((1, "1m", nxt)) is None and _closed(md) == []  # ждёт
    assert md.last_closed[(1, "1m")] == synced
    rest = RestHistory({Timeframe.M1: [_m1(hole), _m1(nxt, 110), _m1(now)]}, [])
    md.resync(["BTCUSDT"], history=rest, gen=gen)
    asyncio.run(md.flush_once())
    assert db.closed_in_order(1, synced)
    assert _closed_1m(md) == [hole, nxt]  # дыра — тоже с событием, следующая — без второго
    assert db.rows[(1, "1m", nxt)] is True and md.held == {}


def test_hold_is_released_only_by_its_own_resync_or_after_hold_max(monkeypatch: Any) -> None:
    md = _md()
    MemDb().install(monkeypatch, md)
    now = datetime.now(tz=UTC).replace(second=0, microsecond=0)
    for tf in mdmod.TIMEFRAMES:
        md.last_closed[(1, tf.value)] = now - tf.delta * 2
    first = md.hold(["BTCUSDT"])
    second = md.hold(["BTCUSDT"])  # новый обрыв, пока шла сверка первого
    md.resync(["BTCUSDT"], history=RestHistory({}, []), gen=first)
    assert len(md.held) == len(mdmod.TIMEFRAMES)  # прежняя сверка новое удержание не снимает
    md.on_kline(
        {**KLINE, "i": "1m", "t": int((now - timedelta(minutes=1)).timestamp() * 1000), "x": True}
    )
    assert md.closed_events == [] and (1, "1m") in md.deferred
    # сверка не удалась (ошибка REST, пауза 418/429): пара ждёт не дольше HOLD_MAX
    clock = [time.monotonic() + mdmod.HOLD_MAX + 1]
    monkeypatch.setattr(mdmod.time, "monotonic", lambda: clock[0])
    asyncio.run(md.flush_once())
    assert md.held == {} and md.deferred == {}
    assert [e["tf"] for e in _closed(md)] == ["1m"]
    assert second == first + 1


def test_startup_publishes_closes_missed_while_down_but_never_replays_old_ones(
    monkeypatch: Any,
) -> None:
    # MD-STARTUP-REPLAYS-OLD-CLOSES: сверка при старте без точки сверки брала последние две свечи
    # каждого tf и публиковала их снова (недельную — до 7 дней спустя: ключи «сделано» у алертов
    # уже истекли). Теперь точка сверки при старте — последняя закрытая строка в БД, событие —
    # только свече новее неё и не старше LATE_CLOSE_MAX
    md = _md()
    db = MemDb().install(monkeypatch, md)
    now = datetime.now(tz=UTC)
    m = now.replace(second=0, microsecond=0)
    w1 = [m - timedelta(days=30) + timedelta(weeks=k) for k in range(6)]  # закрытые и идущая
    w1 = [t for t in w1 if t <= now]
    d1 = [m - timedelta(days=5) + timedelta(days=k) for k in range(6)]
    h4 = [m - timedelta(hours=14) + timedelta(hours=4 * k) for k in range(4)]
    m1 = [m - timedelta(minutes=60 - k) for k in range(61)]
    closed_db = {
        Timeframe.W1: [t for t in w1 if t + Timeframe.W1.delta <= now],
        Timeframe.D1: d1[:5],
        Timeframe.H4: h4[:2],  # старт после простоя: 4h, закрывшаяся 2 ч назад, — не в БД
        Timeframe.M1: m1[:5],  # и 55 минут простоя
    }
    for tf, ts in closed_db.items():
        for t in ts:
            db.write("seed", 1, tf.value, t, True)
    # старый процесс остановился с идущей минутой — строка незакрытая
    db.write("seed", 1, "1m", m1[5], False)
    rest = RestHistory(
        {
            Timeframe.W1: [_m1(t) for t in w1],
            Timeframe.D1: [_m1(t) for t in d1],
            Timeframe.H4: [_m1(t) for t in h4],
            Timeframe.M1: [_m1(t) for t in m1],
        },
        [],
    )
    assert md.backfill(history=rest) is True
    # первая сверка после старта — по точке сверки, ничего не публикует повторно
    md.resync(["BTCUSDT"], history=rest, gen=md.hold(["BTCUSDT"]))
    asyncio.run(md.flush_once())
    published = [(e["tf"], datetime.fromisoformat(e["open_time"])) for e in _closed(md)]
    late = now - timedelta(seconds=mdmod.LATE_CLOSE_MAX)
    # минуты простоя — закрыты в БД все, события — только за последние LATE_CLOSE_MAX
    assert all(db.rows[(1, "1m", t)] for t in m1[5:-1])
    expected = [("1m", t) for t in m1[5:-1] if t + timedelta(minutes=1) >= late]
    assert published == expected and len(expected) >= 29
    assert md.last_closed[(1, "1m")] == m1[-2]
    assert md.last_closed[(1, "4h")] == h4[2] and db.rows[(1, "4h", h4[2])]  # без события
    assert md.last_closed[(1, "1w")] == closed_db[Timeframe.W1][-1]
    assert md.last_closed[(1, "1d")] == d1[4]
    # повторный старт (точки сверки нет, БД полна) — ни одного события
    md2 = _md()
    db.install(monkeypatch, md2)
    md2.backfill(history=rest)
    md2.resync(["BTCUSDT"], history=rest)
    asyncio.run(md2.flush_once())
    assert _closed(md2) == []


def test_resync_window_rate_limit_and_errors(monkeypatch: Any) -> None:
    md = _md()
    md.symbols = {"BTCUSDT": 1, "ETHUSDT": 2}
    db = MemDb().install(monkeypatch, md)
    now = datetime.now(tz=UTC)
    m = now.replace(second=0, microsecond=0) - timedelta(minutes=1)
    rest = RestHistory({Timeframe.M1: _minute_candles(m)}, [])
    # без точки сверки — по БД: от последней закрытой строки
    db.write("seed", 1, "1m", m - timedelta(minutes=5), True)
    assert md.resync(["BTCUSDT"], history=rest) == 1
    starts = {tf: start for _, tf, start, _ in rest.calls}
    assert set(starts) == set(mdmod.TIMEFRAMES)
    assert starts[Timeframe.M1] == m - timedelta(minutes=4)
    assert md.last_closed[(1, "1m")] == m
    # с точкой сверки — от неё, без БД; повторная сверка — без второго события
    rest.calls.clear()
    md.resync(["BTCUSDT"], history=rest)
    m1_start = next(s for _, tf, s, _ in rest.calls if tf is Timeframe.M1)
    assert m1_start == m + timedelta(minutes=1)
    assert len(md.closed_events) == 1

    class Failing:
        def __init__(self, code: int) -> None:
            self.code = code
            self.calls = 0

        def fetch_rest(self, *a: Any) -> list[Candle]:
            self.calls += 1
            req = httpx.Request("GET", "https://fapi.binance.com/fapi/v1/klines")
            resp = httpx.Response(self.code, request=req)
            raise httpx.HTTPStatusError(str(self.code), request=req, response=resp)

    # ошибка запроса — инструмент в backfill_needed (догрузит опрос), сверка идёт дальше; пары
    # с ошибкой ждут догрузки (не дольше HOLD_MAX)
    failing = Failing(500)
    gen = md.hold(["BTCUSDT", "ETHUSDT"])
    md.resync(["BTCUSDT", "ETHUSDT"], history=failing, gen=gen)
    assert failing.calls == 2 * len(mdmod.TIMEFRAMES)
    assert md.backfill_needed == {"BTCUSDT", "ETHUSDT"} and len(md.held) == 8
    # догрузка опросом снимает удержание пары
    md.poll_pause_until = 0.0
    assert md.backfill(["BTCUSDT"], history=rest) is True and len(md.held) == 4
    # 429 — пауза: больше ни одного запроса, все инструменты соединения — в backfill_needed
    md.backfill_needed.clear()
    limited = Failing(429)
    md.resync(["BTCUSDT", "ETHUSDT"], history=limited)
    assert limited.calls == 1 and md.backfill_needed == {"BTCUSDT", "ETHUSDT"}
    assert md.poll_pause_until > time.time()


def test_upsert_of_closed_candles_closes_a_row_written_unclosed() -> None:
    # догрузка поверх незакрытой строки раньше обновляла цены, но is_closed оставался false — свеча
    # так и не становилась закрытой (проверено на Postgres: PGlite)
    from sqlalchemy.dialects import postgresql

    from app.forward import upsert_candles

    sql: list[str] = []

    class Session:
        def execute(self, stmt: Any) -> None:
            sql.append(str(stmt.compile(dialect=postgresql.dialect())))

    t0 = datetime(2026, 11, 5, 12, 0, tzinfo=UTC)
    c = Candle(t0, Decimal(100), Decimal(110), Decimal(99), Decimal(104), Decimal(7))
    upsert_candles(Session(), 1, Timeframe.M1, [c])  # type: ignore[arg-type]
    conflict = sql[0].split("ON CONFLICT", 1)[1]
    assert "is_closed = excluded.is_closed" in conflict and "high = excluded.high" in conflict


def test_backfill_starts_from_oldest_unclosed_row_that_should_be_closed(monkeypatch: Any) -> None:
    # минута m не закрылась в БД, а m + 1 закрыта: раньше догрузка начинала после m + 1 — дыра
    # оставалась навсегда
    now = datetime.now(tz=UTC)
    m = now.replace(second=0, microsecond=0) - timedelta(minutes=10)

    class Session(FakeSession):
        def execute(self, sql: Any, params: dict[str, Any]) -> Any:
            stale = "not is_closed" in str(sql)
            value = None
            if params["tf"] == "1m":
                value = m if stale else m + timedelta(minutes=1)
                if stale:
                    at = datetime.now(tz=UTC)
                    assert at - timedelta(minutes=1, seconds=5) <= params["due"]
                    assert params["due"] <= at - timedelta(minutes=1)
                    assert params["w"] <= at - timedelta(minutes=mdmod.REPAIR_WINDOW)

            class Result:
                def scalar(self) -> Any:
                    return value

            return Result()

    monkeypatch.setattr(mdmod, "SessionLocal", Session)
    upserts: list[Any] = []
    monkeypatch.setattr(mdmod, "upsert_candles", lambda s, i, tf, cs: upserts.append((tf, cs)))
    md = _md()
    rest = RestHistory({Timeframe.M1: _minute_candles(m)}, [])
    assert md.backfill(["BTCUSDT"], history=rest) is True
    assert next(s for _, tf, s, _ in rest.calls if tf is Timeframe.M1) == m
    assert [c.open_time for tf, cs in upserts if tf is Timeframe.M1 for c in cs] == [
        m,
        m + timedelta(minutes=1),
    ]
    # точка сверки — последняя закрытая; старая дыра (10 мин) — без события (не новее точки)
    assert md.last_closed[(1, "1m")] == m + timedelta(minutes=1) and md.closed_events == []


def test_ws_url_is_binance_market_category() -> None:
    # kline и forceOrder Binance отдаёт только на /market/: старый /ws подписку подтверждает
    # ({"result": null}), но данных не шлёт (проверка 2026-11-05) — воркер жил на REST,
    # без ликвидаций
    url = urlparse(mdmod.WS_URL)
    assert (url.scheme, url.netloc, url.path) == ("wss", "fstream.binance.com", "/market/ws")
    assert url.query == ""  # потоки — командой SUBSCRIBE, не в адресе


def test_connection_subscribes_by_message_and_parses_market_events(monkeypatch: Any) -> None:
    md = _md()
    md.symbols = {"BTCUSDT": 1, "ETHUSDT": 2}
    urls: list[str] = []
    sent: list[Any] = []
    # события /market/ws после SUBSCRIBE — как есть (raw), без обёртки combined-stream
    kline = json.dumps(
        {"e": "kline", "E": 1704067201000, "s": "BTCUSDT", "k": {**KLINE, "i": "1m"}}
    )
    liq = {"s": "ETHUSDT", "S": "SELL", "o": "LIMIT", "f": "IOC", "q": "0.5", "p": "2200"}
    liq |= {"ap": "2210", "X": "FILLED", "l": "0.5", "z": "0.5", "T": 1704067260123}
    force = json.dumps({"e": "forceOrder", "E": 1704067260130, "o": liq})

    class Ws(FakeBinanceWs):
        async def send(self, msg: str) -> None:
            sent.append(json.loads(msg))

    def fake_connect(url: str, **kw: Any) -> Ws:
        urls.append(url)
        return Ws([kline, force])

    monkeypatch.setattr(mdmod, "connect", fake_connect)
    monkeypatch.setattr(md, "backfill", lambda *a, **k: True)

    async def run() -> None:
        task = asyncio.create_task(md.connection(md._streams()[0], 0))
        await asyncio.sleep(0.05)
        md.stop.set()
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    asyncio.run(run())
    assert urls == ["wss://fstream.binance.com/market/ws"]
    streams = [f"{s}@{x}" for s in ("btcusdt", "ethusdt") for x in (*KLINE_STREAMS, "forceOrder")]
    assert sent == [{"method": "SUBSCRIBE", "params": streams, "id": 1}]
    assert md.n_klines == 1
    minute = datetime(2024, 1, 1, 0, 1, tzinfo=UTC)
    assert md.liq_buffer[(2, minute)] == [Decimal("1105"), Decimal(0)]  # SELL — ликвидирован лонг


def test_flusher_survives_redis_outage_and_republishes_closed(monkeypatch: Any) -> None:
    monkeypatch.setattr(mdmod, "FLUSH_EVERY", 0.01)
    md = _md()
    monkeypatch.setattr(md, "_flush_sync", lambda candles, liqs: None)
    t0 = datetime(2026, 10, 25, 12, 0, tzinfo=UTC)
    for i in range(2):
        c = Candle(
            t0 + timedelta(minutes=i), Decimal(1), Decimal(2), Decimal(1), Decimal(1), Decimal(1)
        )
        md._put_candle("BTCUSDT", 1, "1m", c, closed=True)
    md.redis.fail = True

    async def run() -> None:
        task = asyncio.create_task(md.flusher())
        await asyncio.sleep(0.08)
        assert not task.done()  # раньше ConnectionError завершал запись навсегда
        md.redis.fail = False
        await asyncio.sleep(0.05)
        md.stop.set()
        await asyncio.wait_for(task, 1)

    asyncio.run(run())
    closed = [m for ch, m in md.redis.published if ch == mdmod.CHANNEL_CLOSED]
    assert [e["open_time"] for e in closed] == [
        t0.isoformat(),
        (t0 + timedelta(minutes=1)).isoformat(),
    ]
    assert md.closed_events == [] and md.ready_events == [] and md.n_redis_errors >= 1
    assert mdmod.HEARTBEAT_KEY in md.redis.keys and mdmod.STATUS_KEY in md.redis.keys


def _closed(md: MarketData) -> list[dict[str, Any]]:
    return [m for ch, m in md.redis.published if ch == mdmod.CHANNEL_CLOSED]


def test_closed_candle_is_published_only_after_its_row_is_written(monkeypatch: Any) -> None:
    # MD-CLOSED-BEFORE-FLUSH: закрытие, пришедшее во время записи, раньше публиковалось в конце
    # этой записи — а строка шла следующей; планировщик и алерты читали из БД незакрытую свечу
    md = _md()
    writes: list[list[tuple[str, bool, Decimal]]] = []

    def flush_sync(candles: list[dict[str, Any]], liqs: Any) -> None:
        writes.append([(c["timeframe"], c["is_closed"], c["high"]) for c in candles])
        if len(writes) == 1:
            md.on_kline({**KLINE, "h": "42600", "x": True})  # 4h закрылась, пока шла запись

    monkeypatch.setattr(md, "_flush_sync", flush_sync)
    md.on_kline(KLINE)
    asyncio.run(md.flush_once())
    assert writes == [[("4h", False, Decimal("42500"))]]
    assert _closed(md) == [] and len(md.closed_events) == 1
    asyncio.run(md.flush_once())
    assert writes[1] == [("4h", True, Decimal("42600"))]  # закрытая — без задержки 4h
    assert [e["tf"] for e in _closed(md)] == ["4h"] and md.closed_events == []


def test_flush_error_keeps_rows_events_and_liquidations(monkeypatch: Any) -> None:
    # MD-LIQ-LOSS: раньше ошибка записи теряла строки, ликвидации (их по REST нет) и публиковала
    # закрытые свечи без строк; в лог — «будут догружены по REST»
    md = _md()
    writes: list[tuple[list[dict[str, Any]], dict[Any, list[Decimal]]]] = []
    t = 1704067230000  # 00:00:30 — минута давно завершена

    def flush_sync(candles: list[dict[str, Any]], liqs: dict[Any, list[Decimal]]) -> None:
        if not writes and md.n_flush_errors == 0:
            md.on_kline({**KLINE, "c": "42450"})  # снимок новее — во время неудачной записи
            md.on_force_order({"s": "BTCUSDT", "S": "SELL", "q": "1", "ap": "100", "T": t + 1})
            raise OSError("db down")
        writes.append((candles, {k: list(v) for k, v in liqs.items()}))

    monkeypatch.setattr(md, "_flush_sync", flush_sync)
    m0 = datetime(2026, 10, 25, 12, 0, tzinfo=UTC)
    md._put_candle(
        "BTCUSDT", 1, "1m", Candle(m0, *(Decimal(x) for x in (1, 2, 1, 1, 3))), closed=True
    )
    md.on_kline(KLINE)
    md.on_force_order({"s": "BTCUSDT", "S": "SELL", "q": "2", "ap": "100", "T": t})
    asyncio.run(md.flush_once())
    assert md.n_flush_errors == 1 and _closed(md) == [] and len(md.closed_events) == 1
    assert md.candle_buffer[(1, "4h", datetime(2024, 1, 1, tzinfo=UTC))]["close"] == Decimal(42450)
    asyncio.run(md.flush_once())
    candles, liqs = writes[0]
    assert {(c["timeframe"], c["close"]) for c in candles} == {
        ("1m", Decimal(1)),
        ("4h", Decimal(42450)),  # повтор — без задержки 4h, строка новее
    }
    minute = datetime(2024, 1, 1, 0, 0, tzinfo=UTC)
    assert liqs == {(1, minute): [Decimal(300), Decimal(0)]}  # обе ликвидации, без потерь
    assert [e["tf"] for e in _closed(md)] == ["1m"]


def test_forming_higher_tf_rows_are_written_every_few_seconds(monkeypatch: Any) -> None:
    # MD-WRITE-AMP: Binance шлёт 4h/1d/1w на каждой сделке — раньше каждая перезапись шла в БД
    clock = [100.0]
    monkeypatch.setattr(mdmod.time, "monotonic", lambda: clock[0])
    md = _md()
    m1 = {**KLINE, "i": "1m"}

    def take(final: bool = False) -> dict[str, Decimal]:
        rows, _ = md._take_rows(final)
        return {r["timeframe"]: r["close"] for r in rows}

    md.on_kline(KLINE)
    md.on_kline(m1)
    assert take() == {"4h": Decimal(42300), "1m": Decimal(42300)}
    md.on_kline({**KLINE, "c": "42410"})
    md.on_kline({**m1, "c": "42410"})
    clock[0] += 1
    assert take() == {"1m": Decimal(42410)}  # 4h ждёт в буфере
    assert md.candle_buffer[(1, "4h", datetime(2024, 1, 1, tzinfo=UTC))]["close"] == 42410
    clock[0] += mdmod.FORMING_HTF_EVERY
    assert take() == {"4h": Decimal(42410)}
    md.on_kline({**KLINE, "c": "42420"})
    assert take() == {}
    md.on_kline({**KLINE, "c": "42430", "x": True})  # закрытие — сразу
    rows, events = md._take_rows(False)
    assert [(r["close"], r["is_closed"]) for r in rows] == [(Decimal(42430), True)]
    assert [e["tf"] for e in events] == ["4h"]
    md.on_kline({**KLINE, "t": 1704081600000})  # следующая 4h
    assert take() == {}
    assert take(final=True) == {"4h": Decimal(42300)}  # остановка — пишется всё


def test_stop_writes_buffer_and_current_minute_liquidations(monkeypatch: Any) -> None:
    # MD-LIQ-LOSS: на остановке (деплой) запись раньше просто отменялась — ликвидации текущей
    # минуты и неписаный буфер терялись
    md = _md()
    writes: list[tuple[list[dict[str, Any]], dict[Any, list[Decimal]]]] = []
    monkeypatch.setattr(
        md, "_flush_sync", lambda c, liqs: writes.append((c, {k: list(v) for k, v in liqs.items()}))
    )
    now_ms = int(time.time() * 1000)

    async def connection(streams: list[str], idx: int) -> None:
        md.on_force_order({"s": "BTCUSDT", "S": "BUY", "q": "3", "ap": "10", "T": now_ms})
        md.on_kline(KLINE)
        await asyncio.sleep(0.1)  # 4h записана, следующий снимок ждёт FORMING_HTF_EVERY
        md.on_kline({**KLINE, "c": "42999", "h": "43000"})
        md.stop.set()

    ok, _ = _run_service(md, monkeypatch, connection)
    assert ok is True
    liq = [v for _, liqs in writes for v in liqs.values()]
    assert liq == [[Decimal(0), Decimal(30)]]
    last = [c["close"] for c in writes[-1][0] if c["timeframe"] == "4h"]
    assert last == [Decimal(42999)]


def _run_service(md: MarketData, monkeypatch: Any, connection: Any) -> tuple[bool, list[Any]]:
    """run() с быстрыми циклами и медленной стартовой догрузкой; без сети и БД."""
    monkeypatch.setattr(mdmod, "TICKER_EVERY", 0.02)
    monkeypatch.setattr(mdmod, "FLUSH_EVERY", 0.02)
    seen: list[Any] = []

    def slow_backfill(symbols: Any = None, history: Any = None) -> bool:
        time.sleep(0.3)
        seen.append((len(_prices(md)), mdmod.HEARTBEAT_KEY in md.redis.keys))
        return True

    async def prices(client: Any) -> dict[str, str]:
        return {"BTCUSDT": "1"}

    async def idle() -> None:
        await md.stop.wait()

    monkeypatch.setattr(md, "load_symbols", lambda: None)
    monkeypatch.setattr(md, "backfill", slow_backfill)
    monkeypatch.setattr(md, "_fetch_prices", prices)
    monkeypatch.setattr(md, "derivatives_loop", idle)
    monkeypatch.setattr(md, "poller", idle)
    monkeypatch.setattr(md, "connection", connection)
    ok = asyncio.run(asyncio.wait_for(md.run(), 5))
    return ok, seen


def test_run_starts_ticker_and_heartbeat_before_backfill_and_stops_cleanly(
    monkeypatch: Any,
) -> None:
    md = _md()

    async def connection(streams: list[str], idx: int) -> None:
        await asyncio.sleep(0.05)
        md.stop.set()

    ok, seen = _run_service(md, monkeypatch, connection)
    assert ok is True
    # за 0.3 с стартовой догрузки — уже сообщения с ценами и heartbeat (раньше — ни одного)
    n_prices, heartbeat = seen[0]
    assert n_prices >= 3 and heartbeat


def test_run_stops_when_core_task_dies(monkeypatch: Any) -> None:
    md = _md()

    async def connection(streams: list[str], idx: int) -> None:
        raise RuntimeError("boom")

    ok, _ = _run_service(md, monkeypatch, connection)
    assert ok is False and md.stop.is_set()  # main() выйдет с кодом 1 — хостинг перезапустит


def test_poller_retries_interrupted_backfill_and_survives_its_errors(monkeypatch: Any) -> None:
    monkeypatch.setattr(mdmod, "POLL_EVERY", 0.01)
    md = _md()
    md.kline_at["BTCUSDT"] = time.time() + 3600  # стрим жив — опрашивать нечего
    md.backfill_needed = {"BTCUSDT"}
    calls: list[Any] = []

    def backfill(symbols: Any = None, history: Any = None) -> bool:
        calls.append(symbols)
        raise RuntimeError("db down")  # не роняет опрос (и сервис вместе с ним)

    monkeypatch.setattr(md, "backfill", backfill)

    async def run() -> None:
        task = asyncio.create_task(md.poller())
        await asyncio.sleep(0.1)
        assert not task.done()
        md.stop.set()
        await asyncio.wait_for(task, 2)

    asyncio.run(run())
    assert calls and calls[0] == ["BTCUSDT"]


def test_stop_during_resync_writes_and_publishes_what_it_found(monkeypatch: Any) -> None:
    # MD-STOP-DURING-RESYNC: на остановке задачу соединения отменяли, а сверка в потоке шла
    # дальше и клала события после последней записи — их не публиковал никто (деплой вскоре после
    # старта или обрыва). Теперь сверка выходит после текущего запроса, run() ждёт её, затем —
    # последняя запись
    monkeypatch.setattr(mdmod, "FLUSH_EVERY", 0.02)
    md = _md()
    md.symbols = {f"S{i:02d}USDT": i for i in range(1, 31)}  # одно соединение production
    db = MemDb().install(monkeypatch, md)
    m = datetime.now(tz=UTC).replace(second=0, microsecond=0) - timedelta(minutes=1)
    for i in md.symbols.values():
        db.write("seed", i, "1m", m - timedelta(minutes=1), True)
        md.last_closed[(i, "1m")] = m - timedelta(minutes=1)
    calls: list[str] = []

    class SlowRest:
        def fetch_rest(
            self, symbol: str, tf: Timeframe, start: datetime, end: datetime
        ) -> list[Candle]:
            calls.append(symbol)
            time.sleep(0.02)
            return [_m1(m), _m1(m + timedelta(minutes=1))] if tf is Timeframe.M1 else []

    monkeypatch.setattr(mdmod, "BinanceHistory", lambda *a, **k: SlowRest())
    first = {
        **KLINE,
        "s": "S01USDT",
        "i": "1m",
        "t": int((m + timedelta(minutes=1)).timestamp() * 1000),
    }
    monkeypatch.setattr(
        mdmod, "connect", lambda *a, **k: FakeBinanceWs([json.dumps({"e": "kline", "k": first})])
    )
    real_connection = md.connection

    async def connection(streams: list[str], idx: int) -> None:
        task = asyncio.create_task(real_connection(streams, idx))
        await asyncio.sleep(0.25)  # сверка 30 инструментов (120 запросов по 20 мс) — в начале
        md.stop.set()  # SIGTERM
        await task

    ok, _ = _run_service(md, monkeypatch, connection)
    assert ok is True
    assert 0 < len(calls) < 30  # вышла после текущего запроса, не досверяв
    written = sorted(i for _, i, tf, t, closed in db.log if (tf, t, closed) == ("1m", m, True))
    published = sorted(e["instrument_id"] for e in _closed(md) if e["tf"] == "1m")
    assert written and published == written  # всё, что сверка записала, — опубликовано
    assert md.closed_events == [] and md.ready_events == [] and md.candle_buffer == {}
    assert md.held == {} and md.deferred == {}
