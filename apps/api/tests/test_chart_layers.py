"""Слои терминала /v1/chart/layers (план 2A.4, 2B.4): кэш структуры по последней закрытой свече,
ограничения тарифа на слой сигналов, стоп в безубытке после цели 1.

Тесты на БД (нужен DATABASE_URL с миграциями до head; без БД пропускаются) идут во внешней
транзакции и откатываются в конце.
"""

from __future__ import annotations

import json
import secrets
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, OperationalError
from sqlalchemy.orm import Session

import app.chart_data as cd
from app import auth
from app.config import settings
from app.db import engine
from app.models import Instrument, Signal, Strategy, StrategyVersion, User
from app.models.market import Candle as CandleRow
from app.models.users import Watchlist, WatchlistItem
from app.routers import chart, public
from engine.candles import Candle as CandleEngine
from engine.candles import Timeframe
from engine.params import StrategyParams, TradeParams

H4 = Timeframe.H4


class FakeRedis:
    """get/set с ex — как у redis-py, без сети."""

    def __init__(self) -> None:
        self.data: dict[str, str] = {}

    def get(self, key: str) -> str | None:
        return self.data.get(key)

    def set(self, key: str, value: str, ex: int | None = None) -> None:
        self.data[key] = value


def _stub_compute(calls: list[datetime], complete: bool = True) -> Any:
    """compute_layers, который сообщает последнюю закрытую свечу на свой момент ``now``."""

    def compute(db: object, inst: object, tf: Timeframe, now: datetime) -> dict[str, Any]:
        calls.append(now)
        last = cd.bucket_start(tf, now) - tf.delta
        return {"at": now.isoformat(), "last_t": int(last.timestamp()), "complete": complete}

    return compute


def test_layers_cache_is_keyed_by_last_closed_candle(monkeypatch: pytest.MonkeyPatch) -> None:
    """OVL-3: ответ, посчитанный за 20 с до закрытия, не отдаётся после закрытия — ключ кэша
    включает последнюю закрытую свечу; до следующего закрытия кэш работает как прежде."""
    calls: list[datetime] = []
    monkeypatch.setattr(cd, "compute_layers", _stub_compute(calls))
    r = FakeRedis()
    inst = SimpleNamespace(id=1)
    before = datetime(2026, 11, 12, 11, 59, 40, tzinfo=UTC)
    after = datetime(2026, 11, 12, 12, 0, 10, tzinfo=UTC)
    a = cd.layers_cached(None, r, inst, H4, before)  # type: ignore[arg-type]
    b = cd.layers_cached(None, r, inst, H4, after)  # type: ignore[arg-type]
    assert a["last_t"] == int(datetime(2026, 11, 12, 4, tzinfo=UTC).timestamp())
    assert b["last_t"] == int(datetime(2026, 11, 12, 8, tzinfo=UTC).timestamp())
    c = cd.layers_cached(None, r, inst, H4, after + timedelta(seconds=30))  # type: ignore[arg-type]
    assert c == b and len(calls) == 2


def test_layers_cache_key_changes_with_the_day(monkeypatch: pytest.MonkeyPatch) -> None:
    """Макс./мин. вчера и прошлой недели сменяются в 00:00 UTC: недельная свеча та же, а ответ —
    новый (ключ включает день)."""
    calls: list[datetime] = []
    monkeypatch.setattr(cd, "compute_layers", _stub_compute(calls))
    r = FakeRedis()
    inst = SimpleNamespace(id=1)
    tue = datetime(2026, 11, 10, 23, 59, 50, tzinfo=UTC)
    cd.layers_cached(None, r, inst, Timeframe.W1, tue)  # type: ignore[arg-type]
    cd.layers_cached(None, r, inst, Timeframe.W1, tue + timedelta(seconds=20))  # type: ignore[arg-type]
    assert len(calls) == 2


def test_incomplete_layers_are_not_cached(monkeypatch: pytest.MonkeyPatch) -> None:
    """Последняя строка ещё не записана закрытой — ответ без неё не кэшируется: через секунды
    следующий запрос посчитает его заново, уже с закрытой свечой."""
    calls: list[datetime] = []
    monkeypatch.setattr(cd, "compute_layers", _stub_compute(calls, complete=False))
    r = FakeRedis()
    inst = SimpleNamespace(id=1)
    at = datetime(2026, 11, 12, 12, 0, 1, tzinfo=UTC)
    cd.layers_cached(None, r, inst, H4, at)  # type: ignore[arg-type]
    cd.layers_cached(None, r, inst, H4, at + timedelta(seconds=3))  # type: ignore[arg-type]
    assert len(calls) == 2 and r.data == {}


