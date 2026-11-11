"""Сигналы — только для владельца до запуска продаж (ADR-0013).

Матрица доступа гость / пользователь / admin / owner при выключенном ``SIGNALS_PUBLIC``: каждый
эндпоинт сигналов отвечает 404 гостю и обычному пользователю и работает для admin и owner;
отработка паттернов и фигур открыта всем; при включённом выключателе — поведение как до решения.
Без БД — выключатель, сокет, статус-страница, отчёт по журналу. На БД (нужен DATABASE_URL с
миграциями до head; без БД тесты пропускаются) — эндпоинты с настоящими токенами, журнал,
письма и дайджест. Каждый тест на БД работает во внешней транзакции и откатывается.
"""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError, OperationalError
from sqlalchemy.orm import Session

from app import auth, live, monitor
from app.config import Settings, parse_public_flag, settings
from app.db import engine
from app.forward import write_candidate
from app.live import Client, Hub
from app.models import (
    Candle,
    Instrument,
    JournalEntry,
    NotificationLog,
    NotificationSettings,
    Signal,
    SignalEvent,
    SignalResult,
    Strategy,
    StrategyVersion,
    User,
)
from app.notify import journal_report_lines, notify_new_signal, run_digest
from app.routers import admin, chart, public
from app.routers import auth as auth_router
from app.routers import user as user_router
from app.signals_access import (
    SCHEMA_SIGNAL_FIELDS,
    hide_signal_components,
    is_signal_path,
    is_staff,
    scrub_signal_fields,
    signals_open,
)
from engine.structure import Direction

ROLES = ("guest", "user", "admin", "owner")
H4 = timedelta(hours=4)


@pytest.fixture(autouse=True)
def signals_closed(signals_public: None, monkeypatch: pytest.MonkeyPatch) -> None:
    """Поверх ``conftest.signals_public``: здесь по умолчанию выключатель выключен, как в бою."""
    monkeypatch.setattr(settings, "signals_public", False)


def _open(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "signals_public", True)


# --- выключатель ----------------------------------------------------------------------------


def test_switch_is_off_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SIGNALS_PUBLIC", raising=False)
    assert Settings(_env_file=None).signals_public is False  # type: ignore[call-arg]


@pytest.mark.parametrize("raw", ["true", "1", "yes", "on", " TRUE ", '"true"', "да"])
def test_switch_opens_only_on_explicit_yes(raw: str) -> None:
    assert parse_public_flag(raw) is True
    assert Settings(_env_file=None, signals_public=raw).signals_public is True  # type: ignore[call-arg]


@pytest.mark.parametrize("raw", ["", "false", "0", "no", "off", "нет"])
def test_switch_closed_values(raw: str) -> None:
    assert parse_public_flag(raw) is False


def test_switch_typo_keeps_signals_closed_and_logs(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.WARNING, logger="app.config"):
        assert Settings(_env_file=None, signals_public="ture").signals_public is False  # type: ignore[call-arg]
    assert "SIGNALS_PUBLIC" in caplog.text


@pytest.mark.parametrize("role", [*ROLES, "support"])
def test_signals_open_by_role(role: str, monkeypatch: pytest.MonkeyPatch) -> None:
    who = None if role == "guest" else SimpleNamespace(role=role)
    assert signals_open(who) is (role in ("admin", "owner"))
    assert is_staff(who) is (role in ("admin", "owner"))
    _open(monkeypatch)
    assert signals_open(who) is True


# --- сокет: события сигналов ----------------------------------------------------------------


class FakeWs:
    async def send_text(self, text_: str) -> None:  # pragma: no cover - очередь не отправляется
        pass


def _ws_clients() -> dict[str, Client]:
    c = {
        "guest": Client(FakeWs(), None),  # type: ignore[arg-type]
        "user": Client(FakeWs(), 7),  # type: ignore[arg-type]
        "admin": Client(FakeWs(), 8, staff=True),  # type: ignore[arg-type]
    }
    for x in c.values():
        x.subscribe({"BTCUSDT"})
    return c


def _status_event(h: Hub) -> None:
    data = {"id": "s1", "instrument_id": 1, "status": "tp1_hit", "scope": "live", "at": "x"}
    asyncio.run(h.handle_event(live.CHANNEL_STATUS, data))


