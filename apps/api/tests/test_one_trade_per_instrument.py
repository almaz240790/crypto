"""Одна открытая сделка на инструмент и версию в scheduler и forward — как в бэктесте (задача 6).

Все тесты — на реальной БД (нужен DATABASE_URL с миграциями до head; без неё пропускаются).
Каждый тест идёт во внешней транзакции, которая в конце откатывается: ``commit`` в коде
закрывает только точку сохранения.

- критерий приёмки: при открытом сигнале второй кандидат не пишется; на закрытии H4, внутри
  которой сделка закрылась (1m-трекер), — тоже; на следующем закрытии — пишется;
- forward (``run_forward``) идёт через ту же запись кандидата;
- граничные случаи записи: истёкший лимит, отмена, другая версия и другой инструмент, форвард-
  сигнал версии, ставшей live;
- сквозной прогон: scheduler + трекер по H4 на случайном ряду дают те же сигналы, статусы и
  моменты выхода, что ``run_backtest`` на тех же свечах.
"""

from __future__ import annotations

import logging
import random
import secrets
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import Connection, select, text
from sqlalchemy.exc import DBAPIError, OperationalError
from sqlalchemy.orm import Session

import app.forward as forward
import app.workers.scheduler as scheduler
import engine.backtest as bt
from app.db import engine
from app.models import (
    Instrument,
    Signal,
    SignalEvent,
    SignalResult,
    Strategy,
    StrategyVersion,
)
from app.workers.tracker import apply_candles
from engine.backtest import DEFAULT_EXECUTION, run_backtest
from engine.candles import Candle, Timeframe
from engine.signal import MarketInputs, NoSignal, SignalCandidate
from engine.strategies import STRATEGIES
from engine.structure import Direction
from engine.trade import TradeSetup

D = Decimal
H4 = Timeframe.H4.delta
M1 = Timeframe.M1.delta
T0 = datetime(2026, 10, 26, 8, tzinfo=UTC)
PARAMS = STRATEGIES["trend-ob-retest@1.2.0"]


def _db_available() -> bool:
    try:
        with engine.connect() as conn:
            conn.execute(text("select scope from signals limit 0"))
        return True
    except (OperationalError, DBAPIError):
        return False


pytestmark = pytest.mark.skipif(not _db_available(), reason="БД с миграциями недоступна")


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
    return lambda: Session(
        bind=conn, join_transaction_mode="create_savepoint", expire_on_commit=False
    )


@pytest.fixture
def code_version(monkeypatch: pytest.MonkeyPatch) -> str:
    """Версия «в коде» со своим slug, чтобы не трогать строки настоящей стратегии."""
    slug = f"test-one-trade-{secrets.token_hex(3)}"
    key = f"{slug}@9.0.0"
    strategies = {key: PARAMS}
    monkeypatch.setattr(forward, "STRATEGY_SLUG", slug)
    monkeypatch.setattr(forward, "STRATEGIES", strategies)
    monkeypatch.setattr(scheduler, "STRATEGIES", strategies)
    monkeypatch.setattr(scheduler, "_reported_skips", {})
    return key


def _instrument(s: Session) -> Instrument:
    tag = secrets.token_hex(3).upper()
    inst = Instrument(
        exchange="binance",
        symbol=f"OT{tag}USDT",
        base=f"OT{tag}",
        quote="USDT",
        market_type="futures",
        tick_size=D("0.01"),
        lot_size=D("0.001"),
    )
    s.add(inst)
    s.flush()
    return inst


def _seed(s: Session, key: str, status: str = "forward") -> tuple[StrategyVersion, Instrument]:
    slug, version = key.split("@")
    strat = Strategy(slug=slug, name="test", description_public="")
    s.add(strat)
    s.flush()
    ver = StrategyVersion(strategy_id=strat.id, version=version, params={"t": slug}, status=status)
    s.add(ver)
    inst = _instrument(s)
    s.commit()
    return ver, inst


