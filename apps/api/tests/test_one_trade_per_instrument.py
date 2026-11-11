"""Одна открытая сделка на инструмент и версию в scheduler и forward — как в бэктесте (задача 6).

Все тесты — на реальной БД (нужен DATABASE_URL с миграциями до head; без неё пропускаются).
Каждый тест идёт во внешней транзакции, которая в конце откатывается: ``commit`` в коде
закрывает только точку сохранения.

- критерий приёмки: при открытом сигнале второй кандидат не пишется; на закрытии H4, внутри
  которой сделка закрылась (1m-трекер), — тоже; на следующем закрытии — пишется;
- forward (``run_forward``) идёт через ту же запись кандидата;
- граничные случаи записи: истёкший лимит, отмена, другая версия и другой инструмент, форвард-
  сигнал версии, ставшей live;
- кандидаты, которых бэктест не торгует (ниже C, отложенные), не пишутся вовсе, а старые строки
  ниже C, записанные с градацией C, занимают инструмент, пока открыты: двух открытых сигналов
  версии по монете не бывает;
- сквозной прогон: scheduler + трекер по H4 на случайном ряду дают те же сигналы, статусы и
  моменты выхода, что ``run_backtest`` на тех же свечах, и ни одной лишней строки.
"""

from __future__ import annotations

import logging
import random
import secrets
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from itertools import pairwise
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import Connection, select, text
from sqlalchemy.exc import DBAPIError, OperationalError
from sqlalchemy.orm import Session

