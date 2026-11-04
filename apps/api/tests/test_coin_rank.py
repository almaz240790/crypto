"""Порядок монет по капитализации: сопоставление баз, сито, сортировка, обновление и кэш."""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from app import coin_rank as cr

ROOT = Path(__file__).resolve().parents[3]
NOW = datetime(2026, 11, 4, 12, 0, tzinfo=UTC)


class FakeRedis:
    def __init__(self) -> None:
        self.data: dict[str, bytes] = {}
        self.ex: dict[str, int | None] = {}

    def get(self, name: str) -> bytes | None:
        return self.data.get(name)

    def set(self, name: str, value: str, ex: int | None = None) -> None:
        self.data[name] = value.encode()
        self.ex[name] = ex


class BrokenRedis:
    def get(self, name: str) -> Any:
        raise ConnectionError("нет Redis")

    def set(self, name: str, value: str, ex: int | None = None) -> Any:
        raise ConnectionError("нет Redis")


def _m(cid: str, symbol: str, name: str, cap: float | None) -> dict[str, Any]:
    return {"id": cid, "symbol": symbol, "name": name, "market_cap": cap}


def _markets(n_filler: int = 120) -> list[dict[str, Any]]:
    """Похоже на /coins/markets: крупные монеты, стейблкоины, обёртки, бумаги и хвост мелочи."""
    out = [
        _m("bitcoin", "btc", "Bitcoin", 1.6e12),
        _m("ethereum", "eth", "Ethereum", 3e11),
        _m("tether", "usdt", "Tether", 1.8e11),
        _m("binancecoin", "bnb", "BNB", 9.4e10),
        _m("wrapped-bitcoin", "wbtc", "Wrapped Bitcoin", 9e10),
        _m("solana", "sol", "Solana", 5.7e10),
        _m("lido-staked-ether", "steth", "Lido Staked Ether", 5e10),
        _m("the-open-network", "gram", "Gram (prev. Toncoin)", 3.4e9),
        _m("tether-gold", "xaut", "Tether Gold", 3.2e9),
        _m("pepe", "pepe", "Pepe", 2.2e9),
        _m("tokamak-network", "ton", "Tokamak Network", 2e9),
        _m("spacex-xstocks", "spcxx", "SpaceX xStock", 1.9e9),
        _m("dai", "dai", "Dai", 1.8e9),
        _m("vaulta", "a", "Vaulta", 1.4e8),
        _m("fake-sol", "sol", "Not Solana", 1e8),
        _m("bianrensheng", "币安人生", "BinanceLife", 9e7),
        _m("hyperliquid", "hype", "Hyperliquid", 2e10),
        _m("maker", "mkr", "Maker", 0.0),
        _m("ghost", "ghst", "Ghost", None),
    ]
    out += [_m(f"coin-{i}", f"c{i}", f"Coin {i}", 1e6 - i) for i in range(n_filler)]
    return out


# --- сопоставление баз -------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("base", "want"),
    [
        ("BTC", "BTC"),
        ("btc", "BTC"),
        ("1000PEPE", "PEPE"),
        ("1000BONK", "BONK"),
        ("1000SHIB", "SHIB"),
        ("1000FLOKI", "FLOKI"),
        ("1000000MOG", "MOG"),
        ("1MBABYDOGE", "BABYDOGE"),
        ("RNDR", "RENDER"),
        ("RENDER", "RENDER"),
        ("MATIC", "POL"),
        ("1INCH", "1INCH"),
    ],
)
def test_normalize_base(base: str, want: str) -> None:
    assert cr.normalize_base(base) == want


def test_base_of_symbol() -> None:
    assert cr.base_of("BTCUSDT") == "BTC"
    assert cr.base_of("1000PEPEUSDT") == "PEPE"
    assert cr.base_of("ethusdc") == "ETH"
    assert cr.base_of("USDT") == "USDT"


