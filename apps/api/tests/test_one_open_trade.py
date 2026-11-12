"""Одна открытая сделка на инструмент и версию при записи кандидата (задача 6 пакета «Сигналы»).

Само правило — чистая функция движка ``engine.lifecycle.blocking_signal`` (её тесты — в
``packages/engine/tests/test_lifecycle.py``); здесь — то, как им пользуются scheduler и форвард:
``app.forward.write_candidate`` читает сигналы версии по инструменту и не пишет кандидата по
занятому инструменту. Критерий приёмки — тест scheduler: при открытом сигнале второй кандидат
не пишется; на закрытии H4, внутри которой сделка закрылась, — тоже; на следующем — пишется.

Тесты на БД (нужен DATABASE_URL с миграциями до head; без БД пропускаются) идут во внешней
транзакции и откатываются в конце. Исключение — тест блокировки двух соединений: его строки
стратегии и инструментов фиксируются и удаляются в конце, сигналы в нём не фиксируются
(строки ``signals`` удалить нельзя).
"""

from __future__ import annotations

import logging
import random
import secrets
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import Connection, delete, event, func, select, text
from sqlalchemy.exc import DBAPIError, OperationalError
from sqlalchemy.orm import Session

import app.forward as forward
import app.retrack as retrack
import app.workers.scheduler as scheduler
import app.workers.tracker as worker
from app.db import engine
from app.forward import open_trade_blocker, write_candidate
from app.models import (
    Instrument,
    Signal,
    SignalEvent,
    SignalResult,
    Strategy,
    StrategyVersion,
)
from app.retrack import TradeSpan, open_trade_overlap
from engine.bias import Bias, BiasContext
from engine.candles import SIGNAL_TIMEFRAME, Candle, Timeframe
from engine.filters import FilterSummary
from engine.lifecycle import SignalLife, SignalStatus, blocking_signal
from engine.params import StrategyParams
from engine.scoring import Grade, ScoreBreakdown
from engine.signal import MarketInputs, NoSignal, SignalCandidate
from engine.strategies import STRATEGIES
from engine.structure import Direction, Trend
from engine.trade import TradeSetup
from engine.zones import Zone, ZoneKind

D = Decimal
T0 = datetime(2026, 11, 2, 8, tzinfo=UTC)
H4 = SIGNAL_TIMEFRAME.delta
M1 = timedelta(minutes=1)
OPEN_STATUSES = ("pending", "active", "tp1_hit", "tp2_hit")
CLOSED_STATUSES = ("closed_tp3", "closed_be", "closed_sl", "closed_time")

SLUG = "test-one-open-trade"
KEY_A, KEY_B = f"{SLUG}@9.0.0", f"{SLUG}@9.1.0"
PARAMS_A = STRATEGIES["trend-ob-retest@1.1.0"]
PARAMS_B = STRATEGIES["trend-ob-retest@1.2.0"]
A, B = PARAMS_A.version, PARAMS_B.version
"""Версии параметров: по ним подставной ``evaluate`` различает версии стратегии."""
SYMBOL = "ONETRADEUSDT"


def _db_available() -> bool:
    try:
        with engine.connect() as conn:
            conn.execute(text("select scope from signals limit 0"))
            conn.execute(text("select cost_r from signal_results limit 0"))
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


# --- строки и кандидаты ------------------------------------------------------------------------


def _instrument(s: Session, symbol: str | None = None) -> Instrument:
    tag = secrets.token_hex(3).upper()
    inst = Instrument(
        exchange="binance",
        symbol=symbol or f"OT{tag}USDT",
        base=f"OT{tag}",
        quote="USDT",
        market_type="futures",
        tick_size=D("0.01"),
        lot_size=D("0.001"),
    )
    s.add(inst)
    s.flush()
    return inst


def _pair(s: Session, status: str = "forward") -> tuple[StrategyVersion, Instrument]:
    """Своя стратегия с одной версией и свой инструмент — боевые строки не затрагиваются."""
    strat = Strategy(slug=f"one-trade-{secrets.token_hex(3)}", name="one open trade test")
    s.add(strat)
    s.flush()
    ver = StrategyVersion(strategy_id=strat.id, version="9.0.0", params={}, status=status)
    s.add(ver)
    s.flush()
    return ver, _instrument(s)


