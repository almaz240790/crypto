"""HTTP-кэш и облегчённые варианты /v1/chart (план 2B.4).

Cache-Control и CDN-Cache-Control по каждой строке таблицы (stale-while-revalidate только для
edge), приватность ответов, зависящих от пользователя, явная политика у каждого GET, ETag и 304
(без ``server_time`` и ``structure.at``), layers/patterns/figures ``view=chart``, patterns
``ids``, derivatives ``series``, ``/found``, ``/signals`` по правам тарифа и ``current_through``.
Без БД: сервисы подменяются; сверка счётчиков ``/found`` с элементами и SQL-свёртки на реальной
БД — в test_chart_data.py.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from httpx import Response
from starlette.responses import JSONResponse

from app import auth, chart_data, http_cache
from app.chart_data import CHART_VIEW, DERIV_SERIES, bucket_start, chart_view
from app.http_cache import (
    CANDLES_HISTORY,
    CANDLES_LATEST,
    DERIVATIVES,
    LAYERS_CHART,
    NO_STORE,
    OBJECTS,
    PRIVATE_NO_CACHE,
    PRIVATE_NO_STORE,
    REVALIDATE,
    Policy,
)
from app.main import app
from app.routers import chart
from app.routers.public import optional_user
from engine.candles import Candle, Timeframe

INST = SimpleNamespace(id=1, symbol="BTCUSDT", tick_size=Decimal("0.1"))
ADMIN = SimpleNamespace(id=7, role="admin")
AUTH = {"Authorization": "Bearer test"}
ETAG_RE = re.compile(r'^W/"[0-9a-f]{16}"$')
T0 = datetime(2026, 10, 1, tzinfo=UTC)


def _instrument(db: Any, symbol: str) -> Any:
    if symbol.upper() != INST.symbol:
        raise HTTPException(404, "инструмент не найден")
    return INST


def _candles(tf: Timeframe, n: int = 30, close: str = "101") -> list[Candle]:
    d = Decimal
    return [
        Candle(T0 + tf.delta * i, d(100), d(102), d(99), d(close), d(5), d(500), 7)
        for i in range(n)
    ]


def _structure() -> dict[str, Any]:
    """Слои как у compute_layers на ~500 свечах: много swing-ов, событий, зон и снятий."""
    t = int(T0.timestamp())
    h = 14400
    return {
        "tf": "4h",
        "at": T0.isoformat(),
        "strategy_version": "1.0.0",
        "swings": [
            {"t": t + i * h, "p": f"{60000 + i * 7}.5", "kind": "high" if i % 2 else "low"}
            for i in range(160)
        ],
        # нарочно не по порядку: «последние 12» — по времени, а не по позиции в массиве
        "events": [
            {
                "t": t + ((i * 37) % 60) * h * 8,
                "type": "bos" if i % 3 else "choch",
                "dir": "up" if i % 2 else "down",
                "level": f"{61000 + i}.1",
                "from_t": t + ((i * 37) % 60) * h * 8 - 5 * h,
            }
            for i in range(60)
        ],
        "zones": [
            {
                "kind": ("ob", "fvg", "sd")[i % 3],
                "dir": "up" if i % 2 else "down",
                "top": f"{62000 + i * 10}",
                "bottom": f"{61900 + i * 10}",
                "from_t": t + i * h * 10,
                "status": ("active", "touched", "invalidated")[i % 3],
            }
            for i in range(45)
        ],
        "levels": {"pdh": "63000.1", "pdl": "61000.2", "pwh": "64000", "pwl": "60000"},
        "equal_levels": [
            {
                "kind": "high" if i % 2 else "low",
                "p": f"{61500 + i}",
                "from_t": t + i * h,
                "to_t": t + (i + 9) * h if i % 3 else None,
                "swept": bool(i % 3),
            }
            for i in range(36)
        ],
        "sweeps": [
            {"t": t + i * h * 9, "kind": "high" if i % 2 else "low", "level": f"{61700 + i}"}
            for i in range(50)
        ],
        "bias": {"bias": "long", "d1_trend": "up", "w1_trend": "up", "ema50_d1": "60123.4"},
        "atr": "812.3",
    }


SIGNALS = [{"id": "s1", "dir": "long", "t": int(T0.timestamp()), "status": "open", "events": []}]


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setattr(chart, "_instrument", _instrument)
    monkeypatch.setattr(
        chart, "load_candles", lambda db, i, tf, b, limit=500: (_candles(tf), b is None)
    )
    monkeypatch.setattr(chart, "current_bar", lambda *a, **k: None)
    monkeypatch.setattr(chart, "layers_cached", lambda *a, **k: _structure())
    monkeypatch.setattr(chart, "signal_layer", lambda *a, **k: SIGNALS)
    monkeypatch.setattr(chart, "_redis", lambda: None)
    app.dependency_overrides[auth.get_db] = lambda: object()
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _as_admin() -> None:
    _as(ADMIN)


def _as(user: Any) -> None:
    app.dependency_overrides[optional_user] = lambda: user
    app.dependency_overrides[auth.current_user] = lambda: user


def _policy(r: Response) -> Policy:
    """Политика кэша ответа по заголовкам: Cache-Control и CDN-Cache-Control."""
    return Policy(r.headers["cache-control"], r.headers.get("cdn-cache-control"))


# --- Cache-Control по строкам таблицы ------------------------------------------------------------


def test_candles_cache_control_by_variant(client: TestClient) -> None:
    now = datetime.now(tz=UTC)
    past = int((bucket_start(Timeframe.H4, now) - timedelta(days=30)).timestamp())
    future = int((now + timedelta(days=1)).timestamp())
    week = int(bucket_start(Timeframe.W1, now).timestamp())
    cases = [
        ("tf=4h", CANDLES_LATEST),
        ("tf=1h", CANDLES_LATEST),
        ("tf=1d", CANDLES_LATEST),
        (f"tf=4h&before={past}", CANDLES_HISTORY),
        (f"tf=1h&before={past}", CANDLES_HISTORY),
        # граница: всё строго раньше начала текущей недели — закрыто, порция не меняется
        (f"tf=1w&before={week}", CANDLES_HISTORY),
        # before в будущем захватывает незакрытую свечу — как последняя порция
        (f"tf=4h&before={future}", CANDLES_LATEST),
    ]
    for q, want in cases:
        r = client.get(f"/v1/chart/candles?symbol=BTCUSDT&{q}")
        assert r.status_code == 200, (q, r.text)
        assert _policy(r) == want, q


def test_intraday_candles_are_private_no_store(client: TestClient) -> None:
    r = client.get("/v1/chart/candles?symbol=BTCUSDT&tf=15m")
    assert r.status_code == 403 and r.headers["cache-control"] == NO_STORE  # гость: нет права
    _as_admin()
    for tf in ("1m", "5m", "15m"):
        r = client.get(f"/v1/chart/candles?symbol=BTCUSDT&tf={tf}", headers=AUTH)
        assert r.status_code == 200, r.text
        assert _policy(r) == PRIVATE_NO_STORE


def test_layers_cache_control(client: TestClient) -> None:
    guest = client.get("/v1/chart/layers?symbol=BTCUSDT&tf=4h&view=chart")
    assert guest.status_code == 200 and _policy(guest) == LAYERS_CHART
    r = client.get("/v1/chart/layers?symbol=BTCUSDT&tf=4h")
    assert _policy(r) == PRIVATE_NO_CACHE and r.json()["signals"] == []
    _as_admin()
    r = client.get("/v1/chart/layers?symbol=BTCUSDT&tf=4h", headers=AUTH)
    assert _policy(r) == PRIVATE_NO_CACHE and r.json()["signals"] == SIGNALS
    # view=chart не зависит от пользователя: вошедшему — то же тело и тот же публичный кэш
    authed = client.get("/v1/chart/layers?symbol=BTCUSDT&tf=4h&view=chart", headers=AUTH)
    assert _policy(authed) == LAYERS_CHART
    assert authed.headers["etag"] == guest.headers["etag"]
    assert "signals" not in authed.json()


def test_objects_and_derivatives_cache_control(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app.figures as figures_mod
    import app.patterns as patterns_mod

    monkeypatch.setattr(patterns_mod, "chart_patterns", lambda *a, **k: {"items": []})
    monkeypatch.setattr(figures_mod, "chart_figures", lambda *a, **k: {"items": []})
    no_patterns = {"total": 0, "significant_t": []}
    monkeypatch.setattr(patterns_mod, "pattern_counts", lambda *a: no_patterns)
    monkeypatch.setattr(figures_mod, "figure_active_ends", lambda *a: {"active_end_t": []})
    monkeypatch.setattr(chart, "load_derivatives", lambda *a: {"funding_current": None})
    for path in (
        "patterns?symbol=BTCUSDT&tf=4h",
        "patterns?symbol=BTCUSDT&tf=4h&view=chart",
        "patterns?symbol=BTCUSDT&tf=4h&ids=1,2",
        "figures?symbol=BTCUSDT&tf=4h",
        "figures?symbol=BTCUSDT&tf=4h&view=chart",
        "found?symbol=BTCUSDT&tf=4h&since=1",
    ):
        r = client.get(f"/v1/chart/{path}")
        assert r.status_code == 200, (path, r.text)
        assert _policy(r) == OBJECTS, path
    for path in ("derivatives?symbol=BTCUSDT&tf=4h", "derivatives?symbol=BTCUSDT&series=none"):
        r = client.get(f"/v1/chart/{path}")
        assert r.status_code == 200 and _policy(r) == DERIVATIVES, path


def test_stale_while_revalidate_only_at_the_edge() -> None:
    """Браузер не отдаёт устаревший ответ из своего кэша: ``stale-while-revalidate`` и
    ``s-maxage`` публичных вариантов — только в CDN-Cache-Control (браузер его не читает), в
    Cache-Control — ``max-age=0, must-revalidate`` (повтор с If-None-Match → 304). Исключение —
    история свечей: порция не меняется. Значения edge — по таблице спецификации §8.1."""
    edge = [(CANDLES_LATEST, 10, 30), (LAYERS_CHART, 30, 60), (OBJECTS, 60, 300)]
    edge.append((DERIVATIVES, 30, 60))
    for p, fresh, stale in edge:
        assert p.cache_control == REVALIDATE == "public, max-age=0, must-revalidate"
        assert p.cdn == f"max-age={fresh}, stale-while-revalidate={stale}"
    assert CANDLES_HISTORY.cdn is None  # edge берёт s-maxage из Cache-Control
    for p in (PRIVATE_NO_CACHE, PRIVATE_NO_STORE):
        assert p.cdn is None and p.cache_control.startswith("private")
    policies = [v for v in vars(http_cache).values() if isinstance(v, Policy)]
    assert len(policies) == 7
    browser_stale = [p for p in policies if "stale-while-revalidate" in p.cache_control]
    assert browser_stale == [CANDLES_HISTORY]
    assert [p for p in policies if "s-maxage" in p.cache_control] == [CANDLES_HISTORY]


def test_signals_requires_sign_in_and_is_private(client: TestClient) -> None:
    r = client.get("/v1/chart/signals?symbol=BTCUSDT")
    assert r.status_code == 401 and r.headers["cache-control"] == NO_STORE
    _as_admin()
    r = client.get("/v1/chart/signals?symbol=BTCUSDT", headers=AUTH)
    assert r.status_code == 200, r.text
    assert _policy(r) == PRIVATE_NO_STORE
    body = r.json()
    assert body["symbol"] == "BTCUSDT" and body["signals"] == SIGNALS


@pytest.mark.parametrize(
    "path",
    [
        "candles?symbol=BTCUSDT&tf=2h",  # 400 таймфрейм
        "candles?symbol=NOPEUSDT&tf=4h",  # 404 инструмент
        "candles?symbol=BTCUSDT&tf=4h&limit=5",  # 422 валидация
        "candles?symbol=BTCUSDT&tf=5m",  # 403 тариф
        "layers?symbol=BTCUSDT&tf=4h&view=full",  # 422 неизвестный view
        "patterns?symbol=BTCUSDT&tf=4h&ids=1,x",  # 400 ids
        "patterns?symbol=BTCUSDT&tf=4h&ids=" + ",".join(str(i) for i in range(21)),
        "found?symbol=BTCUSDT&tf=4h",  # 422: since обязателен
        "derivatives?symbol=BTCUSDT&series=oi,price",  # 400 series
        "derivatives?symbol=BTCUSDT&series=none,oi",
        "signals?symbol=BTCUSDT",  # 401 без входа
        "nope",  # 404 маршрута
    ],
)
def test_errors_are_no_store(client: TestClient, path: str) -> None:
    r = client.get(f"/v1/chart/{path}")
    assert 400 <= r.status_code < 500, (path, r.status_code)
    assert r.headers["cache-control"] == NO_STORE and "cdn-cache-control" not in r.headers


def test_error_after_json_response_drops_edge_policy() -> None:
    """Ошибка с уже выставленной политикой (обработчик отдал 4xx через json_response) — всё
    равно no-store и без CDN-Cache-Control: middleware перекрывает любой заголовок."""
    import asyncio

    from starlette.requests import Request as StarletteRequest

    req = StarletteRequest({"type": "http", "headers": [], "method": "GET", "path": "/"})
    sent: list[Any] = []

    async def inner(scope: Any, receive: Any, send: Any) -> None:
        resp = http_cache.json_response(req, {"x": 1}, OBJECTS)
        resp.status_code = 409
        await resp(scope, receive, send)

    async def send(message: Any) -> None:
        sent.append(message)

    async def receive() -> Any:
        return {"type": "http.request"}

    mw = http_cache.NoStoreByDefault(inner, prefix="/v1/chart")
    asyncio.run(mw({"type": "http", "path": "/v1/chart/x", "headers": []}, receive, send))
    headers = dict(sent[0]["headers"])
    assert sent[0]["status"] == 409 and headers[b"cache-control"] == b"no-store"
    assert b"cdn-cache-control" not in headers and headers[b"etag"]


class _LayoutDB:
    """Раскладки пользователя: пусто (get_layout — scalar, list_layouts — scalars)."""

    def scalar(self, *a: Any, **k: Any) -> Any:
        return None

    def scalars(self, *a: Any, **k: Any) -> Any:
        return SimpleNamespace(all=lambda: [])


CHART_GETS: dict[str, tuple[str, Policy]] = {
    "/v1/chart/candles": ("symbol=BTCUSDT&tf=4h", CANDLES_LATEST),
    "/v1/chart/layers": ("symbol=BTCUSDT&tf=4h", PRIVATE_NO_CACHE),
    "/v1/chart/signals": ("symbol=BTCUSDT", PRIVATE_NO_STORE),
    "/v1/chart/patterns": ("symbol=BTCUSDT&tf=4h", OBJECTS),
    "/v1/chart/figures": ("symbol=BTCUSDT&tf=4h", OBJECTS),
    "/v1/chart/found": ("symbol=BTCUSDT&tf=4h&since=1", OBJECTS),
    "/v1/chart/derivatives": ("symbol=BTCUSDT&tf=4h", DERIVATIVES),
    # раскладки пользователя политику не задают — middleware ставит private, no-store
    "/v1/chart/layout": ("name=mine", PRIVATE_NO_STORE),
    "/v1/chart/layouts": ("", PRIVATE_NO_STORE),
}
"""Каждый GET под /v1/chart и его политика; новый маршрут без строки здесь роняет тест."""


def test_every_chart_get_sends_explicit_cache_control(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Каждый GET под /v1/chart — и по токену, и по API-ключу (без Authorization) — отвечает
    явным Cache-Control: общий кэш с правилом «respect origin» не сохранит ответ без политики, в
    том числе раскладки пользователя. Не-GET без политики — тоже private, no-store."""
    import app.figures as figures_mod
    import app.patterns as patterns_mod

    monkeypatch.setattr(patterns_mod, "chart_patterns", lambda *a, **k: {"items": []})
    monkeypatch.setattr(figures_mod, "chart_figures", lambda *a, **k: {"items": []})
    monkeypatch.setattr(patterns_mod, "pattern_counts", lambda *a: {"total": 0})
    monkeypatch.setattr(figures_mod, "figure_active_ends", lambda *a: {"active_end_t": []})
    monkeypatch.setattr(chart, "load_derivatives", lambda *a: {"funding_current": None})
    paths = app.openapi()["paths"]
    gets = {p for p, ops in paths.items() if p.startswith("/v1/chart") and "get" in ops}
    assert gets == set(CHART_GETS)
    _as_admin()
    app.dependency_overrides[auth.get_db] = lambda: _LayoutDB()
    for path, (q, want) in CHART_GETS.items():
        for headers in (AUTH, {"X-API-Key": "pk_test"}):
            r = client.get(f"{path}?{q}", headers=headers)
            assert r.status_code == 200, (path, r.text)
            assert _policy(r) == want, path
    r = client.post(
        "/v1/chart/ask", json={"symbol": "BTCUSDT", "tf": "4h", "question": ""}, headers=AUTH
    )
    assert r.status_code == 422 and r.headers["cache-control"] == NO_STORE
    rows: list[Any] = []
    db = SimpleNamespace(scalar=lambda *a: None, add=rows.append, commit=lambda: None)
    app.dependency_overrides[auth.get_db] = lambda: db
    r = client.put("/v1/chart/layout", json={"data": {}, "updated_at": 1}, headers=AUTH)
    assert r.status_code == 200 and rows, r.text
    assert _policy(r) == PRIVATE_NO_STORE


