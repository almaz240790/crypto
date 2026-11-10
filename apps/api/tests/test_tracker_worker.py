"""Трекер-воркер: сериализация состояния, запись событий/результата и проход догона.

Основные тесты — без БД, на сессии-заглушке. Последний тест (точки сохранения в ``catch_up``)
идёт на реальной БД и без неё пропускается.
"""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError, OperationalError
from sqlalchemy.orm import sessionmaker

import app.workers.tracker as worker
from app.db import engine
from app.models import (
    Instrument,
    Signal,
    SignalEvent,
    SignalResult,
    SignalTracking,
    Strategy,
    StrategyVersion,
)
from app.models.market import Candle as CandleRow
from app.workers.scheduler import done_key
from app.workers.tracker import apply_candles, state_from_json, state_to_json
from engine.candles import Candle, Timeframe
from engine.params import TradeParams
from engine.structure import Direction
from engine.tracker import SignalStatus, SignalTracker
from engine.trade import TradeSetup

D = Decimal
LONG = TradeSetup(
    Direction.UP, D(100), D("98.5"), D(97), D(103), D(107), D(112), D(3), D(7) / D(3), ()
)
SIGNAL_CLOSE = datetime(2026, 11, 4, 8, tzinfo=UTC)
M1 = Timeframe.M1.delta


def test_state_roundtrip_after_events() -> None:
    t = SignalTracker(LONG, TradeParams())
    t.step(Candle(datetime(2024, 1, 1, tzinfo=UTC), D(100), D(104), D(99), D(103), D(1)))
    assert t.state.status is SignalStatus.TP1_HIT
    restored = state_from_json(state_to_json(t.state))
    assert restored == t.state
    assert (
        state_from_json(state_to_json(SignalTracker(LONG, TradeParams()).state)).status
        is SignalStatus.PENDING
    )


def test_done_key_format() -> None:
    assert (
        done_key("BTCUSDT", datetime(2026, 10, 25, 12, tzinfo=UTC))
        == "sched:done:BTCUSDT:20261025T1200"
    )


# --- apply_candles на 1m (план 2.6, 2.10) -----------------------------------------------------


class FakeSession:
    """Ровно то, что использует ``apply_candles``: ``get`` и ``add``."""

    def __init__(self, *objs: Any) -> None:
        self.rows: dict[tuple[type, int], Any] = {}
        self.added: list[Any] = []
        for o in objs:
            self.add(o)

    def get(self, model: type, key: int) -> Any:
        return self.rows.get((model, key))

    def add(self, obj: Any) -> None:
        self.added.append(obj)
        key = obj.signal_id if isinstance(obj, SignalTracking | SignalResult) else obj.id
        self.rows[(type(obj), key)] = obj

    def events(self) -> list[SignalEvent]:
        return [o for o in self.added if isinstance(o, SignalEvent)]


def _signal(status: str = "pending", sid: int = 1, close: datetime = SIGNAL_CLOSE) -> Signal:
    return Signal(
        id=sid,
        public_id=f"t{sid}",
        strategy_version_id=1,
        instrument_id=sid,
        direction="long",
        candle_close_time=close,
        entry_market=D(100),
        entry_limit=D("98.5"),
        stop_loss=D(97),
        tp1=D(103),
        tp2=D(107),
        tp3=D(112),
        rr_tp2=D(7) / D(3),
        score=70,
        grade="B",
        input_hash="x" * 64,
        status=status,
        scope="forward",
    )


def _session(sig: Signal, *extra: Any) -> FakeSession:
    return FakeSession(sig, StrategyVersion(id=1, version="1.0.0", status="forward"), *extra)


def _minutes(start: datetime, n: int) -> list[Candle]:
    """Минуты у 100 ± 0.5: ни TP1 (103), ни стопа (97) — сделка доживает до time stop."""
    return [
        Candle(start + M1 * i, D(100), D("100.5"), D("99.5"), D(100) + D("0.1") * (i % 3 - 1), D(1))
        for i in range(n)
    ]


def _result(session: FakeSession) -> SignalResult:
    res = session.get(SignalResult, 1)
    assert isinstance(res, SignalResult)
    return res