def _candidate(
    symbol: str, at: datetime, grade: Grade = Grade.A, deferred: bool = False
) -> SignalCandidate:
    """Кандидат движка: лонг, вход 100, стоп 97, цели 103 / 107 / 112. ``Grade.NONE`` — ниже
    порога публикации, ``deferred`` — отложен: такие в бэктесте сделкой не становятся."""
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
        score=ScoreBreakdown({"trend": 30}, 35 if grade is Grade.NONE else 80, grade),
        filters=FilterSummary(()),
        bias=BiasContext(Bias.LONG, Trend.UP, Trend.UP, None, None, None, ()),
        input_hash="h" * 64,
        facts=("тест",),
        deferred=deferred,
    )


def _row(
    s: Session,
    ver: StrategyVersion,
    inst: Instrument,
    at: datetime,
    status: str = "pending",
    closed_at: datetime | None = None,
    scope: str = "forward",
) -> Signal:
    """Сигнал, каким он лежит в БД: статус и, для закрытого, строка ``signal_results``."""
    sig = Signal(
        public_id=secrets.token_hex(5),
        strategy_version_id=ver.id,
        instrument_id=inst.id,
        direction="long",
        candle_close_time=at,
        entry_market=D(100),
        stop_loss=D(97),
        tp1=D(103),
        tp2=D(107),
        tp3=D(112),
        rr_tp2=D("2.333"),
        score=70,
        grade="B",
        status=status,
        scope=scope,
        input_hash="x" * 64,
    )
    s.add(sig)
    s.flush()
    if closed_at is not None:
        s.add(SignalResult(signal_id=sig.id, realized_r=D(-1), closed_at=closed_at))
        s.flush()
    return sig


def _signal_times(s: Session, ver: StrategyVersion, inst: Instrument) -> list[datetime]:
    rows = s.scalars(
        select(Signal.candle_close_time)
        .where(Signal.strategy_version_id == ver.id, Signal.instrument_id == inst.id)
        .order_by(Signal.candle_close_time)
    ).all()
    return [t.astimezone(UTC) for t in rows]