def test_user_dependent_responses_are_never_public(client: TestClient) -> None:
    _as_admin()
    for path in (
        "candles?symbol=BTCUSDT&tf=1m",
        "candles?symbol=BTCUSDT&tf=5m",
        "candles?symbol=BTCUSDT&tf=15m",
        "layers?symbol=BTCUSDT&tf=4h",
        "layers?symbol=BTCUSDT&tf=1h",
        "signals?symbol=BTCUSDT",
    ):
        r = client.get(f"/v1/chart/{path}", headers=AUTH)
        cc = r.headers["cache-control"]
        assert r.status_code == 200 and "public" not in cc and cc.startswith("private"), path


def test_errors_outside_chart_keep_their_headers() -> None:
    """no-store ставится только под /v1/chart: остальные маршруты не меняются."""
    r = TestClient(app).get("/v1/no-such-route")
    assert r.status_code == 404 and "cache-control" not in r.headers


# --- ETag и 304 ----------------------------------------------------------------------------------


def test_etag_and_304(client: TestClient) -> None:
    url = "/v1/chart/candles?symbol=BTCUSDT&tf=4h"
    r1 = client.get(url)
    etag = r1.headers["etag"]
    assert ETAG_RE.match(etag)
    r2 = client.get(url)
    # server_time меняется на каждый запрос, но в ETag не входит
    assert r2.json()["server_time"] != r1.json()["server_time"]
    assert r2.headers["etag"] == etag
    for inm in (etag, etag.removeprefix("W/"), f'"other", {etag}', "*"):
        r = client.get(url, headers={"If-None-Match": inm})
        assert r.status_code == 304, inm
        assert r.content == b""
        assert r.headers["etag"] == etag and _policy(r) == CANDLES_LATEST
    r = client.get(url, headers={"If-None-Match": 'W/"0000000000000000"'})
    assert r.status_code == 200 and r.json()["candles"]