# --- на БД -------------------------------------------------------------------------------------


def _db_available() -> bool:
    try:
        with engine.connect() as conn:
            conn.execute(text("select published from signals limit 0"))
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


def _instrument(db: Session) -> Instrument:
    tag = secrets.token_hex(3).upper()
    inst = Instrument(
        exchange="binance",
        symbol=f"LY{tag}USDT",
        base=f"LY{tag}",
        quote="USDT",
        market_type="futures",
        tick_size=Decimal("0.01"),
        lot_size=Decimal("0.001"),
    )
    db.add(inst)
    db.flush()
    return inst


def _version(db: Session) -> StrategyVersion:
    tag = secrets.token_hex(3)
    strat = Strategy(slug=f"layers-{tag}", name="layers test")
    db.add(strat)
    db.flush()
    ver = StrategyVersion(strategy_id=strat.id, version=f"0.{tag}.0", params={}, status="live")
    db.add(ver)
    db.flush()
    return ver


def _signal(
    db: Session,
    ver: StrategyVersion,
    inst: Instrument,
    at: datetime,
    grade: str = "A",
    status: str = "active",
) -> Signal:
    s = Signal(
        public_id=f"ly{secrets.token_hex(6)}", strategy_version_id=ver.id, instrument_id=inst.id,
        direction="long", candle_close_time=at, entry_market=Decimal(100),
        stop_loss=Decimal(95), tp1=Decimal(105), tp2=Decimal(110), tp3=Decimal(120),
        rr_tp2=Decimal(2), score=80 if grade == "A" else 60, grade=grade, input_hash="x" * 64,
        status=status, scope="live",
    )  # fmt: skip
    db.add(s)
    db.flush()
    return s


def _user(db: Session, watch: list[Instrument]) -> User:
    u = User(
        email=f"layers-{secrets.token_hex(3)}@example.test",
        role="user",
        email_verified_at=datetime(2026, 10, 1, tzinfo=UTC),
    )
    db.add(u)
    db.flush()
    wl = Watchlist(user_id=u.id)
    db.add(wl)
    db.flush()
    for inst in watch:
        db.add(WatchlistItem(watchlist_id=wl.id, instrument_id=inst.id))
    db.flush()
    return u


def _client(db: Session, user: User | None) -> TestClient:
    app = FastAPI()
    app.include_router(chart.router)
    app.dependency_overrides[auth.get_db] = lambda: db
    app.dependency_overrides[public.optional_user] = lambda: user
    return TestClient(app)


def _layer_ids(client: TestClient, inst: Instrument) -> list[str]:
    # 1m — без структуры: ни Redis, ни расчёта, только слой сигналов
    r = client.get(f"/v1/chart/layers?symbol={inst.symbol}&tf=1m")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["instrument_id"] == inst.id
    return [s["id"] for s in body["signals"]]