def test_apply_candles_1m_time_stop_after_60h() -> None:
    sig = _signal()
    session = _session(sig)
    minutes = _minutes(SIGNAL_CLOSE, 61 * 60)
    apply_candles(session, sig, minutes, Timeframe.M1)  # type: ignore[arg-type]
    types = [e.type for e in session.events()]
    assert types == ["activated", "time_stop"]
    stop = session.events()[-1]
    deadline = SIGNAL_CLOSE + timedelta(hours=60)
    assert stop.occurred_at == deadline
    assert stop.price == minutes[60 * 60 - 1].close
    assert stop.note == (
        "time stop: срок 2026-11-06 20:00 UTC (15 свечей 4h); "
        f"выход 2026-11-06 20:00 UTC по close свечи 1m 19:59–20:00: {stop.price}"
    )
    res = _result(session)
    assert res.closed_at == deadline
    assert res.duration_hours is not None and res.duration_hours.quantize(D("0.01")) == D("60.00")
    assert sig.status == "closed_time"
    row = session.get(SignalTracking, 1)
    json.dumps(row.state)  # JSONB: состояние сериализуется без datetime-объектов
    assert row.state["deadline_at"] == deadline.isoformat()


def test_apply_candles_in_catch_up_chunks_matches_single_pass() -> None:
    """Догон порциями (как раз в минуту) восстанавливает новое состояние и даёт тот же итог."""
    sig = _signal()
    session = _session(sig)
    minutes = _minutes(SIGNAL_CLOSE, 61 * 60)
    for i in range(0, len(minutes), 7 * 60 + 13):
        apply_candles(session, sig, minutes[i : i + 7 * 60 + 13], Timeframe.M1)  # type: ignore[arg-type]
    assert [e.type for e in session.events()] == ["activated", "time_stop"]
    assert _result(session).closed_at == SIGNAL_CLOSE + timedelta(hours=60)


def test_legacy_json_state_is_read_and_closed_by_time() -> None:
    """Состояние, записанное до исправления (без сроков и времени событий), доводится до 60 ч."""
    sig = _signal(status="active")
    legacy = {
        "status": "active",
        "entry_price": "100",
        "stop": "97",
        "hits": 0,
        "realized_r": "0",
        "remaining": "1",
        "candles_seen": 5,
        "candles_active": 5,
        "mfe_r": "0.1666666666666666666666666667",
        "mae_r": "-0.1666666666666666666666666667",
        "r_if_tp1_only": None,
        "r_if_full_tp2": None,
        "events": [{"type": "activated", "price": "100", "candle_index": 0}],
    }
    row = SignalTracking(
        signal_id=1, state=legacy, timeframe="1m", last_candle_time=SIGNAL_CLOSE + M1 * 4
    )
    session = _session(sig, row)
    apply_candles(session, sig, _minutes(SIGNAL_CLOSE, 61 * 60), Timeframe.M1)  # type: ignore[arg-type]
    assert [e.type for e in session.events()] == ["time_stop"]
    assert session.events()[0].occurred_at == SIGNAL_CLOSE + timedelta(hours=60)
    res = _result(session)
    assert res.closed_at == SIGNAL_CLOSE + timedelta(hours=60)
    assert res.duration_hours is not None and res.duration_hours.quantize(D("0.01")) == D("60.00")
    assert sig.status == "closed_time"