def _setup(close: Decimal, up: bool = True) -> TradeSetup:
    """Сетап от цены закрытия: стоп 3 %, тейки +3/+7/+12 % (шорт — зеркально)."""
    k = D(1) if up else D(-1)
    return TradeSetup(
        Direction.UP if up else Direction.DOWN,
        close,
        close,
        close * (1 - k * D("0.03")),
        close * (1 + k * D("0.03")),
        close * (1 + k * D("0.07")),
        close * (1 + k * D("0.12")),
        close * D("0.03"),
        D(7) / D(3),
        (),
    )


def _candidate(
    at: datetime, setup: TradeSetup | None = None, publishable: bool = True, deferred: bool = False
) -> SignalCandidate:
    """Настоящий ``SignalCandidate`` с полями, которые читают scheduler, forward и бэктест."""
    trade = setup or _setup(D(100))
    return SignalCandidate(
        symbol="X",
        direction=trade.direction,
        candle_close_time=at,
        strategy_version=PARAMS.version,
        zone=SimpleNamespace(kind="ob", top=D(101), bottom=D(99)),  # type: ignore[arg-type]
        zone_kinds=frozenset(),
        trade=trade,
        score=SimpleNamespace(  # type: ignore[arg-type]
            total=75,
            grade=SimpleNamespace(value="B"),
            publishable=publishable,
            components={"trend": 30},
        ),
        filters=SimpleNamespace(flags=[]),  # type: ignore[arg-type]
        bias=None,  # type: ignore[arg-type]
        input_hash="h" * 64,
        facts=(f"тест {at:%d.%m %H:%M}",),
        deferred=deferred,
    )


def _signal_times(s: Session, version_id: int, instrument_id: int) -> list[datetime]:
    rows = s.scalars(
        select(Signal.candle_close_time)
        .where(Signal.strategy_version_id == version_id, Signal.instrument_id == instrument_id)
        .order_by(Signal.candle_close_time)
    ).all()
    return [r.astimezone(UTC) for r in rows]


def _minutes(start: datetime, n: int, low_at: int | None = None) -> list[Candle]:
    """1m-свечи у цены 100; в минуту ``low_at`` (номер от ``start``) цена падает до 94."""
    out = []
    for i in range(n):
        low = D(94) if i == low_at else D("99.5")
        out.append(Candle(start + M1 * i, D(100), D("100.5"), low, D(100), D(1)))
    return out


# --- критерий приёмки: scheduler ------------------------------------------------------------------


def test_scheduler_writes_second_candidate_only_after_exit_candle(
    monkeypatch: pytest.MonkeyPatch,
    make_session: Callable[[], Session],
    code_version: str,
    caplog: pytest.LogCaptureFixture,
) -> None:
    with make_session() as s:
        ver, inst = _seed(s, code_version)
    symbol = inst.symbol

    monkeypatch.setattr(scheduler, "SessionLocal", make_session)
    monkeypatch.setattr(scheduler, "load_inputs", lambda *_: None)
    monkeypatch.setattr(scheduler, "evaluate", lambda _inp, at, _p: _candidate(at))
    caplog.set_level(logging.INFO, logger="forward")

    # 1) закрытие T0: инструмент свободен — сигнал записан
    assert scheduler.process_symbol(symbol, T0)["signals"] == 1
    with make_session() as s:
        first = s.scalars(select(Signal).where(Signal.instrument_id == inst.id)).one()
        first_id = first.public_id

    # 2) закрытие T0+4ч: первый сигнал открыт — второй кандидат не пишется, строка INFO
    assert scheduler.process_symbol(symbol, T0 + H4)["signals"] == 0
    busy = [r for r in caplog.records if "инструмент занят" in r.getMessage()]
    assert len(busy) == 1 and busy[0].levelno == logging.INFO
    msg = busy[0].getMessage()
    assert symbol in msg and ver.version in msg and first_id in msg and "pending" in msg

    # 1m-трекер: стоп в 14:37 внутри свечи H4 12:00–16:00 (T0+4ч … T0+8ч)
    sl_minute = 4 * 60 + 2 * 60 + 37
    with make_session() as s:
        sig = s.get_one(Signal, first.id)
        apply_candles(s, sig, _minutes(T0, sl_minute + 1, low_at=sl_minute), Timeframe.M1)
        s.commit()
        res = s.get_one(SignalResult, first.id)
        assert sig.status == "closed_sl"
        assert res.closed_at.astimezone(UTC) == T0 + M1 * (sl_minute + 1)

    # 3) закрытие T0+8ч: сделка закрылась внутри этой свечи H4 — кандидат не пишется
    assert scheduler.process_symbol(symbol, T0 + 2 * H4)["signals"] == 0
    # 4) закрытие T0+12ч: инструмент свободен — пишется
    assert scheduler.process_symbol(symbol, T0 + 3 * H4)["signals"] == 1

    with make_session() as s:
        assert _signal_times(s, ver.id, inst.id) == [T0, T0 + 3 * H4]