def test_ws_signal_events_only_to_staff_while_closed() -> None:
    h, c = Hub(), _ws_clients()
    h.clients.update(c.values())
    _status_event(h)
    assert {k: len(v.outbox) for k, v in c.items()} == {"guest": 0, "user": 0, "admin": 1}
    assert json.loads(c["admin"].outbox[0])["t"] == "signal"
    # цены идут всем, как раньше
    h.broadcast({"t": "price", "s": "BTCUSDT", "p": "1"}, symbol="BTCUSDT")
    assert {k: len(v.outbox) for k, v in c.items()} == {"guest": 1, "user": 1, "admin": 2}


def test_ws_signal_events_to_all_authed_when_open(monkeypatch: pytest.MonkeyPatch) -> None:
    _open(monkeypatch)
    h, c = Hub(), _ws_clients()
    h.clients.update(c.values())
    _status_event(h)
    assert {k: len(v.outbox) for k, v in c.items()} == {"guest": 0, "user": 1, "admin": 1}


@pytest.mark.parametrize(("role", "staff"), [("user", False), ("admin", True), ("owner", True)])
def test_ws_connect_takes_role_from_token(
    role: str, staff: bool, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def no_start(self: Hub) -> None:  # без Redis
        return None

    monkeypatch.setattr(Hub, "start", no_start)
    from app.main import app

    token = auth.make_access_token(User(id=900 + len(role), email="r@b.c", role=role))
    with TestClient(app).websocket_connect(f"/v1/ws?token={token}") as ws:
        ws.send_text(json.dumps({"sub": ["BTCUSDT"]}))
        assert ws.receive_json()["t"] == "subscribed"
        mine = [c for c in live.hub.clients if c.user_id == 900 + len(role)]
        assert mine and mine[0].staff is staff


def test_openapi_hides_signal_routes_while_closed() -> None:
    """Пока сигналы закрыты, их адресов нет и в схеме /docs (флаг читается при запуске)."""
    if public.SIGNALS_IN_SCHEMA:
        pytest.skip("SIGNALS_PUBLIC включён в окружении тестов")
    from app.main import app

    paths = set(app.openapi()["paths"])
    assert not {p for p in paths if p.startswith(("/v1/signals", "/v1/strategies"))}
    assert not {"/v1/stats", "/v1/stats/trades", "/v1/stats/export.csv", "/v1/stats/runs"} & paths
    assert {"/v1/stats/patterns", "/v1/stats/figures", "/v1/features"} <= paths


def test_openapi_is_silent_about_signals_while_closed() -> None:
    """Публичная схема /docs ничем не выдаёт сигналы: ни описания публичных адресов, ни поля
    моделей, ни служебные адреса админки и отладки (там лента, стратегии, бэктесты)."""
    if public.SIGNALS_IN_SCHEMA:
        pytest.skip("SIGNALS_PUBLIC включён в окружении тестов")
    from app.main import app

    app.openapi_schema = None  # схема строится заново, как при запуске
    schema = app.openapi()
    assert not [p for p in schema["paths"] if p.startswith(("/v1/admin", "/debug"))]
    raw = json.dumps(schema, ensure_ascii=False).lower()
    for word in ("сигнал", "signal", "стратег", "strateg", "бэктест", "форвард", "adr-0013"):
        assert word not in raw, word
    # сама схема — та же, что раньше, кроме выброшенного: публичные адреса на месте
    assert {"/status", "/v1/chart/layers", "/v1/features", "/v1/journal"} <= set(schema["paths"])


def test_scrub_signal_fields_drops_properties_and_required() -> None:
    schema: dict[str, Any] = {
        "components": {
            "schemas": {
                "UserOut": {
                    "properties": {"email": {}, "signals": {}},
                    "required": ["email", "signals"],
                },
                "NotificationsIn": {"properties": {"email_signals": {}, "grades": {}}},
                "Other": {"properties": {"signals": {}}},
            }
        }
    }
    out = scrub_signal_fields(schema)
    models = out["components"]["schemas"]
    assert models["UserOut"] == {"properties": {"email": {}}, "required": ["email"]}
    assert models["NotificationsIn"]["properties"] == {"grades": {}}
    assert models["Other"]["properties"] == {"signals": {}}  # чужие модели не трогаем
    assert "JournalIn" in SCHEMA_SIGNAL_FIELDS
    assert scrub_signal_fields({}) == {}


@pytest.mark.parametrize(
    ("path", "gated"),
    [
        ("/v1/signals", True),
        ("/v1/signals/", True),
        ("/v1/signals/summary", True),
        ("/v1/signals/abc123", True),
        ("/v1/signals/abc123/analysis", True),
        ("/v1/signals/abc123/candles/", True),
        ("/v1/stats", True),
        ("/v1/stats/trades", True),
        ("/v1/stats/export.csv", True),
        ("/v1/stats/runs/", True),
        ("/v1/strategies", True),
        ("/v1/stats/patterns", False),
        ("/v1/stats/figures", False),
        ("/v1/signals/abc/other", False),
        ("/v1/admin/signals", False),
        ("/v1/features", False),
    ],
)
def test_is_signal_path(path: str, gated: bool) -> None:
    assert is_signal_path(path) is gated


def test_closed_signal_routes_look_absent_for_any_method_and_slash(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Пока сигналы закрыты, адрес сигналов не отличить от несуществующего: POST, HEAD и
    адрес со слэшем — 404, как у выдуманного адреса, а не 405 и не 307 (без БД)."""
    from app.main import app

    client = TestClient(app)
    for method in ("POST", "HEAD", "PUT", "DELETE"):
        for path in ("/v1/signals", "/v1/stats", "/v1/strategies", "/v1/stats/export.csv"):
            r = client.request(method, path, follow_redirects=False)
            assert r.status_code == 404, (method, path, r.status_code)
        assert client.request(method, "/v1/nonexistent").status_code == 404
    for path in ("/v1/signals/", "/v1/stats/", "/v1/strategies/", "/v1/stats/runs/"):
        r = client.get(path, follow_redirects=False)
        assert (r.status_code, r.text) == (404, '{"detail":"Not Found"}'), path
    assert client.get("/v1/nonexistent/", follow_redirects=False).status_code == 404
    # открытые адреса ведут себя как раньше: 405 на чужой метод, 307 на слэш
    assert client.post("/v1/stats/patterns").status_code == 405
    assert client.get("/v1/stats/patterns/", follow_redirects=False).status_code == 307
    # выключатель включён — прежние ответы фреймворка
    _open(monkeypatch)
    assert client.post("/v1/signals").status_code == 405
    assert client.get("/v1/signals/", follow_redirects=False).status_code == 307


# --- статус-страница ------------------------------------------------------------------------

FULL_STATUS: dict[str, Any] = {
    "status": "down",
    "generated_at": "2026-11-10T10:00:00+00:00",
    "components": [
        {"key": "data", "title": "Данные с биржи", "status": "ok", "detail": "", "uptime_7d": 100},
        {
            "key": "candles",
            "title": "Свечи H4",
            "status": "degraded",
            "detail": "",
            "uptime_7d": 99,
        },
        {
            "key": "engine",
            "title": "Движок сигналов",
            "status": "down",
            "detail": "",
            "uptime_7d": 90,
        },
        {
            "key": "tracker",
            "title": "Трекер сделок",
            "status": "ok",
            "detail": "",
            "uptime_7d": 100,
        },
        {"key": "notifier", "title": "Уведомления", "status": "ok", "detail": "", "uptime_7d": 100},
        {"key": "patterns", "title": "Паттерны", "status": "ok", "detail": "", "uptime_7d": 100},
        {"key": "alerts", "title": "Алерты", "status": "ok", "detail": "", "uptime_7d": 100},
        {"key": "api", "title": "API и база", "status": "ok", "detail": "ок", "uptime_7d": 100},
    ],
    "incidents": [
        {"component": "engine", "severity": "down", "message": "нет прогона", "opened_at": "x"},
        {"component": "candles", "severity": "degraded", "message": "нет свечи", "opened_at": "y"},
    ],
}


def test_hide_signal_components_drops_engine_and_tracker() -> None:
    out = hide_signal_components(FULL_STATUS)
    assert [c["key"] for c in out["components"]] == [
        "data",
        "candles",
        "notifier",
        "patterns",
        "alerts",
        "api",
    ]
    assert [i["component"] for i in out["incidents"]] == ["candles"]
    assert out["status"] == "degraded"  # сбой движка публичную страницу не красит
    assert FULL_STATUS["status"] == "down" and len(FULL_STATUS["components"]) == 8  # не изменён
    ok = {**FULL_STATUS, "components": [FULL_STATUS["components"][2]], "incidents": []}
    assert hide_signal_components(ok)["status"] == "ok"


def test_public_status_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(monitor, "current_status", lambda: json.loads(json.dumps(FULL_STATUS)))
    from app.main import app

    closed = TestClient(app).get("/status").json()
    keys = {c["key"] for c in closed["components"]}
    assert not keys & {"engine", "tracker"} and "data" in keys
    assert "Движок сигналов" not in json.dumps(closed, ensure_ascii=False)
    _open(monkeypatch)
    opened = TestClient(app).get("/status").json()
    assert {"engine", "tracker"} <= {c["key"] for c in opened["components"]}


def test_admin_system_keeps_full_monitor(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(monitor, "current_status", lambda: FULL_STATUS)
    snap = admin._monitor_snapshot()
    assert snap is not None and "engine" in {c["key"] for c in snap["components"]}

    def broken() -> dict[str, Any]:
        raise RuntimeError("redis и база недоступны")

    monkeypatch.setattr(monitor, "current_status", broken)
    assert admin._monitor_snapshot() is None


# --- отчёт по журналу -----------------------------------------------------------------------


def _analytics() -> dict[str, Any]:
    b = {"key": "A", "trades": 2, "closed": 2, "sum_r": "1", "avg_r": "0.5", "winrate": 0.5}
    return {
        "total": {**b, "key": None},
        "by_weekday": [{**b, "key": 0}],
        "by_symbol": [{**b, "key": "BTCUSDT"}],
        "by_grade": [b],
        "equity": {"points": [], "max_drawdown_r": "1"},
        "errors": {
            "early_exit": {"count": 1, "of": 2},
            "no_signal": {"count": 0, "of": 2},
            "risk_exceeded": {"count": 0, "of": 0, "budget_usd": None},
        },
    }


def test_journal_report_without_signal_lines() -> None:
    now = datetime(2026, 11, 10, tzinfo=UTC)
    full = "\n".join(journal_report_lines(_analytics(), now))
    assert "По градациям сигналов" in full and "вход без сигнала" in full
    hidden = "\n".join(journal_report_lines(_analytics(), now, signals=False))
    assert "сигнал" not in hidden.lower().replace("без сигнала", "")
    assert "По дням недели" in hidden and "превышение риска" in hidden


# --- на БД: эндпоинты с настоящими токенами -------------------------------------------------


def _db_available() -> bool:
    try:
        with engine.connect() as conn:
            conn.execute(text("select scope from signals limit 0"))
        return True
    except (OperationalError, DBAPIError):
        return False


db_only = pytest.mark.skipif(not _db_available(), reason="БД с миграциями до head недоступна")


@pytest.fixture
def db() -> Iterator[Session]:
    conn = engine.connect()
    outer = conn.begin()
    s = Session(bind=conn, join_transaction_mode="create_savepoint", expire_on_commit=False)
    try:
        yield s
    finally:
        s.close()
        outer.rollback()
        conn.close()


def _tag() -> str:
    return secrets.token_hex(3)


def _user(db: Session, role: str) -> User:
    u = User(
        email=f"access-{role}-{_tag()}@example.test",
        role=role,
        email_verified_at=datetime(2026, 10, 1, tzinfo=UTC),
    )
    db.add(u)
    db.flush()
    db.add(NotificationSettings(user_id=u.id, unsubscribe_token=secrets.token_urlsafe(16)))
    db.flush()
    return u


def _candidate(at: datetime) -> Any:
    return SimpleNamespace(
        candle_close_time=at,
        direction=Direction.UP,
        trade=SimpleNamespace(
            entry_market=Decimal(100),
            entry_limit=None,
            stop_loss=Decimal(95),
            tp1=Decimal(105),
            tp2=Decimal(110),
            tp3=Decimal(120),
            rr_tp2=Decimal(2),
        ),
        score=SimpleNamespace(
            total=80, grade=SimpleNamespace(value="A"), publishable=True, components={"t": 30}
        ),
        facts=("тест доступа",),
        deferred=False,
        zone=SimpleNamespace(kind="ob", top=Decimal(101), bottom=Decimal(99)),
        filters=SimpleNamespace(flags=[]),
        input_hash="a" * 64,
    )


def _publish(db: Session, ver: StrategyVersion, inst: Instrument, at: datetime) -> Signal:
    assert write_candidate(db, ver, inst, _candidate(at))
    db.commit()
    sig = db.scalar(
        select(Signal).where(Signal.strategy_version_id == ver.id, Signal.candle_close_time == at)
    )
    assert sig is not None
    return sig


def _close(db: Session, sig: Signal, r: str, closed_at: datetime) -> None:
    sig.status = "closed_tp3"
    db.add(SignalEvent(signal_id=sig.id, type="tp3", occurred_at=closed_at))
    db.add(
        SignalResult(
            signal_id=sig.id,
            realized_r=Decimal(r),
            duration_hours=Decimal(8),
            max_favorable_r=Decimal(3),
            max_adverse_r=Decimal("-0.2"),
            closed_at=closed_at,
        )
    )
    db.commit()


@pytest.fixture
def world(db: Session) -> SimpleNamespace:
    """Инструмент, live-версия с закрытым live-сигналом, форвард-версия с форвард-сигналом и
    пользователи всех ролей."""
    tag = _tag()
    inst = Instrument(
        exchange="binance",
        symbol=f"AC{tag.upper()}USDT",
        base=f"AC{tag.upper()}",
        quote="USDT",
        market_type="futures",
        tick_size=Decimal("0.01"),
        lot_size=Decimal("0.001"),
    )
    strat = Strategy(slug=f"access-{tag}", name="access test")
    db.add_all([inst, strat])
    db.flush()
    live_v = StrategyVersion(strategy_id=strat.id, version=f"0.{tag}.0", params={}, status="live")
    fwd_v = StrategyVersion(
        strategy_id=strat.id, version=f"0.{tag}.1", params={"f": 1}, status="forward"
    )
    db.add_all([live_v, fwd_v])
    db.flush()
    now = datetime.now(tz=UTC).replace(minute=0, second=0, microsecond=0)
    at = now - timedelta(hours=now.hour % 4) - timedelta(hours=8)
    live_sig = _publish(db, live_v, inst, at)
    _close(db, live_sig, "2.5", now - timedelta(hours=1))
    fwd_sig = _publish(db, fwd_v, inst, at - timedelta(hours=4))
    users = {r: _user(db, r) for r in ROLES if r != "guest"}
    return SimpleNamespace(
        inst=inst, live=live_sig, fwd=fwd_sig, live_v=live_v, fwd_v=fwd_v, users=users
    )


def _client(db: Session) -> TestClient:
    app = FastAPI()
    for r in (public.router, chart.router, user_router.router, auth_router.router):
        app.include_router(r)
    app.dependency_overrides[auth.get_db] = lambda: db
    return TestClient(app)


def _headers(world: SimpleNamespace, role: str) -> dict[str, str]:
    if role == "guest":
        return {}
    return {"authorization": f"Bearer {auth.make_access_token(world.users[role])}"}


def _gated(w: SimpleNamespace) -> list[str]:
    sid = w.live.public_id
    return [
        "/v1/signals",
        "/v1/signals?scope=forward",
        "/v1/signals?status=closed&limit=5",
        "/v1/signals/summary",
        f"/v1/signals/{sid}",
        f"/v1/signals/{sid}/analysis",
        f"/v1/signals/{sid}/candles",
        f"/v1/signals/{w.fwd.public_id}",
        "/v1/stats",
        "/v1/stats?scope=live",
        "/v1/stats?scope=forward",
        "/v1/stats?scope=backtest",
        "/v1/stats/trades?scope=live",
        "/v1/stats/trades?scope=forward",
        "/v1/stats/trades?scope=backtest",
        "/v1/stats/export.csv?scope=live",
        "/v1/stats/export.csv?scope=backtest",
        "/v1/stats/runs",
        "/v1/strategies",
    ]


@db_only
@pytest.mark.parametrize("role", ROLES)
def test_gated_endpoints_matrix_while_closed(
    role: str, db: Session, world: SimpleNamespace
) -> None:
    client = _client(db)
    for path in _gated(world):
        code = client.get(path, headers=_headers(world, role)).status_code
        if role in ("admin", "owner"):
            assert code == 200, (role, path, code)
        else:
            assert code == 404, (role, path, code)
    # 404 не зависит от параметров: неверная область или выдуманный сигнал — тоже 404, не 422
    if role in ("guest", "user"):
        h = _headers(world, role)
        assert client.get("/v1/stats?scope=bogus", headers=h).status_code == 404
        assert client.get("/v1/signals/nope", headers=h).status_code == 404
        assert client.get("/v1/stats/export.csv?scope=live", headers=h).text == (
            '{"detail":"Not Found"}'
        )


@db_only
@pytest.mark.parametrize("role", ROLES)
def test_pattern_figure_stats_and_market_data_stay_public(
    role: str, db: Session, world: SimpleNamespace
) -> None:
    client = _client(db)
    h = _headers(world, role)
    for path in (
        "/v1/stats/patterns",
        "/v1/stats/patterns?tf=1d&scope=live",
        "/v1/stats/figures",
        "/v1/instruments",
        f"/v1/prices?symbols={world.inst.symbol}",
    ):
        assert client.get(path, headers=h).status_code == 200, (role, path)


@db_only
@pytest.mark.parametrize("role", ROLES)
def test_features_and_me_report_access(role: str, db: Session, world: SimpleNamespace) -> None:
    client = _client(db)
    h = _headers(world, role)
    staff = role in ("admin", "owner")
    assert client.get("/v1/features", headers=h).json() == {"signals": staff}
    if role != "guest":
        assert client.get("/v1/auth/me", headers=h).json()["signals"] is staff


@db_only
@pytest.mark.parametrize("role", ROLES)
def test_chart_signal_layer_only_for_staff(role: str, db: Session, world: SimpleNamespace) -> None:
    client = _client(db)
    r = client.get(
        f"/v1/chart/layers?symbol={world.inst.symbol}&tf=15m", headers=_headers(world, role)
    )
    assert r.status_code == 200
    ids = {s["id"] for s in r.json()["signals"]}
    if role in ("admin", "owner"):
        assert world.live.public_id in ids
    else:
        assert ids == set()


def _candles(db: Session, inst: Instrument, n: int = 120) -> None:
    """Закрытые свечи H4, чтобы у графика была структура (как в бою)."""
    start = datetime.now(tz=UTC).replace(minute=0, second=0, microsecond=0)
    start = start - timedelta(hours=start.hour % 4) - n * H4
    for i in range(n):
        o = Decimal(100) + Decimal((i * 7) % 11) - 5
        db.add(
            Candle(
                instrument_id=inst.id,
                timeframe="4h",
                open_time=start + i * H4,
                open=o,
                high=o + 3,
                low=o - 3,
                close=o + Decimal((i % 3) - 1),
                volume=Decimal(10),
                quote_volume=Decimal(1000),
                trades=5,
                is_closed=True,
            )
        )
    db.commit()


@db_only
@pytest.mark.parametrize("role", ROLES)
def test_chart_structure_hides_strategy_version_from_non_staff(
    role: str, db: Session, world: SimpleNamespace, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(chart, "redis", SimpleNamespace(from_url=_no_redis))
    _candles(db, world.inst)
    client = _client(db)
    url = f"/v1/chart/layers?symbol={world.inst.symbol}&tf=4h"
    st = client.get(url, headers=_headers(world, role)).json()["structure"]
    assert st is not None and st["swings"] is not None  # структура графика открыта всем
    if role in ("admin", "owner"):
        assert st["strategy_version"] == world.live_v.version
    else:
        assert "strategy_version" not in st
    _open(monkeypatch)
    st = client.get(url, headers=_headers(world, role)).json()["structure"]
    assert st["strategy_version"] == world.live_v.version


def _no_redis(*_: Any, **__: Any) -> Any:
    raise OSError("без Redis в тесте")


@db_only
def test_switch_on_restores_previous_behaviour(
    db: Session, world: SimpleNamespace, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Включённый выключатель — как до ADR-0013: гостю закрытые live-сигналы и агрегаты,
    форвард построчно — нет; пользователю — лента, CSV и слой графика; /features — true."""
    _open(monkeypatch)
    client = _client(db)
    guest_expected = {
        "/v1/signals?scope=forward": 403,
        "/v1/stats/trades?scope=forward": 403,
        "/v1/stats/export.csv?scope=live": 401,
        "/v1/stats/export.csv?scope=backtest": 401,
        f"/v1/signals/{world.fwd.public_id}": 404,  # форвард-сигнал без прав — 404, как было
    }
    for path in _gated(world):
        assert client.get(path).status_code == guest_expected.get(path, 200), path
    user = _headers(world, "user")
    assert client.get("/v1/stats/export.csv?scope=live", headers=user).status_code == 200
    assert client.get("/v1/signals?status=open", headers=user).status_code == 200
    assert client.get("/v1/features").json() == {"signals": True}
    assert client.get("/v1/auth/me", headers=user).json()["signals"] is True
    layer = client.get(f"/v1/chart/layers?symbol={world.inst.symbol}&tf=15m", headers=user)
    assert world.live.public_id in {s["id"] for s in layer.json()["signals"]}


# --- на БД: журнал --------------------------------------------------------------------------


def _journal_body(w: SimpleNamespace) -> dict[str, Any]:
    return {
        "symbol": w.inst.symbol,
        "direction": "long",
        "entry_price": "100",
        "entry_at": w.live.candle_close_time.isoformat(),
        "stop_loss": "95",
        "take_profits": [],
        "exit_price": "110",
        "exit_at": (w.live.candle_close_time + timedelta(hours=4)).isoformat(),
        "signal_id": w.live.public_id,
    }


@db_only
@pytest.mark.parametrize("role", ["user", "admin"])
def test_journal_hides_signals_from_non_staff(
    role: str, db: Session, world: SimpleNamespace
) -> None:
    client = _client(db)
    h = _headers(world, role)
    staff = role == "admin"
    created = client.post("/v1/journal", json=_journal_body(world), headers=h)
    assert created.status_code == 201
    assert created.json()["source"] == ("signal" if staff else "manual")
    assert (created.json()["signal_id"] is not None) is staff
    # запись, связанную с сигналом раньше (до ADR-0013), сравнение с системой тоже не раскрывает
    db.add(
        JournalEntry(
            user_id=world.users[role].id,
            instrument_id=world.inst.id,
            signal_id=world.live.id,
            direction="long",
            entry_price=Decimal(100),
            entry_at=world.live.candle_close_time,
            stop_loss=Decimal(95),
            exit_price=Decimal(105),
            realized_r=Decimal(1),
            source="signal",
        )
    )
    db.commit()
    summary = client.get("/v1/journal", headers=h).json()["summary"]
    assert (summary["system_avg_r"] is not None) is staff
    assert (summary["executed_share"] is not None) is staff
    analytics = client.get("/v1/journal/analytics", headers=h).json()
    grades = {b["key"] for b in analytics["by_grade"]}
    assert grades == ({"A"} if staff else {"none"})
    # у admin связаны обе записи (новая — через «Я вошёл»), у пользователя — ни одной
    assert analytics["errors"]["early_exit"]["of"] == (2 if staff else 0)


# --- на БД: письма, push и дайджест ---------------------------------------------------------


@db_only
def test_signal_mail_and_digest_only_for_staff(
    db: Session, world: SimpleNamespace, monkeypatch: pytest.MonkeyPatch
) -> None:
    sent: list[str] = []
    monkeypatch.setattr("app.notify.send_mail", lambda to, subject, body, *a, **k: sent.append(to))
    for u in world.users.values():
        ns = db.get(NotificationSettings, u.id)
        assert ns is not None
        ns.email_signals = True
        ns.push_signals = False
        ns.email_digest = "daily"
    db.commit()
    live_open = _publish(db, world.live_v, world.inst, world.live.candle_close_time + 4 * H4)
    notify_new_signal(db, live_open, now=datetime.now(tz=UTC))
    run_digest(db, "daily", now=datetime.now(tz=UTC))

    def kinds(role: str) -> set[str]:
        uid = world.users[role].id
        return set(db.scalars(select(NotificationLog.kind).where(NotificationLog.user_id == uid)))

    assert kinds("user") == set()
    assert kinds("admin") == kinds("owner") == {"signal", "digest"}
    assert world.users["user"].email not in sent
    assert world.users["owner"].email in sent


@db_only
@pytest.mark.parametrize("role", ["user", "admin", "owner"])
def test_test_email_shows_signal_digest_only_to_staff(
    role: str, db: Session, world: SimpleNamespace, monkeypatch: pytest.MonkeyPatch
) -> None:
    """«Отправить тестовое письмо»: образец дайджеста сигналов — только admin и owner;
    обычному пользователю — письмо без сигналов, их статистики и ссылок на них."""
    sent: list[tuple[str, str, str]] = []
    monkeypatch.setattr(
        "app.notify.send_mail", lambda to, s, body, *a, **k: sent.append((to, s, body))
    )
    client = _client(db)
    r = client.post("/v1/me/notifications/test", headers=_headers(world, role))
    assert r.status_code == 200
    [(to, _, body)] = sent
    assert to == world.users[role].email
    tells = (world.inst.symbol, "/signals", "/stats", "винрейт", "дайджест", "сигнал")
    if role == "user":
        assert not [t for t in tells if t in body.lower() or t in body], body
        assert "доставка работает" in body
    else:
        assert all(t in body for t in tells[:5]), body


@db_only
def test_test_email_for_user_is_journal_report_when_trades(
    db: Session, world: SimpleNamespace, monkeypatch: pytest.MonkeyPatch
) -> None:
    sent: list[str] = []
    monkeypatch.setattr("app.notify.send_mail", lambda to, s, body, *a, **k: sent.append(body))
    u = world.users["user"]
    now = datetime.now(tz=UTC)
    db.add(
        JournalEntry(
            user_id=u.id,
            instrument_id=world.inst.id,
            signal_id=world.live.id,  # связана с сигналом до ADR-0013
            direction="long",
            entry_price=Decimal(100),
            entry_at=now - timedelta(days=1),
            stop_loss=Decimal(95),
            exit_price=Decimal(105),
            exit_at=now - timedelta(hours=2),
            realized_r=Decimal(1),
            source="signal",
        )
    )
    db.commit()
    assert _client(db).post("/v1/me/notifications/test", headers=_headers(world, "user")).is_success
    [body] = sent
    assert "отчёт по журналу" in body
    assert "сигнал" not in body.lower() and "/signals" not in body and "/stats" not in body


@db_only
@pytest.mark.parametrize("role", ["user", "admin"])
def test_journal_list_and_exports_hide_legacy_signal_links(
    role: str, db: Session, world: SimpleNamespace
) -> None:
    """Запись, связанная с сигналом до ADR-0013: обычному пользователю она ручная и без номера
    сигнала — в списке, в CSV (там нет и столбца signal_id) и в выгрузке данных."""
    u = world.users[role]
    db.add(
        JournalEntry(
            user_id=u.id,
            instrument_id=world.inst.id,
            signal_id=world.live.id,
            direction="long",
            entry_price=Decimal(100),
            entry_at=datetime.now(tz=UTC) - timedelta(days=1),
            stop_loss=Decimal(95),
            take_profits=[],
            size=Decimal(1),
            source="signal",
        )
    )
    db.commit()
    client = _client(db)
    h = _headers(world, role)
    staff = role == "admin"
    [item] = client.get("/v1/journal", headers=h).json()["items"]
    [exported] = client.get("/v1/me/export.json", headers=h).json()["journal"]
    header, row = client.get("/v1/journal/export.csv", headers=h).text.splitlines()
    for d in (item, exported):
        assert (d["source"], d["signal_id"]) == (
            ("signal", world.live.id) if staff else ("manual", None)
        )
    assert header.endswith(",source,signal_id" if staff else ",note,source")
    assert row.endswith(f",signal,{world.live.id}" if staff else ",manual")