def test_static_order_covers_our_instruments() -> None:
    """У каждого инструмента расширенного списка есть место; MKR без капитализации — после всех."""
    assert cr.STATIC_ORDER[:5] == ("BTC", "ETH", "BNB", "XRP", "SOL")
    assert len(set(cr.STATIC_ORDER)) == len(cr.STATIC_ORDER)
    assert all(re.fullmatch(r"[A-Z0-9]+", b) for b in cr.STATIC_ORDER)
    symbols = (ROOT / "scripts" / "instruments_extended.txt").read_text().split()
    symbols = [s for s in symbols if s.endswith("USDT")]
    assert len(symbols) >= 60
    missing = {s for s in symbols if cr.rank_of(cr.base_of(s), cr.STATIC_TABLE) is None}
    assert missing == {"MKRUSDT"}
    # для каждой нашей базы есть id CoinGecko — тикеры там меняются
    assert {cr.base_of(s) for s in symbols} <= set(cr.COINGECKO_IDS)
    for stable in ("USDT", "USDC", "DAI", "USDE", "XAUT", "PAXG", "WBTC", "STETH"):
        assert stable not in cr.STATIC_TABLE


def test_static_order_same_in_web() -> None:
    """Веб сортирует тем же статическим порядком, пока API без поля rank (старый деплой)."""
    ts = ROOT / "apps" / "web" / "src" / "lib" / "coinRank.ts"
    if not ts.exists():
        pytest.skip("нет apps/web")
    body = re.search(r"COIN_ORDER[^=]*=\s*\[(.*?)\]", ts.read_text(), re.S)
    assert body, "COIN_ORDER не найден"
    assert tuple(re.findall(r'"([^"]+)"', body.group(1))) == cr.STATIC_ORDER


# --- сито и порядок из ответа CoinGecko ---------------------------------------------------------


def test_is_coin() -> None:
    assert cr.is_coin(_m("bitcoin", "btc", "Bitcoin", 1))
    assert cr.is_coin(_m("hyperliquid", "hype", "Hyperliquid", 1))
    for m in (
        _m("tether", "usdt", "Tether", 1),
        _m("usd-coin", "usdc", "USDC", 1),
        _m("euro-coin", "eurc", "EURC", 1),
        _m("wrapped-bitcoin", "wbtc", "Wrapped Bitcoin", 1),
        _m("lido-staked-ether", "steth", "Lido Staked Ether", 1),
        _m("pax-gold", "paxg", "PAX Gold", 1),
        _m("tesla-xstock", "tslax", "Tesla xStock", 1),
        _m("tradable-x", "pc0000031", "Tradable NA Rent", 1),
        _m("dai", "dai", "Dai", 1),
        _m("midas-mtbill", "mtbill", "Midas mTBILL", 1),
    ):
        assert not cr.is_coin(m), m
    # наши монеты сито не трогает, как бы их ни назвали
    assert cr.is_coin(_m("the-open-network", "gram", "Gram USD Edition", 1))


def test_order_from_markets() -> None:
    markets = _markets()
    order = cr.order_from_markets(list(reversed(markets)))  # порядок ответа не важен — по капе
    assert order[:6] == ["BTC", "ETH", "BNB", "SOL", "HYPE", "TON"]
    assert order.index("PEPE") == 6 and order.index("EOS") == 7
    # стейблкоины, обёртки, стейкинг, бумаги, золото — мимо
    for x in ("USDT", "WBTC", "STETH", "XAUT", "SPCXX", "DAI", "GRAM", "A"):
        assert x not in order
    # тикер TON у Tokamak не перебивает наш TON, «другой SOL» — тоже
    assert order.count("TON") == 1 and order.count("SOL") == 1
    # без капитализации и с не-ASCII тикером — нет места
    assert "MKR" not in order and "GHST" not in order and "币安人生" not in order
    assert order[8:10] == ["C0", "C1"]


def test_rank_sort_key_unknown_after_ranked() -> None:
    table = cr.rank_table(["BTC", "ETH", "BNB", "XRP", "SOL"])
    syms = ["1000BONKUSDT", "SOLUSDT", "AAAUSDT", "ETHUSDT", "BTCUSDT", "ZZZUSDT", "BNBUSDT"]
    got = sorted(syms, key=lambda s: cr.rank_sort_key(cr.rank_of(cr.base_of(s), table), s))
    assert got == ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "1000BONKUSDT", "AAAUSDT", "ZZZUSDT"]


# --- обновление: CoinGecko → Redis --------------------------------------------------------------


def _client(handler: Any) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def _ok_handler(calls: list[httpx.Request]) -> Any:
    pages = {1: _markets()[:100], 2: _markets()[100:]}

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(req)
        return httpx.Response(200, json=pages[int(req.url.params["page"])])

    return handler