def test_forward_run_uses_the_same_rule(
    monkeypatch: pytest.MonkeyPatch,
    make_session: Callable[[], Session],
    code_version: str,
    caplog: pytest.LogCaptureFixture,
) -> None:
    with make_session() as s:
        ver, inst = _seed(s, code_version)
    monkeypatch.setattr(forward, "SessionLocal", make_session)
    monkeypatch.setattr(forward, "load_inputs", lambda *_: None)
    monkeypatch.setattr(forward, "evaluate", lambda _inp, at, _p: _candidate(at))
    caplog.set_level(logging.INFO, logger="forward")

    run = lambda at: forward.run_forward(  # noqa: E731
        [inst.symbol], refresh=False, now=at + timedelta(minutes=2), track=False
    )
    assert run(T0)["signals"] == 1
    assert run(T0 + H4)["signals"] == 0
    assert run(T0 + 2 * H4)["signals"] == 0
    assert sum("инструмент занят" in r.getMessage() for r in caplog.records) == 2
    with make_session() as s:
        assert _signal_times(s, ver.id, inst.id) == [T0]


# --- граничные случаи записи ---------------------------------------------------------------------


def _publish(s: Session, ver: StrategyVersion, inst: Instrument, at: datetime) -> Signal:
    assert forward.write_candidate(s, ver, inst, _candidate(at))
    s.commit()
    return s.scalars(
        select(Signal).where(
            Signal.strategy_version_id == ver.id,
            Signal.instrument_id == inst.id,
            Signal.candle_close_time == at,
        )
    ).one()


def _end(s: Session, sig: Signal, status: str, event: str, at: datetime) -> None:
    """Сигнал закончился без результата (истечение лимита, отмена): статус и событие."""
    sig.status = status
    s.add(SignalEvent(signal_id=sig.id, type=event, occurred_at=at, source="tracker"))
    s.commit()


def test_expired_and_cancelled_signals_block_their_end_candle(
    make_session: Callable[[], Session], code_version: str
) -> None:
    with make_session() as s:
        ver, inst = _seed(s, code_version)
        limit = _publish(s, ver, inst, T0)
        # ожидающий лимит занимает инструмент, истёкший — ещё и свечу истечения (T0 + 6 × H4)
        assert not forward.write_candidate(s, ver, inst, _candidate(T0 + 5 * H4))
        _end(s, limit, "expired", "expired", T0 + 6 * H4)
        spans = forward.trade_spans(s, ver.id, inst.id, T0 + 6 * H4)
        assert [(x.ref, x.status, x.ended_at) for x in spans] == [
            (limit.public_id, "expired", T0 + 6 * H4)
        ]
        assert not forward.write_candidate(s, ver, inst, _candidate(T0 + 6 * H4))
        assert forward.trade_spans(s, ver.id, inst.id, T0 + 7 * H4) == []
        cancelled = _publish(s, ver, inst, T0 + 7 * H4)

        # отмена админом в 01:13 внутри свечи 00:00–04:00 занимает закрытие 04:00
        _end(s, cancelled, "cancelled", "cancelled", T0 + 9 * H4 + timedelta(hours=1, minutes=13))
        assert not forward.write_candidate(s, ver, inst, _candidate(T0 + 10 * H4))
        _publish(s, ver, inst, T0 + 11 * H4)
        assert _signal_times(s, ver.id, inst.id) == [T0, T0 + 7 * H4, T0 + 11 * H4]