def _busy_lines(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [
        r.getMessage()
        for r in caplog.records
        if r.name == "forward" and r.levelno == logging.INFO and "не записан" in r.getMessage()
    ]


def _minutes(start: datetime, n: int, stop_from: int | None = None) -> list[Candle]:
    """1m-свечи от ``start``: цена стоит на входе (100); с минуты ``stop_from`` — под стопом."""
    out = []
    for i in range(n):
        low = D(96) if stop_from is not None and i >= stop_from else D(100)
        out.append(Candle(start + M1 * i, D(100), D(100), low, low, D(1)))
    return out


# --- критерий приёмки: scheduler ---------------------------------------------------------------


@pytest.fixture
def code_versions(monkeypatch: pytest.MonkeyPatch) -> dict[str, StrategyParams]:
    """Две версии «в коде» у тестовой стратегии; их строки в БД создаёт ``_seed``."""
    strategies = {KEY_A: PARAMS_A, KEY_B: PARAMS_B}
    monkeypatch.setattr(forward, "STRATEGY_SLUG", SLUG)
    monkeypatch.setattr(forward, "STRATEGIES", strategies)
    monkeypatch.setattr(scheduler, "STRATEGIES", strategies)
    monkeypatch.setattr(scheduler, "_reported_skips", {})
    return strategies


def _seed(s: Session, versions: tuple[str, ...] = ("9.0.0",)) -> dict[str, StrategyVersion]:
    strat = Strategy(slug=SLUG, name="one open trade test", description_public="")
    s.add(strat)
    s.flush()
    _instrument(s, SYMBOL)
    out = {}
    for version in ("9.0.0", "9.1.0"):
        # версия вне ``versions`` — в архиве: scheduler её не оценивает
        status = "forward" if version in versions else "archived"
        out[version] = StrategyVersion(
            strategy_id=strat.id, version=version, params={}, status=status
        )
        s.add(out[version])
    s.commit()
    return out


def _candidates_at(
    moments: dict[str, set[datetime]],
) -> Callable[[MarketInputs, datetime, StrategyParams], SignalCandidate | NoSignal]:
    """Вместо ``evaluate``: кандидат по версии параметров в заданные закрытия H4, иначе
    сигнала нет."""

    def fake(inputs: MarketInputs, at: datetime, params: StrategyParams) -> Any:
        if at in moments.get(params.version, set()):
            return _candidate(SYMBOL, at)
        return NoSignal("trigger", "нет ретеста")

    return fake


def _the_signal(s: Session, ver: StrategyVersion, at: datetime) -> Signal:
    return s.scalars(
        select(Signal).where(Signal.strategy_version_id == ver.id, Signal.candle_close_time == at)
    ).one()


def _signal_count(s: Session, version_id: int) -> int:
    query = select(func.count()).select_from(Signal)
    return s.scalar(query.where(Signal.strategy_version_id == version_id)) or 0


@db_only
def test_scheduler_writes_one_trade_at_a_time(
    monkeypatch: pytest.MonkeyPatch,
    make_session: Callable[[], Session],
    code_versions: dict[str, StrategyParams],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Критерий приёмки. Кандидат есть на каждом закрытии H4; сделку ведёт настоящий трекер по
    1m. Пока сделка открыта — второй кандидат не пишется; на закрытии H4, внутри которой сделка
    закрылась, — тоже; на следующем закрытии — пишется."""
    with make_session() as s:
        ver = _seed(s)["9.0.0"]
    every_close = {T0 + H4 * k for k in range(4)}
    monkeypatch.setattr(scheduler, "SessionLocal", make_session)
    monkeypatch.setattr(scheduler, "load_inputs", lambda *_: None)
    monkeypatch.setattr(scheduler, "evaluate", _candidates_at({A: every_close}))
    caplog.set_level(logging.INFO, logger="forward")

    # T0: первый сигнал
    assert scheduler.process_symbol(SYMBOL, T0) == {"signals": 1, "no_signal": 0}
    with make_session() as s:
        first = _the_signal(s, ver, T0)
        # трекер: четыре часа цена стоит — сделка открыта
        worker.apply_candles(s, first, _minutes(T0, 240), Timeframe.M1)
        s.commit()
        assert first.status == "active"
        public_id = first.public_id

    # T0 + 4 ч: сделка открыта — кандидат не записан, в журнале инструмент, версия и id сигнала
    assert scheduler.process_symbol(SYMBOL, T0 + H4) == {"signals": 0, "no_signal": 0}
    (line,) = _busy_lines(caplog)
    assert SYMBOL in line and "9.0.0" in line and public_id in line and "статус active" in line

    # трекер: стоп на 331-й минуте — сделка закрылась внутри свечи T0+4ч … T0+8ч
    with make_session() as s:
        first = _the_signal(s, ver, T0)
        worker.apply_candles(s, first, _minutes(T0 + H4, 240, stop_from=90), Timeframe.M1)
        s.commit()
        assert first.status == "closed_sl"
        result = s.get(SignalResult, first.id)
        assert result is not None and result.closed_at == T0 + H4 + M1 * 91

    # T0 + 8 ч — закрытие свечи, внутри которой сделка закрылась: кандидат не записан
    assert scheduler.process_symbol(SYMBOL, T0 + H4 * 2) == {"signals": 0, "no_signal": 0}
    assert len(_busy_lines(caplog)) == 2
    assert public_id in _busy_lines(caplog)[1] and "closed_sl" in _busy_lines(caplog)[1]
    with make_session() as s:
        assert _signal_count(s, ver.id) == 1

    # T0 + 12 ч — следующее закрытие: инструмент свободен, кандидат записан
    assert scheduler.process_symbol(SYMBOL, T0 + H4 * 3) == {"signals": 1, "no_signal": 0}
    assert len(_busy_lines(caplog)) == 2
    with make_session() as s:
        inst = s.scalars(select(Instrument).where(Instrument.symbol == SYMBOL)).one()
        assert _signal_times(s, ver, inst) == [T0, T0 + H4 * 3]
        second = _the_signal(s, ver, T0 + H4 * 3)
        assert second.status == "pending"
        created = s.scalars(select(SignalEvent.type).where(SignalEvent.signal_id == second.id))
        assert created.all() == ["created"]


@db_only
def test_time_stop_on_the_h4_close_blocks_that_close_only(
    monkeypatch: pytest.MonkeyPatch,
    make_session: Callable[[], Session],
    code_versions: dict[str, StrategyParams],
) -> None:
    """Сделка без TP1 закрывается трекером по времени ровно на закрытии 15-й свечи H4
    (``closed_at == at``). В бэктесте это свеча выхода, и она пропускается: на этом закрытии
    кандидат не пишется, на следующем — пишется. Ответ не зависит от того, успел ли трекер
    закрыть сделку до scheduler: открытая она или закрытая в эту минуту — инструмент занят."""
    with make_session() as s:
        ver = _seed(s)["9.0.0"]
    stop_at = T0 + H4 * PARAMS_A.trade.time_stop_candles
    monkeypatch.setattr(scheduler, "SessionLocal", make_session)
    monkeypatch.setattr(scheduler, "load_inputs", lambda *_: None)
    monkeypatch.setattr(
        scheduler, "evaluate", _candidates_at({A: {T0, stop_at - H4, stop_at, stop_at + H4}})
    )
    monkeypatch.setattr(worker, "STRATEGIES", code_versions)  # трекер берёт срок из версии 9.0.0
    assert scheduler.process_symbol(SYMBOL, T0)["signals"] == 1
    minutes = _minutes(T0, int((stop_at - T0) / M1))

    with make_session() as s:  # трекер отстал на минуту: сделка ещё открыта
        first = _the_signal(s, ver, T0)
        worker.apply_candles(s, first, minutes[:-1], Timeframe.M1)
        s.commit()
        assert first.status == "active"
    assert scheduler.process_symbol(SYMBOL, stop_at - H4)["signals"] == 0
    assert scheduler.process_symbol(SYMBOL, stop_at)["signals"] == 0

    with make_session() as s:  # трекер обработал последнюю минуту: time stop ровно в stop_at
        first = _the_signal(s, ver, T0)
        worker.apply_candles(s, first, minutes[-1:], Timeframe.M1)
        s.commit()
        result = s.get(SignalResult, first.id)
        assert first.status == "closed_time" and result is not None
        assert result.closed_at == stop_at
    assert scheduler.process_symbol(SYMBOL, stop_at)["signals"] == 0
    assert scheduler.process_symbol(SYMBOL, stop_at + H4)["signals"] == 1


@db_only
def test_forward_run_applies_the_same_rule(
    monkeypatch: pytest.MonkeyPatch,
    make_session: Callable[[], Session],
    code_versions: dict[str, StrategyParams],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Форвард (``run_forward``) пишет кандидата тем же ``write_candidate``: правило то же."""
    with make_session() as s:
        ver = _seed(s)["9.0.0"]
    monkeypatch.setattr(forward, "SessionLocal", make_session)
    monkeypatch.setattr(forward, "load_inputs", lambda *_: None)
    monkeypatch.setattr(forward, "evaluate", _candidates_at({A: {T0, T0 + H4, T0 + H4 * 2}}))
    caplog.set_level(logging.INFO, logger="forward")

    def run(at: datetime) -> int:
        stats = forward.run_forward([SYMBOL], refresh=False, now=at + M1 * 2, track=False)
        return stats["signals"]

    assert run(T0) == 1
    assert run(T0) == 0 and _busy_lines(caplog) == []  # повтор той же свечи — молча, как раньше
    assert run(T0 + H4) == 0  # сигнал T0 открыт (pending)
    with make_session() as s:
        first = _the_signal(s, ver, T0)
        (line,) = _busy_lines(caplog)
        assert SYMBOL in line and "9.0.0" in line and first.public_id in line
        first.status = "closed_time"
        s.add(SignalResult(signal_id=first.id, realized_r=D(0), closed_at=T0 + H4))
        s.commit()
    assert run(T0 + H4 * 2) == 1  # закрылась ровно на открытии сигнальной свечи — свободен


@db_only
def test_versions_do_not_block_each_other_in_scheduler(
    monkeypatch: pytest.MonkeyPatch,
    make_session: Callable[[], Session],
    code_versions: dict[str, StrategyParams],
) -> None:
    """Правило — на пару (версия, инструмент): две версии держат по сделке на одном инструменте,
    и каждой мешает только её собственная."""
    with make_session() as s:
        vers = _seed(s, versions=("9.0.0", "9.1.0"))
    a, b = vers["9.0.0"], vers["9.1.0"]
    monkeypatch.setattr(scheduler, "SessionLocal", make_session)
    monkeypatch.setattr(scheduler, "load_inputs", lambda *_: None)
    moments = {T0, T0 + H4, T0 + H4 * 3}
    monkeypatch.setattr(scheduler, "evaluate", _candidates_at({A: moments, B: moments - {T0}}))

    assert scheduler.process_symbol(SYMBOL, T0)["signals"] == 1  # только версия A
    # T0 + 4 ч: у A сделка открыта — её кандидат не пишется; версии B сделка A не мешает
    assert scheduler.process_symbol(SYMBOL, T0 + H4)["signals"] == 1
    with make_session() as s:
        inst = s.scalars(select(Instrument).where(Instrument.symbol == SYMBOL)).one()
        assert _signal_times(s, a, inst) == [T0]
        assert _signal_times(s, b, inst) == [T0 + H4]
        first_a = _the_signal(s, a, T0)
        first_a.status = "closed_sl"
        s.add(SignalResult(signal_id=first_a.id, realized_r=D(-1), closed_at=T0 + H4 + M1 * 7))
        s.commit()
    # T0 + 12 ч: A свободна (её сделка закрылась две свечи назад), B занята своей сделкой
    assert scheduler.process_symbol(SYMBOL, T0 + H4 * 3)["signals"] == 1
    with make_session() as s:
        assert _signal_times(s, a, inst) == [T0, T0 + H4 * 3]
        assert _signal_times(s, b, inst) == [T0 + H4]


# --- запись кандидата: что читается из БД ------------------------------------------------------


@db_only
@pytest.mark.parametrize("status", OPEN_STATUSES)
def test_open_signal_blocks_the_candidate(
    db: Session, caplog: pytest.LogCaptureFixture, status: str
) -> None:
    ver, inst = _pair(db)
    held = _row(db, ver, inst, T0, status)
    caplog.set_level(logging.INFO, logger="forward")
    assert not write_candidate(db, ver, inst, _candidate(inst.symbol, T0 + H4 * 9))
    assert _signal_times(db, ver, inst) == [T0]
    (line,) = _busy_lines(caplog)
    assert line == (
        f"{T0 + H4 * 9:%d.%m %H:%M} {inst.symbol} 9.0.0: кандидат не записан — по инструменту "
        f"у версии уже есть сделка: сигнал {held.public_id} (статус {status})"
    )


@db_only
@pytest.mark.parametrize("status", CLOSED_STATUSES)
def test_closed_trade_blocks_only_the_close_of_its_exit_candle(db: Session, status: str) -> None:
    at = T0 + H4 * 5
    cases = [
        (at - H4 + M1, False),  # закрылась в первую минуту сигнальной свечи
        (at - M1 * 17, False),
        (at, False),  # закрылась её последней минутой
        (at - H4, True),  # ровно на её открытии — свободен
        (T0 + M1 * 15, True),  # давно (старое закрытие через 15 минут)
    ]
    for closed_at, written in cases:
        ver, inst = _pair(db)
        _row(db, ver, inst, T0, status, closed_at)
        assert write_candidate(db, ver, inst, _candidate(inst.symbol, at)) is written, closed_at
        if not written:  # на следующем закрытии H4 — пишется
            assert write_candidate(db, ver, inst, _candidate(inst.symbol, at + H4))


@db_only
@pytest.mark.parametrize("status", ["expired", "cancelled"])
def test_expired_and_cancelled_signals_do_not_block(db: Session, status: str) -> None:
    ver, inst = _pair(db)
    held = _row(db, ver, inst, T0, status)
    # событие отмены или истечения внутри сигнальной свечи инструмент тоже не занимает
    db.add(SignalEvent(signal_id=held.id, type=status, occurred_at=T0 + H4 - M1))
    db.flush()
    assert write_candidate(db, ver, inst, _candidate(inst.symbol, T0 + H4))
    assert _signal_times(db, ver, inst) == [T0, T0 + H4]


@db_only
def test_only_signals_of_the_same_version_and_instrument_count(db: Session) -> None:
    ver, inst = _pair(db)
    other_ver, other_inst = _pair(db)
    _row(db, ver, inst, T0, "active")
    at = T0 + H4
    assert open_trade_blocker(db, ver, inst, at) is not None
    assert open_trade_blocker(db, other_ver, inst, at) is None  # другая версия, тот же инструмент
    assert open_trade_blocker(db, ver, other_inst, at) is None  # та же версия, другой инструмент
    assert write_candidate(db, other_ver, inst, _candidate(inst.symbol, at))
    assert write_candidate(db, ver, other_inst, _candidate(other_inst.symbol, at))
    assert not write_candidate(db, ver, inst, _candidate(inst.symbol, at))


@db_only
@pytest.mark.parametrize(("held_scope", "now_status"), [("forward", "live"), ("live", "forward")])
def test_forward_and_live_signals_of_the_version_both_count(
    db: Session, held_scope: str, now_status: str
) -> None:
    """Версию перевели forward → live (или вернули): её открытая сделка, опубликованная в
    прежней области, по-прежнему занимает инструмент."""
    ver, inst = _pair(db, status=now_status)
    _row(db, ver, inst, T0, "tp1_hit", scope=held_scope)
    assert not write_candidate(db, ver, inst, _candidate(inst.symbol, T0 + H4 * 3))
    assert _signal_times(db, ver, inst) == [T0]


@db_only
@pytest.mark.parametrize("not_a_trade", [{"grade": Grade.NONE}, {"deferred": True}])
def test_candidate_that_is_not_a_trade_in_backtest_is_outside_the_rule(
    db: Session, caplog: pytest.LogCaptureFixture, not_a_trade: dict[str, Any]
) -> None:
    """Кандидат ниже порога публикации и отложенный кандидат в бэктесте сделкой не становятся
    (``skipped['grade_none']``, ``skipped['deferred']``) и инструмент там не занимают. Форвард
    пишет их в ``signals`` с пометкой в ``rationale_facts``, как и раньше; правило их не видит:
    настоящему сигналу такая строка не мешает, и сама она под правило не подпадает."""
    ver, inst = _pair(db)
    caplog.set_level(logging.INFO, logger="forward")
    assert write_candidate(db, ver, inst, _candidate(inst.symbol, T0, **not_a_trade))
    marked = db.scalars(select(Signal).where(Signal.strategy_version_id == ver.id)).one()
    assert marked.rationale_facts["publishable"] is (not_a_trade.get("grade") is not Grade.NONE)
    assert marked.rationale_facts["deferred"] is not_a_trade.get("deferred", False)
    marked.status = "active"  # трекер ведёт и такую строку
    db.flush()

    # настоящий кандидат: в бэктесте инструмент свободен — пишется
    assert open_trade_blocker(db, ver, inst, T0 + H4) is None
    assert write_candidate(db, ver, inst, _candidate(inst.symbol, T0 + H4))
    real = _the_signal(db, ver, T0 + H4)
    # кандидат-не-сделка при открытой настоящей сделке пишется, как раньше, и пропуском не считается
    assert write_candidate(db, ver, inst, _candidate(inst.symbol, T0 + H4 * 2, **not_a_trade))
    assert _busy_lines(caplog) == []
    # следующему настоящему кандидату мешает настоящая сделка — она и названа в журнале
    assert not write_candidate(db, ver, inst, _candidate(inst.symbol, T0 + H4 * 3))
    (line,) = _busy_lines(caplog)
    assert real.public_id in line and marked.public_id not in line
    assert _signal_times(db, ver, inst) == [T0, T0 + H4, T0 + H4 * 2]


@db_only
def test_signal_after_the_candle_does_not_block_it(db: Session) -> None:
    """Без утечки будущего и на уровне БД: сигнал, появившийся позже ``at``, на ответ для ``at``
    не влияет. (Scheduler и форвард обрабатывают только последнее закрытие H4, так что запись
    «задним числом» в работе не встречается.)"""
    ver, inst = _pair(db)
    later = _row(db, ver, inst, T0 + H4 * 2, "active")
    assert open_trade_blocker(db, ver, inst, T0) is None
    assert open_trade_blocker(db, ver, inst, T0 + H4 * 2) is None  # сам себе не мешает
    blocker = open_trade_blocker(db, ver, inst, T0 + H4 * 3)
    assert blocker is not None and blocker.ref == later.public_id
    assert write_candidate(db, ver, inst, _candidate(inst.symbol, T0))


@db_only
def test_same_candle_is_not_written_twice_and_not_reported_as_busy(
    db: Session, caplog: pytest.LogCaptureFixture
) -> None:
    ver, inst = _pair(db)
    caplog.set_level(logging.INFO, logger="forward")
    assert write_candidate(db, ver, inst, _candidate(inst.symbol, T0))
    assert not write_candidate(db, ver, inst, _candidate(inst.symbol, T0))
    assert _signal_times(db, ver, inst) == [T0] and _busy_lines(caplog) == []


@db_only
def test_candidate_time_in_another_zone_is_the_same_moment(db: Session) -> None:
    ver, inst = _pair(db)
    _row(db, ver, inst, T0, "closed_sl", T0 + H4)
    msk = timezone(timedelta(hours=3))
    assert open_trade_blocker(db, ver, inst, (T0 + H4 * 2).astimezone(msk)) is None
    assert open_trade_blocker(db, ver, inst, (T0 + H4).astimezone(msk)) is not None


@db_only
def test_unreadable_signal_row_keeps_the_instrument_busy(
    db: Session, caplog: pytest.LogCaptureFixture
) -> None:
    """Закрытый статус без строки ``signal_results`` (так код не пишет): когда сделка закрылась,
    неизвестно. Сигнал не выдаётся, в журнале — предупреждение с id записи; остальные пары и
    сам прогон не страдают."""
    ver, inst = _pair(db)
    broken = _row(db, ver, inst, T0, "closed_sl")
    caplog.set_level(logging.INFO, logger="forward")
    assert not write_candidate(db, ver, inst, _candidate(inst.symbol, T0 + H4 * 30))
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert broken.public_id in warnings[0].getMessage()
    assert "без времени закрытия" in warnings[0].getMessage()
    assert len(_busy_lines(caplog)) == 1 and broken.public_id in _busy_lines(caplog)[0]
    other_ver, _ = _pair(db)
    assert write_candidate(db, other_ver, inst, _candidate(inst.symbol, T0 + H4 * 30))


# --- два процесса не проходят проверку одновременно --------------------------------------------


@db_only
def test_pair_lock_is_taken_before_anything_is_read(db: Session, conn: Connection) -> None:
    """Блокировка пары — первый запрос записи кандидата: и проверка повтора свечи, и чтение
    сигналов для правила идут уже под ней. Если брать блокировку после проверок (прямо перед
    вставкой), второй процесс прошёл бы их по устаревшим данным, дождался первого и записал
    вторую сделку — а тест «второй ждёт» остался бы зелёным."""
    ver, inst = _pair(db)
    db.commit()
    statements: list[str] = []

    def record(_conn: Any, _cursor: Any, statement: str, *_: Any) -> None:
        statements.append(" ".join(statement.lower().split()))

    event.listen(conn, "before_cursor_execute", record)
    try:
        assert write_candidate(db, ver, inst, _candidate(inst.symbol, T0))
    finally:
        event.remove(conn, "before_cursor_execute", record)
    lock = next(i for i, q in enumerate(statements) if "pg_advisory_xact_lock" in q)
    reads = [i for i, q in enumerate(statements) if q.startswith("select") and "from signals" in q]
    insert = next(i for i, q in enumerate(statements) if q.startswith("insert into signals"))
    assert len(reads) >= 2, statements  # повтор свечи и сигналы пары для правила
    assert lock < min(reads) < insert, statements


@db_only
def test_application_sessions_read_committed() -> None:
    """Защита от двух записей держится на READ COMMITTED: запрос после ожидания блокировки
    видит то, что зафиксировал первый процесс. Под REPEATABLE READ второй прошёл бы проверку
    по снимку, сделанному до ожидания."""
    with forward.SessionLocal() as s:
        assert s.execute(text("show transaction_isolation")).scalar_one() == "read committed"


@db_only
def test_second_writer_waits_for_the_pair_until_the_first_transaction_ends() -> None:
    """Проверка и вставка идут под блокировкой пары (версия, инструмент) до конца транзакции.
    Пока первый процесс не зафиксировал или не откатил запись, второй не может даже начать
    проверку по этой паре — значит, не может пройти её по устаревшим данным. Другой паре
    блокировка не мешает. Сигналы здесь не фиксируются: обе транзакции откатываются."""
    tag = secrets.token_hex(3)
    with Session(engine) as s:
        strat = Strategy(slug=f"one-trade-lock-{tag}", name="one open trade lock test")
        s.add(strat)
        s.flush()
        ver = StrategyVersion(strategy_id=strat.id, version="9.0.0", params={}, status="forward")
        s.add(ver)
        ids = (strat.id, _instrument(s).id, _instrument(s).id)
        s.commit()
        ver_id = ver.id
    strat_id, inst_id, other_id = ids
    first, second = Session(engine), Session(engine)

    def attempt(session: Session, instrument_id: int, at: datetime) -> bool:
        version = session.get_one(StrategyVersion, ver_id)
        inst = session.get_one(Instrument, instrument_id)
        session.execute(text("set local lock_timeout = '300ms'"))
        return write_candidate(session, version, inst, _candidate(inst.symbol, at))

    try:
        assert attempt(first, inst_id, T0)  # записал, транзакция ещё открыта
        with pytest.raises(OperationalError, match="lock timeout"):
            attempt(second, inst_id, T0 + H4)
        second.rollback()
        assert attempt(second, other_id, T0 + H4)  # другой инструмент — без ожидания
        second.rollback()
        first.rollback()  # первый откатился: блокировка снята, сигнала нет — второй пишет
        assert attempt(second, inst_id, T0 + H4)
        # и уже сам держит пару: первый теперь ждёт его
        with pytest.raises(OperationalError, match="lock timeout"):
            attempt(first, inst_id, T0 + H4 * 2)
    finally:
        for session in (first, second):
            session.rollback()
            session.close()
        with Session(engine) as s:
            assert _signal_count(s, ver_id) == 0
            s.execute(delete(StrategyVersion).where(StrategyVersion.id == ver_id))
            s.execute(delete(Strategy).where(Strategy.id == strat_id))
            s.execute(delete(Instrument).where(Instrument.id.in_([inst_id, other_id])))
            s.commit()


# --- пометка отчёта пересчёта — то же правило (задача 7) ---------------------------------------


def test_retrack_flag_asks_the_engine_rule(monkeypatch: pytest.MonkeyPatch) -> None:
    """``open_trade_overlap`` своего правила не держит: ответ даёт ``blocking_signal``."""
    asked: list[tuple[list[SignalLife], datetime]] = []

    def spy(signals: Any, at: datetime) -> SignalLife | None:
        signals = list(signals)
        asked.append((signals, at))
        return blocking_signal(signals, at)

    monkeypatch.setattr(retrack, "blocking_signal", spy)
    at = T0 + H4 * 5
    spans = [
        TradeSpan("open", T0, None),
        TradeSpan("closed", T0 + H4, at - M1),
        TradeSpan("unknown", T0, None, known=False),
    ]
    overlap = open_trade_overlap(spans, at)
    assert (overlap.flag, overlap.with_public_id) == (True, "open")
    ((signals, asked_at),) = asked
    assert asked_at == at
    # сделка, которую не удалось пересчитать, правилу не подаётся
    assert [(s.ref, s.status.is_open, s.closed_at) for s in signals] == [
        ("open", True, None),
        ("closed", False, at - M1),
    ]

    monkeypatch.setattr(retrack, "blocking_signal", lambda signals, at: None)
    assert open_trade_overlap(spans[:2], at).flag is False  # решает правило, а не отчёт


def test_retrack_flag_agrees_with_the_engine_rule_on_random_histories() -> None:
    rng = random.Random(67)
    flags = {True: 0, False: 0}
    for _ in range(500):
        spans = []
        for n in range(rng.randint(0, 5)):
            opened = T0 + H4 * rng.randint(0, 30)
            closed = None if rng.random() < 0.2 else opened + M1 * rng.randint(1, 70 * 60)
            spans.append(TradeSpan(f"s{n}", opened, closed))
        at = T0 + H4 * rng.randint(0, 40)
        lives = [
            SignalLife(
                s.public_id,
                s.opened_at,
                SignalStatus.TP2_HIT if s.closed_at is None else SignalStatus.CLOSED_BE,
                s.closed_at,
            )
            for s in spans
        ]
        expected = blocking_signal(lives, at)
        overlap = open_trade_overlap(spans, at)
        assert overlap.flag is (expected is not None)
        assert overlap.with_public_id == (expected.ref if expected else None)
        flags[overlap.flag is True] += 1
    assert min(flags.values()) > 50