import app.forward as forward
import app.workers.scheduler as scheduler
import engine.backtest as bt
from app.corrections import CORRECTION_SOURCE, RETRACK_JOB
from app.db import engine
from app.models import (
    Instrument,
    Signal,
    SignalCorrection,
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
    """Настоящий ``SignalCandidate`` с полями, которые читают scheduler, forward и бэктест.
    ``publishable=False`` — кандидат ниже C (score 30, градация «-», как ``Grade.NONE``)."""
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
            total=75 if publishable else 30,
            grade=SimpleNamespace(value="B" if publishable else "-"),
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


def _open_signals(s: Session, version_id: int, instrument_id: int) -> list[tuple[datetime, str]]:
    rows = s.execute(
        select(Signal.candle_close_time, Signal.status)
        .where(
            Signal.strategy_version_id == version_id,
            Signal.instrument_id == instrument_id,
            Signal.status.in_(("pending", "active", "tp1_hit", "tp2_hit")),
        )
        .order_by(Signal.candle_close_time)
    ).all()
    return [(t.astimezone(UTC), st) for t, st in rows]


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


def _correct(
    s: Session,
    sig: Signal,
    kind: str,
    status: str,
    superseded: list[int],
    at: datetime,
    events: tuple[tuple[str, datetime], ...] = (),
) -> None:
    """Исправление исхода, как его записывает пересчёт форварда (``app.retrack``, миграция 0026):
    новые события и событие-пояснение — ``source = 'retrack'``, заменённые перечислены в
    ``signal_corrections``, исходные строки не меняются."""
    for type_, when in events:
        s.add(SignalEvent(signal_id=sig.id, type=type_, occurred_at=when, source=CORRECTION_SOURCE))
    note = SignalEvent(
        signal_id=sig.id,
        type="voided" if kind == "void" else "corrected",
        occurred_at=at,
        source=CORRECTION_SOURCE,
        note="тест",
    )
    s.add(note)
    s.flush()
    s.add(
        SignalCorrection(
            signal_id=sig.id,
            job=RETRACK_JOB,
            kind=kind,
            status_before=sig.status,
            status_after=status,
            superseded_event_ids=superseded,
            note_event_id=note.id,
            note="тест",
        )
    )
    sig.status = status
    s.commit()


def _event_id(s: Session, sig: Signal, type_: str) -> int:
    return s.scalars(
        select(SignalEvent.id).where(SignalEvent.signal_id == sig.id, SignalEvent.type == type_)
    ).one()


def test_corrected_and_voided_signals_occupy_by_the_current_record(
    make_session: Callable[[], Session], code_version: str
) -> None:
    """Пересчёт форварда (задачи 7 и 10, миграция 0026): конец сделки берётся из действующей
    записи — события, заменённые исправлением, не в счёт; сигнал с недействительным результатом
    (``voided``) инструмент не занимает."""
    with make_session() as s:
        ver, inst = _seed(s, code_version)
        # записано «истёк» в 12:30 (занимало бы закрытие 16:00); пересчёт: истёк в 09:10
        first = _publish(s, ver, inst, T0)
        _end(s, first, "expired", "expired", T0 + H4 + timedelta(minutes=30))
        assert [x.ref for x in forward.trade_spans(s, ver.id, inst.id, T0 + 2 * H4)] == [
            first.public_id
        ]
        new_end = T0 + timedelta(hours=1, minutes=10)
        old = [_event_id(s, first, "expired")]
        _correct(s, first, "retrack", "expired", old, T0 + 3 * H4, (("expired", new_end),))
        spans = forward.trade_spans(s, ver.id, inst.id, T0 + H4)
        assert [(x.ref, x.ended_at) for x in spans] == [(first.public_id, new_end)]
        assert forward.trade_spans(s, ver.id, inst.id, T0 + 2 * H4) == []

        # «истёк» в 20:30 признан недействительным (событие заменено) — закрытие 00:00 свободно
        second = _publish(s, ver, inst, T0 + 2 * H4)
        assert not forward.write_candidate(s, ver, inst, _candidate(T0 + 3 * H4))
        _end(s, second, "expired", "expired", T0 + 3 * H4 + timedelta(minutes=30))
        old = [_event_id(s, second, "expired")]
        _correct(s, second, "void", "voided", old, T0 + 4 * H4)
        assert forward.trade_spans(s, ver.id, inst.id, T0 + 4 * H4) == []

        # недействительный результат не занимает, даже если событие конца не заменено
        third = _publish(s, ver, inst, T0 + 4 * H4)
        _end(s, third, "cancelled", "cancelled", T0 + 5 * H4 + timedelta(minutes=30))
        _correct(s, third, "void", "voided", [], T0 + 6 * H4)
        assert forward.trade_spans(s, ver.id, inst.id, T0 + 6 * H4) == []
        _publish(s, ver, inst, T0 + 6 * H4)
        assert _signal_times(s, ver.id, inst.id) == [T0, T0 + 2 * H4, T0 + 4 * H4, T0 + 6 * H4]


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


@pytest.mark.parametrize("kind", ["below_c", "deferred"])
def test_candidates_the_backtest_does_not_trade_are_not_written(
    make_session: Callable[[], Session],
    code_version: str,
    caplog: pytest.LogCaptureFixture,
    kind: str,
) -> None:
    """Кандидат ниже C и отложенный бэктест не торгует (``skipped``): forward и live их не пишут
    (план 2.7: «не публикуются»), только строка INFO. Инструмент остаётся свободным, и следующий
    публикуемый кандидат пишется; на занятом закрытии такой кандидат тоже не пишется."""
    caplog.set_level(logging.INFO, logger="forward")
    untradable = {"publishable": False} if kind == "below_c" else {"deferred": True}
    with make_session() as s:
        ver, inst = _seed(s, code_version)
        assert not forward.write_candidate(s, ver, inst, _candidate(T0, **untradable))
        s.commit()
        assert _signal_times(s, ver.id, inst.id) == []
        notes = [r for r in caplog.records if "бэктест такие не торгует" in r.getMessage()]
        assert len(notes) == 1 and notes[0].levelno == logging.INFO
        msg = notes[0].getMessage()
        reason = "ниже C" if kind == "below_c" else "отложен"
        assert inst.symbol in msg and ver.version in msg and reason in msg and "h" * 64 in msg
        trade = _publish(s, ver, inst, T0 + H4)
        assert not forward.write_candidate(s, ver, inst, _candidate(T0 + 2 * H4, **untradable))
        assert _signal_times(s, ver.id, inst.id) == [T0 + H4]
        assert _open_signals(s, ver.id, inst.id) == [(T0 + H4, "pending")]
        assert trade.grade == "B" and trade.rationale_facts["publishable"] is True


def _legacy_row(
    ver: StrategyVersion, inst: Instrument, at: datetime, facts: dict[str, Any]
) -> Signal:
    """Строка в формате до правила: кандидат ниже C записан с градацией C и пометкой."""
    return Signal(
        public_id=secrets.token_hex(5),
        strategy_version_id=ver.id,
        instrument_id=inst.id,
        direction="short",
        candle_close_time=at,
        entry_market=D(100),
        stop_loss=D(103),
        tp1=D(97),
        tp2=D(93),
        tp3=D(88),
        rr_tp2=D(2),
        score=38,
        grade="C",
        score_breakdown={},
        rationale_facts=facts,
        status="active",
        scope="forward",
        input_hash="o" * 64,
    )


@pytest.mark.parametrize(
    "facts",
    [{"publishable": False, "deferred": False}, {"publishable": True, "deferred": True}, {}],
    ids=["below_c", "deferred", "no_marks"],
)
def test_legacy_rows_occupy_while_open(
    make_session: Callable[[], Session], code_version: str, facts: dict[str, Any]
) -> None:
    """Строки, записанные до правила (ниже C с градацией C, отложенные, без пометок), трекеры
    ведут как сделки, а статистика считает: пока такая строка открыта, второй сигнал версии по
    монете не пишется."""
    with make_session() as s:
        ver, inst = _seed(s, code_version)
        old = _legacy_row(ver, inst, T0, facts)
        s.add(old)
        s.commit()
        assert [x.ref for x in forward.trade_spans(s, ver.id, inst.id, T0 + H4)] == [old.public_id]
        assert not forward.write_candidate(s, ver, inst, _candidate(T0 + H4))
        _end(s, old, "closed_time", "time_stop", T0 + 2 * H4)
        s.add(
            SignalResult(
                signal_id=old.id,
                realized_r=D(0),
                duration_hours=D(8),
                max_favorable_r=D(0),
                max_adverse_r=D(0),
                closed_at=T0 + 2 * H4,
            )
        )
        s.commit()
        assert not forward.write_candidate(s, ver, inst, _candidate(T0 + 2 * H4))  # свеча выхода
        _publish(s, ver, inst, T0 + 3 * H4)
        assert _open_signals(s, ver.id, inst.id) == [(T0 + 3 * H4, "pending")]


@pytest.mark.parametrize("kind", ["below_c", "deferred"])
def test_scheduler_and_1m_tracker_never_hold_two_open_signals(
    monkeypatch: pytest.MonkeyPatch,
    make_session: Callable[[], Session],
    code_version: str,
    kind: str,
) -> None:
    """Регрессия ревью: кандидат ниже C (или отложенный) на свободном закрытии 08:00 раньше
    записывался с градацией C, 1m-трекер делал его active, а на 12:00 рядом писался сигнал B —
    два открытых сигнала версии по монете. Теперь он не пишется, B на 12:00 — единственный, а
    пока B открыт, не пишутся ни кандидат ниже C на 16:00, ни публикуемый на 20:00."""
    with make_session() as s:
        ver, inst = _seed(s, code_version)
    untradable = {"publishable": False} if kind == "below_c" else {"deferred": True}
    plan = {
        T0: _candidate(T0, **untradable),
        T0 + H4: _candidate(T0 + H4),
        T0 + 2 * H4: _candidate(T0 + 2 * H4, **untradable),
        T0 + 3 * H4: _candidate(T0 + 3 * H4),
    }
    monkeypatch.setattr(scheduler, "SessionLocal", make_session)
    monkeypatch.setattr(scheduler, "load_inputs", lambda *_: None)
    monkeypatch.setattr(scheduler, "evaluate", lambda _inp, at, _p: plan[at])

    assert scheduler.process_symbol(inst.symbol, T0)["signals"] == 0
    assert scheduler.process_symbol(inst.symbol, T0 + H4)["signals"] == 1
    with make_session() as s:
        sig = s.scalars(select(Signal).where(Signal.instrument_id == inst.id)).one()
        assert sig.grade == "B"
        apply_candles(s, sig, _minutes(T0 + H4, 4 * 60), Timeframe.M1)  # 1m-трекер: вход
        s.commit()
        assert _open_signals(s, ver.id, inst.id) == [(T0 + H4, "active")]
    assert scheduler.process_symbol(inst.symbol, T0 + 2 * H4)["signals"] == 0
    assert scheduler.process_symbol(inst.symbol, T0 + 3 * H4)["signals"] == 0
    with make_session() as s:
        assert _signal_times(s, ver.id, inst.id) == [T0 + H4]
        assert _open_signals(s, ver.id, inst.id) == [(T0 + H4, "active")]


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
    """Одна и та же «стратегия» (кандидат на ~40 % закрытий H4, часть — ниже C или отложены) на
    одном ряду: бэктест и связка scheduler + трекер дают одинаковые сигналы, статусы и моменты
    выхода. Кандидатов, которых бэктест не торгует, в ``signals`` нет, и в любой момент открыт
    не больше чем один сигнал."""
    rng = random.Random(seed)
    h4 = _random_h4(rng, 140)
    closes = {c.close_time(Timeframe.H4): c.close for c in h4}
    picks = {at: rng.random() < 0.4 for at in closes}
    sides = {at: rng.random() < 0.5 for at in closes}
    below_c = {at: rng.random() < 0.3 for at in closes}
    deferred = {at: rng.random() < 0.1 for at in closes}

    def fake_evaluate(_inp: Any, at: datetime, _params: Any) -> SignalCandidate | NoSignal:
        if not picks[at]:
            return NoSignal("trigger", "нет слома")
        setup = _setup(closes[at], up=sides[at])
        return _candidate(at, setup, publishable=not below_c[at], deferred=deferred[at])

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
    # бэктест встречал и непубликуемых кандидатов на свободных закрытиях — их и проверяем ниже
    assert run.skipped["grade_none"] > 0 and run.skipped["deferred"] > 0

    with make_session() as s:
        ver, inst = _seed(s, code_version)
        versions = {code_version: ver}
    monkeypatch.setattr(scheduler, "SessionLocal", make_session)
    monkeypatch.setattr(scheduler, "load_inputs", lambda *_: None)
    monkeypatch.setattr(scheduler, "evaluate", fake_evaluate)
    most_open = 0
    for c in h4:
        at = c.close_time(Timeframe.H4)
        with make_session() as s:
            forward.upsert_candles(s, inst.id, Timeframe.H4, [c])
            s.commit()
            forward.track_open_signals(s, versions)  # трекер видит свечу, закрывшуюся в at
        scheduler.process_symbol(inst.symbol, at)
        with make_session() as s:
            most_open = max(most_open, len(_open_signals(s, ver.id, inst.id)))

    with make_session() as s:
        rows = s.execute(
            select(
                Signal.candle_close_time,
                Signal.status,
                SignalResult.closed_at,
                Signal.grade,
                Signal.rationale_facts,
            )
            .outerjoin(SignalResult, SignalResult.signal_id == Signal.id)
            .where(Signal.instrument_id == inst.id)
            .order_by(Signal.candle_close_time)
        ).all()
    # все строки, без фильтра: кандидаты ниже C и отложенные не записаны вовсе
    got = [
        (
            t.astimezone(UTC),
            st if st.startswith("closed") or st == "expired" else "open",
            None if closed is None else closed.astimezone(UTC),
        )
        for t, st, closed, _grade, _facts in rows
    ]
    assert got == expected
    assert all(g == "B" and f["publishable"] and not f["deferred"] for *_, g, f in rows)
    assert most_open == 1
    # сделки не пересекаются: следующий сигнал — после свечи, в которой закрылась прежняя
    for (_, _, prev_closed), (nxt, _, _) in pairwise(got):
        assert prev_closed is not None and nxt >= prev_closed + H4