@db_only
def test_layers_signals_follow_plan_limits_like_the_feed(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """OVL-2: Free (биллинг включён, подписки нет) видит на графике то же, что в ленте: только
    градацию A, через 12 ч после закрытия свечи, по BTC, ETH и инструментам вотчлиста."""
    now = datetime.now(tz=UTC)
    ver = _version(db)
    watched, other = _instrument(db), _instrument(db)
    old_a = _signal(db, ver, watched, now - timedelta(hours=13))
    _signal(db, ver, watched, now - timedelta(hours=1))  # задержка тарифа ещё не прошла
    _signal(db, ver, watched, now - timedelta(hours=30), grade="B")
    _signal(db, ver, other, now - timedelta(hours=13))
    client = _client(db, _user(db, [watched]))

    monkeypatch.setattr(settings, "billing_enabled", True)
    assert _layer_ids(client, watched) == [old_a.public_id]
    assert _layer_ids(client, other) == []
    # лента и карточка показывают ровно столько же
    feed = _client_public(db, client).get(f"/v1/signals?symbol={watched.symbol}").json()
    assert [s["id"] for s in feed["items"]] == [old_a.public_id]

    # биллинг выключен — все пользователи на уровне Pro: ограничений нет
    monkeypatch.setattr(settings, "billing_enabled", False)
    assert len(_layer_ids(client, watched)) == 3
    assert len(_layer_ids(client, other)) == 1
    # без входа сигналов на графике нет
    assert _layer_ids(_client(db, None), watched) == []


def _client_public(db: Session, chart_client: TestClient) -> TestClient:
    """Лента сигналов для того же пользователя, что и у клиента графика."""
    app = FastAPI()
    app.include_router(public.router)
    app.dependency_overrides = dict(chart_client.app.dependency_overrides)  # type: ignore[attr-defined]
    return TestClient(app)


@db_only
def test_signal_layer_marks_breakeven_stop_after_tp1(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """OVL-5: после цели 1 трекер переносит стоп на цену входа (be_after_tp1 версии) — слой
    сообщает это графику полем ``be``; у версии без переноса и до цели 1 — нет."""
    now = datetime.now(tz=UTC)
    ver = _version(db)
    inst = _instrument(db)
    t = now - timedelta(hours=40)
    active = _signal(db, ver, inst, t)
    tp1 = _signal(db, ver, inst, t - timedelta(hours=4), status="tp1_hit")
    tp2 = _signal(db, ver, inst, t - timedelta(hours=8), status="tp2_hit")
    closed = _signal(db, ver, inst, t - timedelta(hours=12), status="closed_be")
    be = {s["id"]: s["be"] for s in cd.signal_layer(db, inst, ["live"])}
    assert be == {
        active.public_id: False,
        tp1.public_id: True,
        tp2.public_id: True,
        closed.public_id: False,
    }
    no_be = StrategyParams(trade=TradeParams(be_after_tp1=False))
    monkeypatch.setattr(cd, "params_for_version", lambda version: no_be)
    assert not any(s["be"] for s in cd.signal_layer(db, inst, ["live"]))


def _h4_rows(db: Session, inst: Instrument, last_open: datetime, n: int) -> list[CandleRow]:
    rows = []
    for i in range(n):
        o = Decimal(100) + Decimal(i % 7) - Decimal(i % 3)
        rows.append(
            CandleRow(
                instrument_id=inst.id,
                timeframe="4h",
                open_time=last_open - timedelta(hours=4 * (n - 1 - i)),
                open=o,
                high=o + 2,
                low=o - 2,
                close=o + 1,
                volume=Decimal(1),
            )
        )
    db.add_all(rows)
    db.flush()
    return rows


@db_only
def test_compute_layers_skips_a_last_row_not_yet_written_closed(db: Session) -> None:
    """OVL-3: в первые секунды после закрытия market-data ещё держит последний снимок формирующейся
    4h (is_closed = false). Он не попадает в структуру, ответ помечен неполным (и не кэшируется);
    когда строка записана закрытой, ответ построен по ней."""
    inst = _instrument(db)
    now = datetime(2026, 11, 12, 12, 0, 2, tzinfo=UTC)
    last = cd.bucket_start(H4, now) - H4.delta
    rows = _h4_rows(db, inst, last, 60)
    rows[-1].is_closed = False
    db.flush()
    out = cd.compute_layers(db, inst, H4, now)
    assert out["last_t"] == int((last - H4.delta).timestamp()) and out["complete"] is False
    rows[-1].is_closed = True
    db.flush()
    out = cd.compute_layers(db, inst, H4, now)
    assert out["last_t"] == int(last.timestamp()) and out["complete"] is True
    json.dumps(out)  # ответ уходит в кэш как JSON


@db_only
def test_written_open_on_aggregated_timeframe_checks_last_minute(db: Session) -> None:
    """1h собирается из минут: свеча не дописана, пока последняя минута корзины — снимок; минуты нет
    (пропуск в истории) — свеча как есть."""
    inst = _instrument(db)
    start = datetime(2026, 11, 12, 11, tzinfo=UTC)
    d = Decimal(100)
    hour = CandleEngine(start, d, d, d, d, Decimal(1))
    assert not cd._written_open(db, inst.id, Timeframe.H1, hour)
    minute = CandleRow(
        instrument_id=inst.id, timeframe="1m", open_time=start + timedelta(minutes=59),
        open=d, high=d, low=d, close=d, volume=Decimal(1), is_closed=False,
    )  # fmt: skip
    db.add(minute)
    db.flush()
    assert cd._written_open(db, inst.id, Timeframe.H1, hour)
    minute.is_closed = True
    db.flush()
    assert not cd._written_open(db, inst.id, Timeframe.H1, hour)
