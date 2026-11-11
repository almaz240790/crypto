"""Вход движка на момент закрытия сигнальной свечи (задача 8 пакета «Сигналы», план 2.8, раздел 11).

- ``forward.load_inputs`` берёт только то, что известно к ``at``: закрытые свечи и записи
  деривативов не позже ``at``. Повторный вызов с тем же ``at`` читает то же окно.
- ``forward.write_candidate`` пишет вместе с сигналом отпечаток входа.
- scheduler не оценивает закрытие в 00:00 UTC, пока дневная (в понедельник — и недельная) свеча
  не записана закрытой: ждёт market-data, затем догружает по REST.

Тесты на БД (нужен DATABASE_URL с миграциями до head; без БД пропускаются) идут во внешней
транзакции и откатываются в конце.
"""

from __future__ import annotations

import asyncio
import secrets
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import Connection, select, text
from sqlalchemy.exc import DBAPIError, OperationalError
from sqlalchemy.orm import Session

import app.forward as forward
import app.workers.scheduler as scheduler
from app.db import engine
from app.forward import (
    INPUTS_FACT,
    context_candles_due,
    load_inputs,
    missing_context_candles,
    upsert_candles,
    write_candidate,
)
from app.models import Candle as CandleRow
from app.models import Instrument, Signal, Strategy, StrategyVersion
from app.models.derivatives import FundingRateRow, LongShortRatioRow, OpenInterestRow
from engine.bias import Bias, BiasContext
from engine.candles import Candle, Timeframe
from engine.filters import FilterSummary
from engine.scoring import Grade, ScoreBreakdown
from engine.signal import SignalCandidate, inputs_fingerprint
from engine.structure import Direction, Trend
from engine.trade import TradeSetup
from engine.zones import Zone, ZoneKind

D = Decimal
H4, D1, W1 = Timeframe.H4, Timeframe.D1, Timeframe.W1
MONDAY = datetime(2026, 11, 2, tzinfo=UTC)
"""Понедельник 00:00 UTC: в этот момент закрываются свеча H4, дневная и недельная."""
TUESDAY = MONDAY + timedelta(days=1)
AT = MONDAY + timedelta(hours=8)
"""Обычное закрытие H4: старшие свечи в этот момент не закрываются."""


def _db_available() -> bool:
    try:
        with engine.connect() as conn:
            conn.execute(text("select scope from signals limit 0"))
        return True
    except (OperationalError, DBAPIError):
        return False


db_only = pytest.mark.skipif(not _db_available(), reason="БД с миграциями недоступна")


@pytest.fixture
def conn() -> Iterator[Connection]:
    c = engine.connect()
    outer = c.begin()
    try:
        yield c
    finally:
        outer.rollback()
        c.close()


@pytest.fixture
def make_session(conn: Connection) -> Callable[[], Session]:
    """Сессии во внешней транзакции: commit в коде — это savepoint, в конце всё откатывается."""
    return lambda: Session(
        bind=conn, join_transaction_mode="create_savepoint", expire_on_commit=False
    )


@pytest.fixture
def db(make_session: Callable[[], Session]) -> Iterator[Session]:
    with make_session() as s:
        yield s


def _instrument(s: Session) -> Instrument:
    tag = secrets.token_hex(3).upper()
    inst = Instrument(
        exchange="binance",
        symbol=f"IN{tag}USDT",
        base=f"IN{tag}",
        quote="USDT",
        market_type="futures",
        tick_size=D("0.01"),
        lot_size=D("0.001"),
    )
    s.add(inst)
    s.flush()
    return inst


def _candle(open_time: datetime, close: int = 100) -> Candle:
    return Candle(open_time, D(100), D(close + 5), D(95), D(close), D(10))


def _closed(s: Session, inst: Instrument, tf: Timeframe, open_times: list[datetime]) -> None:
    upsert_candles(s, inst.id, tf, [_candle(t) for t in open_times])