def test_missing_deadline_minute_closes_on_next_and_notes_it() -> None:
    sig = _signal()
    session = _session(sig)
    minutes = [
        m
        for m in _minutes(SIGNAL_CLOSE, 61 * 60)
        if not (60 * 60 - 1 <= (m.open_time - SIGNAL_CLOSE) // M1 <= 60 * 60 + 1)
    ]
    apply_candles(session, sig, minutes, Timeframe.M1)  # type: ignore[arg-type]
    stop = session.events()[-1]
    # минут 19:59, 20:00 и 20:01 нет: выход по close первой имеющейся минуты после срока
    assert stop.type == "time_stop"
    assert stop.occurred_at == SIGNAL_CLOSE + timedelta(hours=60, minutes=3)
    assert stop.note is not None and "свечи на сроке нет" in stop.note
    assert "выход 2026-11-06 20:03 UTC" in stop.note and "после срока 20:02–20:03" in stop.note
    assert _result(session).closed_at == SIGNAL_CLOSE + timedelta(hours=60, minutes=3)


# --- catch_up: ошибка одного сигнала не останавливает проход (T1-R1) ---------------------------


class FakeSavepoint:
    """Точка сохранения заглушки: откат убирает всё, что добавлено в сессию после неё."""

    def __init__(self, session: CatchUpSession) -> None:
        self.session = session
        self.rows = dict(session.rows)
        self.added = list(session.added)

    def commit(self) -> None:
        self.session.released += 1

    def rollback(self) -> None:
        self.session.rows, self.session.added = self.rows, self.added
        self.session.rolled_back += 1


class CatchUpSession(FakeSession):
    """Сверх ``FakeSession`` — то, что использует ``catch_up``: выборка открытых сигналов,
    точки сохранения и фиксация прохода."""

    def __init__(self, *signals: Signal) -> None:
        super().__init__(*signals, StrategyVersion(id=1, version="1.0.0", status="forward"))
        self.signals = signals
        self.commits = self.released = self.rolled_back = 0

    def __enter__(self) -> CatchUpSession:
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def scalars(self, _query: object) -> Any:
        opened = [s for s in self.signals if s.status in worker.OPEN]
        return SimpleNamespace(all=lambda: opened)

    def begin_nested(self) -> FakeSavepoint:
        return FakeSavepoint(self)

    def commit(self) -> None:
        self.commits += 1


def _minutes_to_stop(start: datetime, n: int = 15) -> list[Candle]:
    """Минуты у 100; на одиннадцатой low = 96 — стоп лонга (97)."""
    return [
        Candle(start + M1 * i, D(100), D("100.5"), D(96) if i == 10 else D("99.5"), D(100), D(1))
        for i in range(n)
    ]


def _patch_catch_up(
    monkeypatch: pytest.MonkeyPatch,
    session: CatchUpSession,
    streams: dict[int, list[Candle] | Exception],
) -> list[dict[str, Any]]:
    """Подменяет БД и Redis в ``catch_up``. Возвращает список опубликованных смен статуса."""
    published: list[dict[str, Any]] = []

    def candles_after(_s: object, instrument_id: int, since: datetime, _tf: object) -> list[Candle]:
        stream = streams[instrument_id]
        if isinstance(stream, Exception):
            raise stream
        return [c for c in stream if c.open_time >= since]

    monkeypatch.setattr(worker, "SessionLocal", lambda: session)
    monkeypatch.setattr(worker, "_candles_after", candles_after)
    monkeypatch.setattr(worker, "_publish_status", published.extend)
    return published


def _error(rec: logging.LogRecord) -> BaseException:
    assert rec.exc_info is not None and rec.exc_info[1] is not None
    return rec.exc_info[1]


def test_catch_up_skips_signal_the_tracker_rejects_and_tracks_the_rest(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """``candle_close_time`` не на границе H4 трекер отвергает (``ValueError``). Такой сигнал
    пропускается с записью в лог; сигналы до и после него ведутся, проход фиксируется."""
    before, broken, after = (
        _signal(sid=1),
        _signal(sid=2, close=SIGNAL_CLOSE + M1 * 5),
        _signal(sid=3),
    )
    session = CatchUpSession(before, broken, after)
    published = _patch_catch_up(
        monkeypatch, session, {i: _minutes_to_stop(SIGNAL_CLOSE) for i in (1, 2, 3)}
    )
    for attempt in (1, 2):  # ошибка повторяется на каждом проходе и каждый раз не мешает остальным
        caplog.clear()
        with caplog.at_level(logging.ERROR, logger="tracker"):
            assert worker.catch_up(Timeframe.M1) == (4 if attempt == 1 else 0)
        assert session.commits == attempt
        (rec,) = caplog.records
        assert "сигнал t2 (id 2, инструмент 2)" in rec.getMessage()
        assert "пропущен" in rec.getMessage()
        assert isinstance(_error(rec), ValueError) and "не на границе 4h" in str(_error(rec))
    assert [s.status for s in (before, broken, after)] == ["closed_sl", "pending", "closed_sl"]
    assert [(e.signal_id, e.type) for e in session.events()] == [
        (1, "activated"),
        (1, "sl"),
        (3, "activated"),
        (3, "sl"),
    ]
    assert session.get(SignalTracking, 2) is None and session.get(SignalResult, 2) is None
    assert [c["id"] for c in published] == ["t1", "t3"]


def test_catch_up_rolls_back_events_of_a_step_that_failed_midway(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Свеча не на сетке 1m посреди потока: событие входа уже добавлено в сессию, когда трекер
    отвергает свечу. Шаг сигнала откатывается целиком — событий без состояния не остаётся."""
    broken, healthy = _signal(sid=1), _signal(sid=2)
    session = CatchUpSession(broken, healthy)
    off_grid = _minutes_to_stop(SIGNAL_CLOSE)
    off_grid[3] = replace(off_grid[3], open_time=off_grid[3].open_time + timedelta(seconds=30))
    published = _patch_catch_up(
        monkeypatch, session, {1: off_grid, 2: _minutes_to_stop(SIGNAL_CLOSE)}
    )
    with caplog.at_level(logging.ERROR, logger="tracker"):
        assert worker.catch_up(Timeframe.M1) == 2
    assert [(e.signal_id, e.type) for e in session.events()] == [(2, "activated"), (2, "sl")]
    assert broken.status == "pending" and session.get(SignalTracking, 1) is None
    assert healthy.status == "closed_sl" and session.get(SignalResult, 2) is not None
    assert session.rolled_back == 1 and session.commits == 1
    (rec,) = caplog.records
    assert "сигнал t1 (id 1, инструмент 1)" in rec.getMessage()
    assert isinstance(_error(rec), ValueError) and "не на сетке 1m" in str(_error(rec))
    assert [c["id"] for c in published] == ["t2"]


@pytest.mark.parametrize("connection_lost", [False, True])
def test_catch_up_db_error_skips_signal_unless_connection_is_lost(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, connection_lost: bool
) -> None:
    """Ошибка БД на одном сигнале (соединение живо) — пропуск сигнала. Потеря соединения — не
    ошибка сигнала: проход падает целиком и ничего не фиксирует, как до изоляции."""
    first, failing, last = _signal(sid=1), _signal(sid=2), _signal(sid=3)
    session = CatchUpSession(first, failing, last)
    err = OperationalError("select", {}, Exception("сбой"), connection_invalidated=connection_lost)
    minutes = _minutes_to_stop(SIGNAL_CLOSE)
    published = _patch_catch_up(monkeypatch, session, {1: minutes, 2: err, 3: minutes})
    with caplog.at_level(logging.ERROR, logger="tracker"):
        if connection_lost:
            with pytest.raises(OperationalError):
                worker.catch_up(Timeframe.M1)
            assert session.commits == 0 and session.rolled_back == 0
            assert caplog.records == [] and published == []
            assert last.status == "pending"
        else:
            assert worker.catch_up(Timeframe.M1) == 4
            assert session.commits == 1 and session.rolled_back == 1
            assert [s.status for s in (first, failing, last)] == [
                "closed_sl",
                "pending",
                "closed_sl",
            ]
            (rec,) = caplog.records
            assert "сигнал t2" in rec.getMessage() and _error(rec) is err
            assert [c["id"] for c in published] == ["t1", "t3"]


# --- то же на реальной БД: настоящие SAVEPOINT (без доступной БД тест пропускается) ------------


def _db_available() -> bool:
    try:
        with engine.connect() as conn:
            conn.execute(text("select 1 from signal_tracking limit 0"))
        return True
    except (OperationalError, DBAPIError):
        return False


db_only = pytest.mark.skipif(not _db_available(), reason="БД с миграциями недоступна")


@db_only
def test_catch_up_isolates_failed_signals_with_real_savepoints(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Два сломанных сигнала (``candle_close_time`` не на границе H4; свеча не на сетке 1m
    после свечи входа) между двумя здоровыми. Здоровые закрыты и записаны, от сломанных в БД
    нет ни событий, ни состояния. Всё идёт во внешней транзакции, которая в конце
    откатывается: строки ``signals`` удалить нельзя (триггер), в БД ничего не остаётся."""
    conn = engine.connect()
    outer = conn.begin()
    factory = sessionmaker(
        bind=conn, expire_on_commit=False, join_transaction_mode="create_savepoint"
    )
    published: list[dict[str, Any]] = []
    monkeypatch.setattr(worker, "SessionLocal", factory)
    monkeypatch.setattr(worker, "_publish_status", published.extend)
    tag = uuid.uuid4().hex[:8]
    cases = {  # имя → (закрытие сигнальной свечи, сдвиг четвёртой минуты с сетки)
        "before": (SIGNAL_CLOSE, timedelta(0)),
        "badclose": (SIGNAL_CLOSE + M1 * 5, timedelta(0)),
        "badcandle": (SIGNAL_CLOSE, timedelta(seconds=30)),
        "after": (SIGNAL_CLOSE, timedelta(0)),
    }
    try:
        with factory() as s:
            strat = Strategy(slug=f"t1r1-{tag}", name="t")
            s.add(strat)
            s.flush()
            ver = StrategyVersion(
                strategy_id=strat.id, version="1.0.0", params={}, status="forward"
            )
            s.add(ver)
            s.flush()
            for name, (close, shift) in cases.items():
                inst = Instrument(
                    exchange="binance",
                    symbol=f"{name}{tag}".upper(),
                    base=name[:8].upper(),
                    quote="USDT",
                    market_type="futures",
                    tick_size=D("0.01"),
                    lot_size=D("0.001"),
                )
                s.add(inst)
                s.flush()
                s.add(
                    Signal(
                        public_id=f"{name[:8]}{tag}",
                        strategy_version_id=ver.id,
                        instrument_id=inst.id,
                        direction="long",
                        candle_close_time=close,
                        entry_market=D(100),
                        stop_loss=D(97),
                        tp1=D(103),
                        tp2=D(107),
                        tp3=D(112),
                        rr_tp2=D("2.333"),
                        score=70,
                        grade="B",
                        scope="forward",
                        input_hash="x" * 64,
                    )
                )
                for i, c in enumerate(_minutes_to_stop(SIGNAL_CLOSE)):
                    s.add(
                        CandleRow(
                            instrument_id=inst.id,
                            timeframe="1m",
                            open_time=c.open_time + (shift if i == 3 else timedelta(0)),
                            open=c.open,
                            high=c.high,
                            low=c.low,
                            close=c.close,
                            volume=c.volume,
                        )
                    )
            s.commit()

        with caplog.at_level(logging.ERROR, logger="tracker"):
            worker.catch_up(Timeframe.M1)

        with factory() as s:
            got = {}
            for name in cases:
                sig = s.scalars(select(Signal).where(Signal.public_id == f"{name[:8]}{tag}")).one()
                events = s.scalars(
                    select(SignalEvent.type)
                    .where(SignalEvent.signal_id == sig.id)
                    .order_by(SignalEvent.id)
                ).all()
                got[name] = (
                    sig.status,
                    list(events),
                    s.get(SignalTracking, sig.id) is not None,
                    s.get(SignalResult, sig.id) is not None,
                )
        closed = ("closed_sl", ["activated", "sl"], True, True)
        untouched = ("pending", [], False, False)
        assert got == {
            "before": closed,
            "badclose": untouched,
            "badcandle": untouched,
            "after": closed,
        }
        ours = sorted(r.getMessage().split()[1] for r in caplog.records if tag in r.getMessage())
        assert ours == [f"badcandl{tag}", f"badclose{tag}"]
        assert sorted(c["id"] for c in published if tag in c["id"]) == [
            f"after{tag}",
            f"before{tag}",
        ]
    finally:
        outer.rollback()
        conn.close()