def test_refresh_success_saves_order_with_ttl() -> None:
    r, calls = FakeRedis(), []
    assert cr.refresh_if_due(r, _client(_ok_handler(calls)), NOW) == "updated"
    assert [c.url.params["page"] for c in calls] == ["1", "2"]
    assert calls[0].url.params["order"] == "market_cap_desc"
    assert calls[0].url.params["per_page"] == "250"
    assert r.ex[cr.REDIS_KEY] == cr.REDIS_TTL == 36 * 3600
    cached = cr.load_cached(r)
    assert cached and cached["order"][:4] == ["BTC", "ETH", "BNB", "SOL"]
    assert cached["fetched_at"] == NOW


def test_refresh_skips_while_fresh_and_runs_after_a_day() -> None:
    r, calls = FakeRedis(), []
    cr.save_cached(r, ["BTC", "ETH"], NOW - timedelta(hours=23))
    assert cr.refresh_if_due(r, _client(_ok_handler(calls)), NOW) == "fresh"
    assert calls == []
    assert cr.refresh_if_due(r, _client(_ok_handler(calls)), NOW + timedelta(hours=2)) == "updated"
    assert len(calls) == 2


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(500, text="oops"),
        httpx.Response(429, json={"status": {"error_code": 429}}),
        httpx.Response(200, json={"status": "rate limited"}),
        httpx.Response(200, json=[{"id": "bitcoin", "symbol": "btc", "market_cap": 1}]),
        httpx.Response(200, text="<html>"),
    ],
)
def test_refresh_failure_keeps_previous(response: httpx.Response) -> None:
    r = FakeRedis()
    cr.save_cached(r, ["ETH", "BTC"], NOW - timedelta(days=2))
    before = dict(r.data)
    client = _client(lambda req: response)
    assert cr.refresh_if_due(r, client, NOW) == "failed"
    assert r.data == before