def test_rule_is_per_instrument_and_version_not_per_scope(
    make_session: Callable[[], Session], code_version: str
) -> None:
    with make_session() as s:
        ver, inst = _seed(s, code_version)
        other_inst = _instrument(s)
        other_ver = StrategyVersion(
            strategy_id=ver.strategy_id, version="9.0.1", params={"t": 1}, status="forward"
        )
        s.add(other_ver)
        s.commit()
        fwd = _publish(s, ver, inst, T0)
        assert fwd.scope == "forward"
        # другой инструмент той же версии и та же монета другой версии — свободны
        _publish(s, ver, other_inst, T0 + H4)
        _publish(s, other_ver, inst, T0 + H4)
        # версия ушла в live: её открытый форвард-сигнал по-прежнему занимает инструмент —
        # у версии один поток сделок, как в бэктесте (область сигнала здесь не важна)
        s.execute(
            text("update strategy_versions set status = 'live' where id = :id"), {"id": ver.id}
        )
        assert not forward.write_candidate(s, ver, inst, _candidate(T0 + 2 * H4))
        s.add(
            SignalResult(
                signal_id=fwd.id,
                realized_r=D(-1),
                duration_hours=D(9),
                max_favorable_r=D(0),
                max_adverse_r=D(-1),
                closed_at=T0 + 2 * H4 + timedelta(hours=1),
            )
        )
        fwd.status = "closed_sl"
        s.commit()
        assert not forward.write_candidate(s, ver, inst, _candidate(T0 + 3 * H4))
        live = _publish(s, ver, inst, T0 + 4 * H4)
        assert live.scope == "live"


def test_signals_the_backtest_does_not_trade_do_not_occupy(
    make_session: Callable[[], Session], code_version: str
) -> None:
    """Кандидат ниже C (хранится для анализа, план 2.7) и отложенный — не сделки бэктеста:
    записываются на свободном закрытии, но инструмент не занимают. Сделка занимает — и тогда
    не пишется даже кандидат ниже C (бэктест такие закрытия не оценивает вовсе)."""
    with make_session() as s:
        ver, inst = _seed(s, code_version)
        assert forward.write_candidate(s, ver, inst, _candidate(T0, publishable=False))
        assert forward.write_candidate(s, ver, inst, _candidate(T0 + H4, deferred=True))
        s.commit()
        assert forward.trade_spans(s, ver.id, inst.id, T0 + 2 * H4) == []
        trade = _publish(s, ver, inst, T0 + 2 * H4)
        assert not forward.write_candidate(s, ver, inst, _candidate(T0 + 3 * H4, publishable=False))
        spans = forward.trade_spans(s, ver.id, inst.id, T0 + 3 * H4)
        assert [x.ref for x in spans] == [trade.public_id]
        # строка без пометок publishable/deferred (старый формат) считается сделкой
        other = _instrument(s)
        old = Signal(
            public_id=secrets.token_hex(5),
            strategy_version_id=ver.id,
            instrument_id=other.id,
            direction="short",
            candle_close_time=T0,
            entry_market=D(100),
            stop_loss=D(103),
            tp1=D(97),
            tp2=D(93),
            tp3=D(88),
            rr_tp2=D(2),
            score=60,
            grade="B",
            score_breakdown={},
            rationale_facts={},
            status="active",
            scope="forward",
            input_hash="o" * 64,
        )
        s.add(old)
        s.flush()
        assert [x.ref for x in forward.trade_spans(s, ver.id, other.id, T0 + 3 * H4)] == [
            old.public_id
        ]