def test_etag_changes_with_data(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    url = "/v1/chart/candles?symbol=BTCUSDT&tf=4h"
    before = client.get(url).headers["etag"]
    monkeypatch.setattr(
        chart, "load_candles", lambda db, i, tf, b, limit=500: (_candles(tf, close="101.5"), True)
    )
    r = client.get(url, headers={"If-None-Match": before})
    assert r.status_code == 200 and r.headers["etag"] != before
    assert r.json()["candles"][-1]["c"] == "101.5"


def test_304_for_layers_view_and_history(client: TestClient) -> None:
    now = datetime.now(tz=UTC)
    past = int((bucket_start(Timeframe.H4, now) - timedelta(days=30)).timestamp())
    for url, cc in (
        ("/v1/chart/layers?symbol=BTCUSDT&tf=4h&view=chart", LAYERS_CHART),
        (f"/v1/chart/candles?symbol=BTCUSDT&tf=4h&before={past}", CANDLES_HISTORY),
    ):
        etag = client.get(url).headers["etag"]
        r = client.get(url, headers={"If-None-Match": etag})
        assert r.status_code == 304 and _policy(r) == cc and r.content == b""


def test_render_matches_json_response_and_etag_helpers() -> None:
    payload = {"s": "Цена", "n": 1.5, "i": [1, None, True], "d": Decimal("2.50")}
    want = JSONResponse(content={**payload, "d": 2.5}).body
    assert http_cache.render(payload) == want  # Decimal — как jsonable_encoder (FastAPI)
    with pytest.raises(ValueError):
        http_cache.render({"x": float("nan")})
    a = http_cache.etag_for({"x": 1, "server_time": "a"})
    assert a == http_cache.etag_for({"x": 1, "server_time": "b"})
    assert a != http_cache.etag_for({"x": 2, "server_time": "a"})
    assert http_cache.etag_for([1, 2]) == http_cache.etag_for([1, 2], http_cache.render([1, 2]))
    assert not http_cache.etag_matches(None, a) and not http_cache.etag_matches("", a)
    assert http_cache.etag_matches(f" {a} ", a) and not http_cache.etag_matches('W/"x"', a)


def test_etag_skips_nested_volatile_paths() -> None:
    """``structure.at`` не входит в ETag; остальное содержимое structure — входит."""
    etag = http_cache.etag_for
    one = {"tf": "4h", "structure": {"at": "T0", "zones": [1]}, "server_time": "a"}
    two = {"tf": "4h", "structure": {"at": "T1", "zones": [1]}, "server_time": "b"}
    assert etag(one) == etag(two)
    assert etag(one) != etag({**one, "structure": {"at": "T0", "zones": [2]}})
    # без structure, structure: null и не-словари — как раньше; исходный объект не меняется
    assert etag({"tf": "4h", "structure": None}) == etag({"tf": "4h", "structure": None})
    assert etag({"x": 1}, http_cache.render({"x": 1})) == etag({"x": 1})
    assert one["structure"] == {"at": "T0", "zones": [1]} and "server_time" in one
    assert etag(one, volatile=()) != etag(two, volatile=())


def _series(tf: Timeframe, n: int) -> list[Candle]:
    """Закрытые свечи (кончаются до T0) с волнами — у compute_layers есть swing-и и зоны."""
    import math

    start = T0 - tf.delta * n
    out = []
    for i in range(n):
        base = 60000 + 3000 * math.sin(i / 9) + 800 * math.sin(i / 2.3) + i * 3
        o = Decimal(str(round(base, 1)))
        c = Decimal(str(round(base + 150 * math.sin(i / 1.7), 1)))
        hi, lo = max(o, c) + Decimal("120.5"), min(o, c) - Decimal("110.2")
        out.append(Candle(start + tf.delta * i, o, hi, lo, c, Decimal(5), Decimal(500), 7))
    return out


@pytest.mark.parametrize("view", ["&view=chart", ""])
def test_layers_etag_survives_recompute(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, view: str
) -> None:
    """Пересчёт слоёв на тех же закрытых свечах (истёк Redis-кэш или Redis недоступен) меняет
    только ``structure.at`` — ETag тот же, повтор с If-None-Match получает 304."""
    monkeypatch.setattr(chart, "layers_cached", chart_data.layers_cached)  # настоящий, без Redis
    monkeypatch.setattr(
        chart_data, "load_candles", lambda db, i, tf, b, limit=500: (_series(tf, limit), True)
    )
    monkeypatch.setattr(chart_data, "latest_version", lambda db: None)
    clock = iter(T0 + timedelta(seconds=65 * k) for k in range(10))
    monkeypatch.setattr(chart, "_now", lambda: next(clock))
    url = f"/v1/chart/layers?symbol=BTCUSDT&tf=4h{view}"
    r1 = client.get(url)
    st = r1.json()["structure"]
    assert st["zones"] and st["events"] and st["at"] == T0.isoformat()
    r2 = client.get(url)
    assert r2.json()["structure"]["at"] != st["at"]  # пересчитано
    assert r2.headers["etag"] == r1.headers["etag"]
    r3 = client.get(url, headers={"If-None-Match": r1.headers["etag"]})
    assert r3.status_code == 304 and r3.content == b""


# --- layers?view=chart ---------------------------------------------------------------------------


def test_layers_view_chart_rules(client: TestClient) -> None:
    full_r = client.get("/v1/chart/layers?symbol=BTCUSDT&tf=4h")
    full = full_r.json()
    r = client.get("/v1/chart/layers?symbol=BTCUSDT&tf=4h&view=chart")
    view = r.json()
    assert "signals" not in view
    st, src = view["structure"], full["structure"]
    assert st["swings"] == []
    assert st["zones"] == [z for z in src["zones"] if z["status"] == "active"] and st["zones"]
    by_t = sorted(src["events"], key=lambda e: e["t"])
    assert st["events"] == by_t[-CHART_VIEW["events"] :] and len(st["events"]) == 12
    assert st["sweeps"] == sorted(src["sweeps"], key=lambda e: e["t"])[-12:]
    assert st["equal_levels"] == [e for e in src["equal_levels"] if not e["swept"]]
    assert st["equal_levels"]
    for k in ("levels", "bias", "atr", "tf", "at", "strategy_version"):
        assert st[k] == src[k], k
    # размер на фикстуре ≤ 25 % полного ответа
    assert len(r.content) <= 0.25 * len(full_r.content)


def test_layers_view_chart_without_structure(client: TestClient) -> None:
    """tf без слоёв (1m–15m) — structure null и в облегчённом варианте."""
    r = client.get("/v1/chart/layers?symbol=BTCUSDT&tf=15m&view=chart")
    assert r.status_code == 200 and r.json()["structure"] is None
    assert chart_view(None) is None
    assert chart_view({"events": [], "sweeps": []}) == {
        "events": [],
        "sweeps": [],
        "swings": [],
        "zones": [],
        "equal_levels": [],
    }


# --- patterns / figures view=chart, ids, found ---------------------------------------------------


def _pattern(i: int, significant: bool) -> Any:
    t = T0 + timedelta(hours=4 * i)
    return SimpleNamespace(
        id=i,
        type="engulfing",
        direction="up",
        status="confirmed",
        is_significant=significant,
        geometry={"candle_time": int(t.timestamp()), "price": "100", "atr": "2"},
        start_time=t,
        confirm_time=t + timedelta(hours=4),
        context={"trend": "up", "volume_ratio": "1.8"},
        source="backfill",
        timeframe="4h",
    )


def test_pattern_view_dict_drops_fields() -> None:
    from app.patterns import pattern_dict, pattern_view_dict

    sig, plain = _pattern(1, True), _pattern(2, False)
    full = pattern_dict(sig)
    v = pattern_view_dict(sig)
    assert "source" not in v and "tf" not in v and v["context"] == sig.context
    assert {k: x for k, x in full.items() if k not in ("source", "tf")} == v
    v2 = pattern_view_dict(plain)
    assert "context" not in v2 and "source" not in v2 and v2["significant"] is False


def test_figure_view_dict_drops_fields() -> None:
    from app.figures import figure_dict, figure_view_dict

    r = SimpleNamespace(
        id=3, type="double_top", direction="down", status="forming", scale=2,
        start_time=T0, end_time=T0 + timedelta(days=3), known_time=T0 + timedelta(days=3),
        confirm_time=None, invalidated_time=None, geometry={"points": [], "lines": []},
        breakout_level=Decimal("60000"), target=Decimal("58000"), invalidation=None,
        quality=Decimal("0.8"), metrics={"depth_atr": 2.1}, source="live", timeframe="4h",
    )  # fmt: skip
    v = figure_view_dict(r)
    assert set(figure_dict(r)) - set(v) == {"metrics", "source", "tf"}
    assert {k: x for k, x in figure_dict(r).items() if k in v} == v


def test_patterns_params_reach_service(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    import app.patterns as patterns_mod

    seen: list[dict[str, Any]] = []

    def fake(db: Any, inst: Any, tf: Any, s: Any, u: Any, limit: int, **kw: Any) -> Any:
        seen.append({"s": s, "u": u, "limit": limit, **kw})
        return {"items": []}

    monkeypatch.setattr(patterns_mod, "chart_patterns", fake)
    client.get("/v1/chart/patterns?symbol=BTCUSDT&tf=4h&since=100&until=200&limit=500")
    client.get("/v1/chart/patterns?symbol=BTCUSDT&tf=4h&view=chart")
    client.get("/v1/chart/patterns?symbol=BTCUSDT&tf=4h&ids=5,3,5")
    assert seen[0]["view"] is None and seen[0]["ids"] is None and seen[0]["limit"] == 500
    assert seen[0]["s"] == datetime.fromtimestamp(100, tz=UTC)
    assert seen[1]["view"] == "chart" and seen[1]["limit"] == 300
    assert seen[2]["ids"] == [3, 5]


def test_found_shape(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    import app.figures as figures_mod
    import app.patterns as patterns_mod

    monkeypatch.setattr(
        patterns_mod, "pattern_counts", lambda *a: {"total": 3, "significant_t": [10, 20]}
    )
    monkeypatch.setattr(figures_mod, "figure_active_ends", lambda *a: {"active_end_t": [30]})
    r = client.get("/v1/chart/found?symbol=BTCUSDT&tf=4h&since=5&until=50").json()
    assert r == {
        "symbol": "BTCUSDT",
        "tf": "4h",
        "since": 5,
        "until": 50,
        "patterns": {"total": 3, "significant_t": [10, 20]},
        "figures": {"active_end_t": [30]},
    }
    r = client.get("/v1/chart/found?symbol=BTCUSDT&tf=1h&since=5").json()
    assert r["figures"] is None and r["until"] is None  # фигур на 1h нет (FIGURE_TFS)


# --- derivatives?series= -------------------------------------------------------------------------


class _DerivDB:
    """Отвечает на запросы load_derivatives по имени таблицы и запоминает, какие были."""

    def __init__(self) -> None:
        self.tables: list[str] = []
        base = T0
        self.data: dict[str, list[tuple[Any, ...]]] = {
            "funding_rates": [
                (base + timedelta(hours=8 * i), Decimal("0.0001") * (i + 1), 8) for i in range(3)
            ],
            "open_interest": [(base + timedelta(hours=i), Decimal(1000 + i)) for i in range(6)],
            "liquidations": [
                (base + timedelta(hours=i), Decimal(10), Decimal(20)) for i in range(6)
            ],
            "long_short_ratios": [
                (base + timedelta(hours=i), Decimal("1.1"), Decimal("0.9")) for i in range(6)
            ],
        }

    def execute(self, stmt: Any, params: Any = None) -> Any:
        sql = str(stmt)
        table = next(t for t in self.data if f"from {t}" in sql)
        self.tables.append(table)
        rows = self.data[table]
        if "desc limit 1" in sql:
            rows = rows[-1:]
        return SimpleNamespace(all=lambda: rows, first=lambda: rows[0] if rows else None)


def _deriv_client(fake: _DerivDB) -> TestClient:
    app.dependency_overrides[auth.get_db] = lambda: fake
    return TestClient(app)


def test_derivatives_series(client: TestClient) -> None:
    base_keys = {"symbol", "tf", "funding_current", "next_funding_t", "liquidations_note"}
    fake = _DerivDB()
    full = _deriv_client(fake).get("/v1/chart/derivatives?symbol=BTCUSDT&tf=4h").json()
    assert list(full) == [
        "symbol", "tf", "funding", "funding_current", "next_funding_t", "oi", "liquidations",
        "liquidations_note", "ls_ratio", "ls_top",
    ]  # fmt: skip
    assert sorted(fake.tables) == sorted(
        ["funding_rates", "open_interest", "liquidations", "long_short_ratios"]
    )
    fake = _DerivDB()
    none = _deriv_client(fake).get("/v1/chart/derivatives?symbol=BTCUSDT&series=none").json()
    assert set(none) == base_keys and fake.tables == ["funding_rates"]
    for k in ("funding_current", "next_funding_t", "liquidations_note"):
        assert none[k] == full[k], k
    for series in DERIV_SERIES:
        fake = _DerivDB()
        one = _deriv_client(fake).get(f"/v1/chart/derivatives?symbol=BTCUSDT&series={series}")
        body = one.json()
        assert set(body) == base_keys | {series}, series
        assert body[series] == full[series] and body["funding_current"] == full["funding_current"]
    fake = _DerivDB()
    two = _deriv_client(fake).get("/v1/chart/derivatives?symbol=BTCUSDT&series=oi,ls_top").json()
    assert set(two) == base_keys | {"oi", "ls_top"}
    assert sorted(fake.tables) == ["funding_rates", "long_short_ratios", "open_interest"]


# --- candles: current_through --------------------------------------------------------------------


def test_candles_current_through(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """Незакрытая свеча ответа и ``current_through`` — из одной свёртки ``current_bar``: в
    ``current`` (порция кончается раньше интервала) или вместо открытой свечи порции той же
    корзины (снимок биржи 4h/1d/1w или корзина 5m/15m/1h из другого запроса). Без свёртки —
    ``current_through: null``, открытая свеча порции остаётся как есть."""
    now = datetime(2026, 10, 28, 14, 23, 40, tzinfo=UTC)
    monkeypatch.setattr(chart, "_now", lambda: now)
    start = bucket_start(Timeframe.H4, now)
    d = Decimal
    cur = Candle(start, d(1), d(3), d(1), d(2), d(9), d(90), 3)
    through = datetime(2026, 10, 28, 14, 22, tzinfo=UTC)  # 14:23 ещё формируется
    monkeypatch.setattr(chart, "current_bar", lambda *a, **k: (cur, through))
    body = client.get("/v1/chart/candles?symbol=BTCUSDT&tf=4h").json()
    assert body["current"] == {
        "t": int(start.timestamp()), "o": "1", "h": "3", "l": "1", "c": "2", "v": "9", "open": True,
    }  # fmt: skip
    assert body["current_through"] == int(through.timestamp())
    assert not any(c["open"] for c in body["candles"])
    # та же корзина в порции: снимок биржи (с формирующейся минутой) заменяется свёрткой
    snapshot = Candle(start, d(1), d(5), d(1), d("2.5"), d(11), d(110), 4)
    history = _candles(Timeframe.H4)

    def with_open(rows: list[Candle]) -> Any:
        return lambda db, i, tf, b, limit=500: (rows, True)

    monkeypatch.setattr(chart, "load_candles", with_open([*history, snapshot]))
    body = client.get("/v1/chart/candles?symbol=BTCUSDT&tf=4h").json()
    assert body["current"] is None and body["current_through"] == int(through.timestamp())
    assert body["candles"][-1] == chart.candle_dict(cur, open_=True)
    assert len(body["candles"]) == len(history) + 1
    assert body["candles"][:-1] == [chart.candle_dict(c) for c in history]
    # закрытых минут в интервале ещё нет — открытая свеча порции как есть, through null
    monkeypatch.setattr(chart, "current_bar", lambda *a, **k: None)
    body = client.get("/v1/chart/candles?symbol=BTCUSDT&tf=4h").json()
    assert body["current"] is None and body["current_through"] is None
    assert body["candles"][-1] == chart.candle_dict(snapshot, open_=True)
    # свёртка старше открытой свечи порции не описывает её — through null
    later = Candle(start + Timeframe.H4.delta, d(1), d(5), d(1), d(2), d(1))
    monkeypatch.setattr(chart, "current_bar", lambda *a, **k: (cur, through))
    monkeypatch.setattr(chart, "load_candles", with_open([*history, later]))
    body = client.get("/v1/chart/candles?symbol=BTCUSDT&tf=4h").json()
    assert body["current"] is None and body["current_through"] is None
    # история и 1m — без текущей свечи
    past = int((start - timedelta(days=3)).timestamp())
    body = client.get(f"/v1/chart/candles?symbol=BTCUSDT&tf=4h&before={past}").json()
    assert body["current"] is None and body["current_through"] is None
    _as_admin()
    body = client.get("/v1/chart/candles?symbol=BTCUSDT&tf=1m", headers=AUTH).json()
    assert body["current"] is None and body["current_through"] is None


# --- signals по правам тарифа --------------------------------------------------------------------


def test_chart_signals_follow_plan(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """Биллинг включён: Free — только градация A, через 12 ч после закрытия свечи и только BTC,
    ETH и вотчлист, как ``/v1/signals``; Pro — всё live; Premium — ещё forward. То же для
    ``signals`` в ``/layers`` без ``view``."""
    from app import entitlements as ent_mod
    from app.config import settings

    now = datetime(2026, 10, 28, 12, tzinfo=UTC)
    monkeypatch.setattr(chart, "_now", lambda: now)
    monkeypatch.setattr(settings, "billing_enabled", True)
    plan = {"name": "free"}
    monkeypatch.setattr(ent_mod, "plan_for", lambda *a, **k: plan["name"])
    allowed: dict[str, list[int] | None] = {"ids": [INST.id]}
    monkeypatch.setattr(chart, "allowed_instrument_ids", lambda *a: allowed["ids"])
    seen: list[tuple[Any, ...]] = []

    def layer(db: Any, inst: Any, scopes: Any, grades: Any, closed_by: Any) -> Any:
        seen.append((scopes, grades, closed_by))
        return SIGNALS

    monkeypatch.setattr(chart, "signal_layer", layer)
    _as(SimpleNamespace(id=9, role="user"))
    urls = ("/v1/chart/signals?symbol=BTCUSDT", "/v1/chart/layers?symbol=BTCUSDT&tf=4h")
    for url in urls:
        assert client.get(url, headers=AUTH).json()["signals"] == SIGNALS
        assert seen.pop() == (["live"], ("A",), now - timedelta(hours=12))
    allowed["ids"] = [INST.id + 1]  # инструмент не в BTC/ETH и не в вотчлисте
    for url in urls:
        assert client.get(url, headers=AUTH).json()["signals"] == []
    assert seen == []
    allowed["ids"] = None
    plan["name"] = "pro"
    client.get(urls[0], headers=AUTH)
    assert seen.pop() == (["live"], None, None)
    plan["name"] = "premium"
    client.get(urls[0], headers=AUTH)
    assert seen.pop() == (["live", "forward"], None, None)


def test_signal_layer_sql_applies_grades_and_delay() -> None:
    """signal_layer: градации и задержка — условия запроса (как _apply_entitlements)."""
    from app.chart_data import signal_layer

    class Rec:
        def __init__(self) -> None:
            self.stmts: list[Any] = []

        def execute(self, stmt: Any) -> Any:
            self.stmts.append(stmt)
            return SimpleNamespace(all=lambda: [])

    cutoff = datetime(2026, 10, 28, tzinfo=UTC)
    db = Rec()
    assert signal_layer(db, INST, ["live"], ("A",), cutoff) == []  # type: ignore[arg-type]
    assert signal_layer(db, INST, ["live", "forward"]) == []  # type: ignore[arg-type]
    restricted, everything = (s.compile() for s in db.stmts)
    sql = str(restricted)
    assert "signals.grade IN" in sql and "signals.candle_close_time <=" in sql
    assert ["A"] in restricted.params.values() and cutoff in restricted.params.values()
    where = str(everything).split("WHERE", 1)[1]
    assert "grade" not in where and "candle_close_time <=" not in where