def _forming(s: Session, inst: Instrument, tf: Timeframe, open_time: datetime) -> None:
    """Идущая свеча, как её пишет market-data: ``is_closed = false``, цены не окончательные."""
    s.add(
        CandleRow(
            instrument_id=inst.id,
            timeframe=tf.value,
            open_time=open_time,
            open=D(100),
            high=D(120),
            low=D(90),
            close=D(111),
            volume=D(3),
            is_closed=False,
        )
    )
    s.flush()


def _times(candles: Any) -> list[datetime]:
    return [c.open_time for c in candles]


# --- какие старшие свечи закрываются вместе с сигнальной -----------------------------------------


def test_context_candles_due_only_at_day_and_week_boundaries() -> None:
    assert context_candles_due(AT) == []
    assert context_candles_due(MONDAY + timedelta(hours=20)) == []
    assert context_candles_due(TUESDAY) == [(D1, MONDAY)]
    assert context_candles_due(MONDAY) == [
        (D1, MONDAY - timedelta(days=1)),
        (W1, MONDAY - timedelta(weeks=1)),
    ]
    # момент в другом часовом поясе — тот же момент
    msk = TUESDAY.astimezone(timezone(timedelta(hours=3)))
    assert context_candles_due(msk) == [(D1, MONDAY)]


# --- load_inputs --------------------------------------------------------------------------------


@db_only
def test_load_inputs_takes_only_candles_closed_by_the_moment(db: Session) -> None:
    inst = _instrument(db)
    at = TUESDAY  # закрытие H4 и дня
    _closed(db, inst, H4, [at - H4.delta * i for i in range(1, 7)])
    _forming(db, inst, H4, at)  # новая свеча уже идёт
    _closed(db, inst, D1, [at - D1.delta * i for i in range(1, 4)])
    _forming(db, inst, D1, at)
    _closed(db, inst, W1, [MONDAY - W1.delta * i for i in range(1, 3)])
    _forming(db, inst, W1, MONDAY)  # неделя закроется только в следующий понедельник

    inputs = load_inputs(db, inst, at)

    assert _times(inputs.h4) == [at - H4.delta * i for i in range(6, 0, -1)]
    assert _times(inputs.d1) == [at - D1.delta * i for i in range(3, 0, -1)]
    assert _times(inputs.w1) == [MONDAY - W1.delta * 2, MONDAY - W1.delta]
    assert all(c.open_time.utcoffset() == timedelta(0) for c in inputs.h4)


@db_only
def test_load_inputs_skips_a_candle_that_is_due_but_not_written_closed(db: Session) -> None:
    """Интервал свечи прошёл, а строка ещё ``is_closed = false`` (закрытая строка от market-data не
    дошла): цены в ней не окончательные — на вход движка она не попадает."""
    inst = _instrument(db)
    at = TUESDAY
    _closed(db, inst, H4, [at - H4.delta * i for i in range(1, 4)])
    _closed(db, inst, D1, [at - D1.delta * 2])
    _forming(db, inst, D1, at - D1.delta)  # день кончился, строка не закрыта

    inputs = load_inputs(db, inst, at)

    assert _times(inputs.d1) == [at - D1.delta * 2]
    assert missing_context_candles(db, inst.id, at) == [(D1, at - D1.delta)]