# --- сквозной прогон: scheduler + трекер H4 против run_backtest -----------------------------------


def _random_h4(rng: random.Random, n: int) -> list[Candle]:
    out: list[Candle] = []
    price = 100.0
    for i in range(n):
        o = price
        c = max(5.0, o * (1 + rng.uniform(-0.035, 0.035)))
        h = max(o, c) * (1 + rng.uniform(0, 0.02))
        lo = min(o, c) * (1 - rng.uniform(0, 0.02))
        out.append(
            Candle(T0 + H4 * i, D(f"{o:.4f}"), D(f"{h:.4f}"), D(f"{lo:.4f}"), D(f"{c:.4f}"), D(1))
        )
        price = c
    return out


@pytest.mark.parametrize("seed", [1, 2, 3])
def test_scheduler_with_tracker_reproduces_backtest_signals(
    monkeypatch: pytest.MonkeyPatch,
    make_session: Callable[[], Session],
    code_version: str,
    seed: int,
) -> None:
    """Одна и та же «стратегия» (кандидат на ~40 % закрытий H4) на одном ряду: бэктест и связка
    scheduler + трекер дают одинаковые сигналы, статусы и моменты выхода."""
    rng = random.Random(seed)
    h4 = _random_h4(rng, 140)
    closes = {c.close_time(Timeframe.H4): c.close for c in h4}
    picks = {at: rng.random() < 0.4 for at in closes}
    sides = {at: rng.random() < 0.5 for at in closes}
    below_c = {at: rng.random() < 0.3 for at in closes}

    def fake_evaluate(_inp: Any, at: datetime, _params: Any) -> SignalCandidate | NoSignal:
        if not picks[at]:
            return NoSignal("trigger", "нет слома")
        return _candidate(at, _setup(closes[at], up=sides[at]), publishable=not below_c[at])

    start, end = h4[0].close_time(Timeframe.H4), h4[-1].close_time(Timeframe.H4)
    monkeypatch.setattr(bt, "evaluate", fake_evaluate)
    run = run_backtest(
        [MarketInputs(symbol="X", h4=h4)], PARAMS, start, end, DEFAULT_EXECUTION, window=5
    )
    expected = [
        (t.signal_time, forward.STATUS_BY_RESULT.get(t.result.status, "open"), t.exit_time)
        for t in run.trades
    ]
    assert run.skipped["busy"] > 0 and len(expected) >= 5

    with make_session() as s:
        ver, inst = _seed(s, code_version)
        versions = {code_version: ver}
    monkeypatch.setattr(scheduler, "SessionLocal", make_session)
    monkeypatch.setattr(scheduler, "load_inputs", lambda *_: None)
    monkeypatch.setattr(scheduler, "evaluate", fake_evaluate)
    for c in h4:
        at = c.close_time(Timeframe.H4)
        with make_session() as s:
            forward.upsert_candles(s, inst.id, Timeframe.H4, [c])
            s.commit()
            forward.track_open_signals(s, versions)  # трекер видит свечу, закрывшуюся в at
        scheduler.process_symbol(inst.symbol, at)

    with make_session() as s:
        rows = s.execute(
            select(
                Signal.candle_close_time,
                Signal.status,
                SignalResult.closed_at,
                Signal.rationale_facts["publishable"].as_boolean(),
            )
            .outerjoin(SignalResult, SignalResult.signal_id == Signal.id)
            .where(Signal.instrument_id == inst.id)
            .order_by(Signal.candle_close_time)
        ).all()
    got = [
        (
            t.astimezone(UTC),
            st if st.startswith("closed") or st == "expired" else "open",
            None if closed is None else closed.astimezone(UTC),
        )
        for t, st, closed, publishable in rows
        if publishable
    ]
    assert got == expected
    # кандидаты ниже C записаны для анализа (план 2.7), но сделками не стали и никого не заняли
    assert any(not publishable for *_, publishable in rows)