def test_refresh_network_error_and_broken_redis() -> None:
    def boom(req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("timeout", request=req)

    r = FakeRedis()
    assert cr.refresh_if_due(r, _client(boom), NOW) == "failed"
    assert r.data == {}
    assert cr.refresh_if_due(BrokenRedis(), _client(_ok_handler([])), NOW) == "failed"


def test_load_cached_rejects_garbage() -> None:
    r = FakeRedis()
    for raw in (b"not json", b"{}", b'{"order": [], "fetched_at": "2026-11-04T00:00:00+00:00"}'):
        r.data[cr.REDIS_KEY] = raw
        assert cr.load_cached(r) is None
    r.data[cr.REDIS_KEY] = json.dumps({"order": ["BTC"], "fetched_at": "2026-11-04T00:00"}).encode()
    assert cr.load_cached(r) is None  # время без пояса


# --- чтение в API: Redis → кэш процесса → статический порядок -----------------------------------


def test_current_ranks_from_redis_memo_and_fallback() -> None:
    cr.reset_memo()
    try:
        r = FakeRedis()
        cr.save_cached(r, ["ETH", "BTC"], NOW)
        assert dict(cr.current_ranks(r, clock=0.0)) == {"ETH": 1, "BTC": 2}
        # в пределах MEMO_TTL Redis не читается
        cr.save_cached(r, ["SOL"], NOW)
        assert cr.current_ranks(r, clock=cr.MEMO_TTL - 1)["ETH"] == 1
        assert dict(cr.current_ranks(r, clock=cr.MEMO_TTL + 1)) == {"SOL": 1}
        # Redis упал — статический порядок, и его ненадолго
        cr.reset_memo()
        assert cr.current_ranks(BrokenRedis(), clock=0.0) is cr.STATIC_TABLE
        assert cr.current_ranks(r, clock=cr.MEMO_TTL_FALLBACK - 1) is cr.STATIC_TABLE
        assert dict(cr.current_ranks(r, clock=cr.MEMO_TTL_FALLBACK + 1)) == {"SOL": 1}
        # ключа нет — тоже статический
        cr.reset_memo()
        assert cr.current_ranks(FakeRedis(), clock=0.0) is cr.STATIC_TABLE
    finally:
        cr.reset_memo()


# --- /v1/instruments и скринер ------------------------------------------------------------------


def _inst(i: int, symbol: str, base: str) -> SimpleNamespace:
    return SimpleNamespace(
        id=i,
        symbol=symbol,
        base=base,
        quote="USDT",
        exchange="binance",
        market_type="futures",
        tick_size=Decimal("0.1"),
        lot_size=Decimal("0.001"),
    )


INSTS = [
    _inst(1, "1000BONKUSDT", "1000BONK"),
    _inst(2, "AAVEUSDT", "AAVE"),
    _inst(3, "BTCUSDT", "BTC"),
    _inst(4, "ETHUSDT", "ETH"),
    _inst(5, "MKRUSDT", "MKR"),
    _inst(6, "SOLUSDT", "SOL"),
    _inst(7, "TONUSDT", "TON"),
    _inst(8, "ABCUSDT", "ABC"),
]


class FakeDb:
    def scalars(self, _q: object) -> SimpleNamespace:
        return SimpleNamespace(all=lambda: list(INSTS))


def test_instruments_endpoint_sorted_by_rank(monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi.testclient import TestClient

    from app import auth
    from app.main import app
    from app.routers import public

    monkeypatch.setattr(public, "current_ranks", lambda: cr.STATIC_TABLE)
    app.dependency_overrides[auth.get_db] = lambda: FakeDb()
    try:
        r = TestClient(app).get("/v1/instruments")
    finally:
        app.dependency_overrides.pop(auth.get_db, None)
    assert r.status_code == 200, r.text
    items = r.json()
    assert [x["symbol"] for x in items] == [
        "BTCUSDT",
        "ETHUSDT",
        "SOLUSDT",
        "TONUSDT",
        "AAVEUSDT",
        "1000BONKUSDT",
        "ABCUSDT",
        "MKRUSDT",
    ]
    by = {x["symbol"]: x for x in items}
    assert by["BTCUSDT"]["rank"] == 1 and by["SOLUSDT"]["rank"] == 5
    assert by["1000BONKUSDT"]["rank"] == cr.STATIC_TABLE["BONK"]
    assert by["MKRUSDT"]["rank"] is None and by["ABCUSDT"]["rank"] is None
    # прежние поля на месте
    assert by["BTCUSDT"]["tick_size"] == "0.1" and by["BTCUSDT"]["base"] == "BTC"


def test_screener_rows_in_rank_order(monkeypatch: pytest.MonkeyPatch) -> None:
    from app import screener

    monkeypatch.setattr(screener, "current_ranks", lambda: cr.rank_table(["BTC", "ETH", "SOL"]))
    monkeypatch.setattr(screener, "_candles", lambda *a, **k: [])

    def row(session: Any, inst: Any, btc_d1: Any, now: Any, rank: int | None = None) -> dict:
        return {"symbol": inst.symbol, "rank": rank}

    monkeypatch.setattr(screener, "build_row", row)
    rows = screener.build_screener(FakeDb(), NOW)  # type: ignore[arg-type]
    assert [r["symbol"] for r in rows][:3] == ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
    assert [r["rank"] for r in rows][:4] == [1, 2, 3, None]
    assert [r["symbol"] for r in rows][3:] == [
        "1000BONKUSDT",
        "AAVEUSDT",
        "ABCUSDT",
        "MKRUSDT",
        "TONUSDT",
    ]


def test_notifier_ranks_once(monkeypatch: pytest.MonkeyPatch) -> None:
    """Воркер: тот же refresh_if_due на своём Redis и httpx-клиенте, Redis закрывается."""
    from app.workers import notifier

    class ClosingRedis(FakeRedis):
        closed = False

        def close(self) -> None:
            self.closed = True

    r = ClosingRedis()
    calls: list[httpx.Request] = []
    monkeypatch.setattr(notifier.redis, "from_url", lambda *a, **k: r)
    real_client = httpx.Client  # до подмены: notifier.httpx — тот же модуль httpx
    handler = _ok_handler(calls)
    monkeypatch.setattr(
        notifier.httpx, "Client", lambda: real_client(transport=httpx.MockTransport(handler))
    )
    assert notifier.ranks_once() == "updated"
    assert r.closed and len(calls) == 2
    assert notifier.ranks_once() == "fresh"
    assert len(calls) == 2