@db_only
def test_load_inputs_window_is_exactly_n_closed_candles(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Окно — N закрытых свечей, идёт ли уже следующая или нет. Раньше идущая свеча занимала
    место в окне, и закрытых получалось N − 1 или N — как повезёт."""
    monkeypatch.setattr(forward, "H4_WINDOW", 4)
    inst = _instrument(db)
    _closed(db, inst, H4, [AT - H4.delta * i for i in range(1, 9)])
    expected = [AT - H4.delta * i for i in range(4, 0, -1)]

    assert _times(load_inputs(db, inst, AT).h4) == expected
    _forming(db, inst, H4, AT)
    assert _times(load_inputs(db, inst, AT).h4) == expected


@db_only
def test_load_inputs_reads_the_same_window_later(db: Session) -> None:
    """Сверка и разбор сигнала вызывают загрузчик позже, когда в БД уже есть новые свечи и
    записи: окно и отпечаток входа — те же, что на закрытии сигнальной свечи."""
    inst = _instrument(db)
    at = TUESDAY
    _closed(db, inst, H4, [at - H4.delta * i for i in range(1, 7)])
    _closed(db, inst, D1, [at - D1.delta * i for i in range(1, 4)])
    _closed(db, inst, W1, [MONDAY - W1.delta])
    for t, value in ((at - timedelta(hours=8), "0.0001"), (at, "0.0002")):
        db.add(FundingRateRow(instrument_id=inst.id, funding_time=t, rate=D(value)))
        db.add(OpenInterestRow(instrument_id=inst.id, time=t, oi_contracts=D(1), oi_quote=D(1000)))
        db.add(
            LongShortRatioRow(
                instrument_id=inst.id, time=t, top_traders_ratio=D("1.5"), global_ratio=D(1)
            )
        )
    db.flush()
    then = load_inputs(db, inst, at)
    assert [r.time for r in then.funding] == [at - timedelta(hours=8), at]
    assert len(then.open_interest) == 2 and len(then.long_short) == 2

    # прошли сутки: новые свечи всех таймфреймов и новые записи деривативов
    _closed(db, inst, H4, [at + H4.delta * i for i in range(6)])
    _closed(db, inst, D1, [at])
    later = at + timedelta(hours=8)
    db.add(FundingRateRow(instrument_id=inst.id, funding_time=later, rate=D("0.0009")))
    db.add(OpenInterestRow(instrument_id=inst.id, time=later, oi_contracts=D(1), oi_quote=D(9)))
    db.add(
        LongShortRatioRow(
            instrument_id=inst.id, time=later, top_traders_ratio=D(3), global_ratio=D(1)
        )
    )
    db.flush()
    now = load_inputs(db, inst, at)

    assert now == then
    assert inputs_fingerprint(now, at) == inputs_fingerprint(then, at)
    assert _times(load_inputs(db, inst, at + D1.delta).h4)[-1] == at + H4.delta * 5


# --- отпечаток входа в сигнале -------------------------------------------------------------------


def _candidate(symbol: str, at: datetime) -> SignalCandidate:
    return SignalCandidate(
        symbol=symbol,
        direction=Direction.UP,
        candle_close_time=at,
        strategy_version="test",
        zone=Zone(ZoneKind.OB, Direction.UP, D(101), D(99), 0, 0, 0, 0),
        zone_kinds=frozenset({ZoneKind.OB}),
        trade=TradeSetup(
            Direction.UP, D(100), D("98.5"), D(97), D(103), D(107), D(112), D(3), D("2.333"), ()
        ),
        score=ScoreBreakdown({"trend": 30}, 80, Grade.A),
        filters=FilterSummary(()),
        bias=BiasContext(Bias.LONG, Trend.UP, Trend.UP, None, None, None, ()),
        input_hash="h" * 64,
        facts=("тест",),
    )


def _version(s: Session) -> StrategyVersion:
    strat = Strategy(slug=f"inputs-{secrets.token_hex(3)}", name="inputs test")
    s.add(strat)
    s.flush()
    ver = StrategyVersion(strategy_id=strat.id, version="9.0.0", params={}, status="forward")
    s.add(ver)
    s.flush()
    return ver


@db_only
def test_write_candidate_stores_the_fingerprint_of_its_inputs(db: Session) -> None:
    inst, ver = _instrument(db), _version(db)
    _closed(db, inst, H4, [AT - H4.delta * i for i in range(1, 7)])
    _closed(db, inst, D1, [MONDAY - D1.delta])
    inputs = load_inputs(db, inst, AT)

    other = _instrument(db)  # по первому инструменту сделка уже открыта — второй сигнал по другому
    assert write_candidate(db, ver, inst, _candidate(inst.symbol, AT), inputs)
    assert write_candidate(db, ver, other, _candidate(other.symbol, AT))  # вход не передан

    def facts(instrument: Instrument) -> dict[str, Any]:
        return (
            db.scalars(select(Signal).where(Signal.instrument_id == instrument.id))
            .one()
            .rationale_facts
        )

    with_inputs, without = facts(inst), facts(other)
    assert with_inputs[INPUTS_FACT] == inputs_fingerprint(inputs, AT)
    assert set(with_inputs[INPUTS_FACT]) >= {"h4", "d1", "w1", "funding", "other"}
    assert INPUTS_FACT not in without
    # прежние ключи обоснования на месте — их читают API и график
    assert {"facts", "publishable", "deferred", "zone", "flags"} <= set(with_inputs)

    # тот же вход, прочитанный позже, даёт тот же отпечаток; изменённая свеча окна — другой
    assert inputs_fingerprint(load_inputs(db, inst, AT), AT) == with_inputs["inputs"]
    upsert_candles(db, inst.id, H4, [_candle(AT - H4.delta * 3, close=101)])
    changed = inputs_fingerprint(load_inputs(db, inst, AT), AT)
    stored = with_inputs[INPUTS_FACT]
    assert {k for k in stored if stored[k] != changed[k]} == {"h4"}


# --- scheduler: дневная и недельная свечи перед оценкой ------------------------------------------


class _History:
    """Подставной REST Binance: отдаёт заданные свечи и запоминает запросы."""

    calls: list[tuple[str, Timeframe]]
    candles: dict[Timeframe, list[Candle]]
    fail: bool

    def __init__(self, market: str) -> None:
        assert market == "futures"

    def fetch_rest(
        self, symbol: str, tf: Timeframe, start: datetime, end: datetime
    ) -> list[Candle]:
        type(self).calls.append((symbol, tf))
        if type(self).fail:
            raise RuntimeError("биржа недоступна")
        return [c for c in type(self).candles.get(tf, []) if start <= c.open_time < end]


@pytest.fixture
def rest(monkeypatch: pytest.MonkeyPatch) -> type[_History]:
    _History.calls, _History.candles, _History.fail = [], {}, False
    monkeypatch.setattr(scheduler, "BinanceHistory", _History)
    return _History


@pytest.fixture
def sched_db(
    make_session: Callable[[], Session], monkeypatch: pytest.MonkeyPatch
) -> Callable[[], Session]:
    monkeypatch.setattr(scheduler, "SessionLocal", make_session)
    monkeypatch.setattr(scheduler, "CONTEXT_POLL", 0.01)
    return make_session


@db_only
def test_ordinary_h4_close_needs_no_context_candles(
    db: Session, sched_db: Any, rest: type[_History]
) -> None:
    inst = _instrument(db)
    assert scheduler.ensure_context_candles(inst.symbol, AT)
    assert scheduler.ensure_context_candles(
        "NOSUCHUSDT", MONDAY
    )  # инструмента нет — не наша забота
    assert rest.calls == []


@db_only
def test_midnight_close_with_closed_day_and_week_goes_straight_on(
    db: Session, sched_db: Any, rest: type[_History]
) -> None:
    inst = _instrument(db)
    _closed(db, inst, D1, [MONDAY - D1.delta])
    _closed(db, inst, W1, [MONDAY - W1.delta])
    assert scheduler.ensure_context_candles(inst.symbol, MONDAY)
    assert rest.calls == []


@db_only
def test_midnight_close_loads_the_missing_day_and_week_over_rest(
    db: Session, sched_db: Any, rest: type[_History]
) -> None:
    """Событие 4h пришло раньше закрытой строки 1d: в БД день ещё идёт. Срок ожидания market-data
    вышел (момент в прошлом) — свечи берутся по REST и пишутся закрытыми, с ценами биржи."""
    inst = _instrument(db)
    day, week = MONDAY - D1.delta, MONDAY - W1.delta
    _forming(db, inst, D1, day)  # закрытия 111 — последний снимок идущей свечи
    rest.candles = {D1: [_candle(day, close=104), _candle(MONDAY)], W1: [_candle(week, close=103)]}

    assert scheduler.ensure_context_candles(inst.symbol, MONDAY)

    assert rest.calls == [(inst.symbol, D1), (inst.symbol, W1)]
    assert missing_context_candles(db, inst.id, MONDAY) == []
    inputs = load_inputs(db, inst, MONDAY)
    assert [(c.open_time, c.close) for c in inputs.d1] == [(day, D(104))]
    assert [(c.open_time, c.close) for c in inputs.w1] == [(week, D(103))]


@db_only
def test_midnight_close_is_not_evaluated_without_the_day_candle(
    db: Session, sched_db: Any, rest: type[_History]
) -> None:
    inst = _instrument(db)
    rest.fail = True
    assert not scheduler.ensure_context_candles(inst.symbol, TUESDAY)  # REST упал
    rest.fail = False
    rest.candles = {D1: [_candle(MONDAY - D1.delta)]}  # биржа отдала, но не ту свечу
    assert not scheduler.ensure_context_candles(inst.symbol, TUESDAY)
    assert missing_context_candles(db, inst.id, TUESDAY) == [(D1, MONDAY)]


@db_only
def test_context_candles_are_awaited_from_market_data_before_rest(
    db: Session, sched_db: Any, rest: type[_History], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Пока срок ожидания не вышел, REST не трогаем: строка от market-data придёт через секунду."""
    inst = _instrument(db)
    at = TUESDAY
    naps: list[float] = []

    def nap(seconds: float) -> None:  # «market-data дописал закрытый день» на втором опросе
        naps.append(seconds)
        if len(naps) == 2:
            _closed(db, inst, D1, [at - D1.delta])

    class _Clock(datetime):
        @classmethod
        def now(cls, tz: Any = None) -> datetime:  # type: ignore[override]
            return at + timedelta(seconds=1)  # секунда после закрытия: срок ещё идёт

    monkeypatch.setattr(scheduler.time, "sleep", nap)
    monkeypatch.setattr(scheduler, "datetime", _Clock)

    assert scheduler.ensure_context_candles(inst.symbol, at)
    assert len(naps) == 2 and rest.calls == []


class _Redis:
    def __init__(self) -> None:
        self.keys: dict[str, str] = {}

    async def set(self, key: str, value: str, nx: bool = False, ex: int | None = None) -> bool:
        if nx and key in self.keys:
            return False
        self.keys[key] = value
        return True

    async def delete(self, key: str) -> None:
        self.keys.pop(key, None)


def test_scheduler_postpones_the_run_until_context_candles_are_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Нет закрытого дня — движок не запускается, отметка «сделано» снимается: fallback повторит."""
    ready = {"value": False}
    runs: list[tuple[str, datetime]] = []
    monkeypatch.setattr(scheduler, "ensure_context_candles", lambda *_: ready["value"])
    monkeypatch.setattr(
        scheduler, "process_symbol", lambda symbol, at: runs.append((symbol, at)) or {}
    )
    s = object.__new__(scheduler.Scheduler)
    s.redis = _Redis()  # type: ignore[assignment]

    asyncio.run(s.try_run("BTCUSDT", MONDAY, "ws"))
    assert runs == [] and s.redis.keys == {}  # type: ignore[attr-defined]

    ready["value"] = True
    asyncio.run(s.try_run("BTCUSDT", MONDAY, "fallback"))
    asyncio.run(s.try_run("BTCUSDT", MONDAY, "fallback"))  # повтор по отметке не запускается
    assert runs == [("BTCUSDT", MONDAY)]
    assert list(s.redis.keys) == [scheduler.done_key("BTCUSDT", MONDAY)]  # type: ignore[attr-defined]
