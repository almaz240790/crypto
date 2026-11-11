"""Пересчёт форвард-сигналов, записанных с ошибкой учёта (задание «сигналы», задачи 7 и 10).

Без БД — проверка исхода по срокам, пересчёт по 1m-свечам и оценка пропусков. На реальной БД —
задание целиком на синтетических сигналах: ошибка 15 минут (time stop, стоп, TP1 и дальше
открыта), пропуски 1m-свечей (опасный и безопасный), верный исход без комиссий, верный исход с
комиссией, live-сигнал и сигнал до 26.10; отчёт до применения, исходные события не меняются,
повтор и перезапуск после сбоя ничего не дублируют, плашка снимается, статистика без
недействительных, трекер продолжает пересчитанную открытую сделку. Всё — во внешней транзакции,
которая в конце откатывается (строки ``signals`` удалить нельзя — триггер).
"""

from __future__ import annotations

import asyncio
import importlib.util
import logging
import secrets
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import insert, select, text
from sqlalchemy.exc import DBAPIError, OperationalError
from sqlalchemy.orm import Session, sessionmaker

import app.retrack as retrack
import app.workers.tracker as worker
from app import auth
from app.corrections import RETRACK_JOB, current_event, forward_notice_shown
from app.db import engine
from app.forward import _setup_from_row
from app.models import (
    DeployJob,
    Instrument,
    Signal,
    SignalCorrection,
    SignalEvent,
    SignalResult,
    SignalTracking,
    StatsSnapshot,
    Strategy,
    StrategyVersion,
    User,
)
from app.models.market import Candle as CandleRow
from app.routers import public
from app.stats import load_trades
from app.workers.tracker import state_from_json, state_to_json
from engine.backtest import DEFAULT_EXECUTION, execution_cost_r
from engine.candles import Candle, Timeframe
from engine.params import TradeParams
from engine.structure import Direction
from engine.tracker import EventType, SignalStatus, TrackerEvent, TrackerState
from engine.trade import TradeSetup

D = Decimal
M1 = Timeframe.M1.delta
H4 = Timeframe.H4.delta
T = datetime(2026, 10, 27, 8, tzinfo=UTC)
"""Закрытие сигнальной свечи синтетических сигналов (после 26.10)."""
NOW = datetime(2026, 11, 10, 12, tzinfo=UTC)
LONG = TradeSetup(
    Direction.UP, D(100), D(100), D(97), D(103), D(107), D(112), D(3), D(7) / D(3), ()
)
SHORT = TradeSetup(
    Direction.DOWN, D(100), D(100), D(103), D(97), D(93), D(88), D(3), D(7) / D(3), ()
)
COST = execution_cost_r(D(100), D(3), DEFAULT_EXECUTION)
P = TradeParams()
DEADLINE = T + 15 * H4


ENTRY = D(100)


def _calm(start: datetime, n: int, level: Decimal = ENTRY, first: int = 0) -> list[Candle]:
    """Минуты у ``level`` ± 0.5: ни цели, ни стопа для входа 100 / стопа 97 / TP1 103."""
    return [
        Candle(
            start + M1 * i,
            level,
            level + D("0.5"),
            level - D("0.5"),
            level + D("0.1") * ((first + i) % 3 - 1),
            D(1),
        )
        for i in range(n)
    ]


def _h4(t: datetime, low: Decimal, high: Decimal) -> Candle:
    return Candle(t, D(100), high, low, D(100), D(1))


# --- без БД: проверка исхода по срокам ---------------------------------------------------------


def test_deadline_problem_flags_the_15_minute_time_stop() -> None:
    early = retrack.deadline_problem(
        T, "closed_time", [("activated", T + M1), ("time_stop", T + 15 * M1)], P
    )
    assert early is not None
    assert "через 15 мин после сигнала" in early and "29.10.2026 20:00 UTC" in early
    assert "15 свечей H4" in early
    on_time = [("activated", T + M1), ("time_stop", DEADLINE)]
    assert retrack.deadline_problem(T, "closed_time", on_time, P) is None
    late = [("activated", T + M1), ("time_stop", DEADLINE + 3 * M1)]  # пропуск минут на сроке
    assert retrack.deadline_problem(T, "closed_time", late, P) is None
    assert retrack.deadline_problem(T, "closed_time", [("activated", T + M1)], P) is not None


def test_deadline_problem_expired_market_entry_and_other_outcomes() -> None:
    msg = retrack.deadline_problem(T, "expired", [("expired", T + 6 * M1)], P)
    assert msg is not None and "по рынку не истекает" in msg
    stop = [("activated", T + M1), ("sl", T + 11 * M1)]  # стоп в первые минуты — верный исход
    assert retrack.deadline_problem(T, "closed_sl", stop, P) is None
    assert retrack.deadline_problem(T, "closed_tp3", [("tp3", T + 2 * M1)], P) is None


# --- без БД: пересчёт по 1m и пропуски ---------------------------------------------------------


def test_replay_closes_by_time_after_60h_with_note() -> None:
    minutes = _calm(T, 61 * 60)
    rp = retrack.replay(LONG, P, T, minutes, {})
    assert rp.tracker.state.status is SignalStatus.CLOSED_TIME
    assert [e.type for e, _ in rp.events] == [EventType.ACTIVATED, EventType.TIME_STOP]
    stop, note = rp.events[-1]
    assert stop.at == DEADLINE and stop.price == minutes[60 * 60 - 1].close
    assert note is not None and note.startswith("time stop: срок 2026-10-29 20:00 UTC")
    assert rp.last_candle == DEADLINE - M1 and rp.gaps == ()
    res = rp.tracker.result(DEFAULT_EXECUTION)
    assert res.cost_r == COST and res.realized_r == (stop.price - 100) / 3 - COST


def test_replay_ignores_candles_before_signal_and_stops_on_close() -> None:
    before = _calm(T - 10 * M1, 10)
    stop_at = _calm(T, 20)
    stop_at[5] = Candle(T + 5 * M1, D(100), D("100.5"), D(96), D(97), D(1))
    rp = retrack.replay(LONG, P, T, [*before, *stop_at], {})
    assert rp.tracker.state.status is SignalStatus.CLOSED_SL
    assert rp.last_candle == T + 5 * M1  # дальше свечи не подаются


def test_gap_risk_by_h4_bar_over_the_gap() -> None:
    start, end = T + 600 * M1, T + 620 * M1  # 18:00–18:20, свеча H4 16:00
    bar = T + 2 * H4
    far = {bar: _h4(bar, D("99.5"), D("100.5"))}
    assert retrack.gap_risk(LONG, D(97), D(103), DEADLINE, start, end, far) is None
    touch_stop = {bar: _h4(bar, D("96.9"), D("100.5"))}
    risk = retrack.gap_risk(LONG, D(97), D(103), DEADLINE, start, end, touch_stop)
    assert risk is not None and "до стопа" in risk
    touch_tp = {bar: _h4(bar, D("99.5"), D(103))}
    risk = retrack.gap_risk(LONG, D(97), D(103), DEADLINE, start, end, touch_tp)
    assert risk is not None and "до цели" in risk
    risk = retrack.gap_risk(LONG, D(97), D(103), DEADLINE, start, end, {})
    assert risk is not None and "нет свечи H4" in risk
    # целей больше нет: проверяется только стоп
    assert retrack.gap_risk(LONG, D(99), None, None, start, end, touch_tp) is None
    # шорт: стоп сверху, цель снизу
    risk = retrack.gap_risk(SHORT, D(103), D(97), DEADLINE, start, end, touch_stop)
    assert risk is not None and "до цели" in risk
    # срок time stop внутри пропуска: цену выхода по 1m не восстановить
    risk = retrack.gap_risk(LONG, D(97), D(103), DEADLINE, DEADLINE - 5 * M1, DEADLINE, far)
    assert risk is not None and "срок time stop" in risk


def test_gap_spanning_two_h4_bars_needs_both() -> None:
    start, end = T + H4 - 10 * M1, T + H4 + 10 * M1
    first = {T: _h4(T, D("99.5"), D("100.5"))}
    assert "нет свечи H4" in str(retrack.gap_risk(LONG, D(97), D(103), DEADLINE, start, end, first))
    both = {**first, T + H4: _h4(T + H4, D("99.5"), D("100.5"))}
    assert retrack.gap_risk(LONG, D(97), D(103), DEADLINE, start, end, both) is None


def test_replay_with_safe_gap_gives_same_outcome_and_risky_gap_is_reported() -> None:
    full = _calm(T, 61 * 60)
    gapped = [c for c in full if not (600 <= (c.open_time - T) // M1 < 620)]
    bar = T + 2 * H4
    safe = retrack.replay(LONG, P, T, gapped, {bar: _h4(bar, D("99.5"), D("100.5"))})
    ref = retrack.replay(LONG, P, T, full, {})
    assert [g.minutes for g in safe.gaps] == [20] and safe.risky == ()
    assert safe.tracker.state.status is ref.tracker.state.status is SignalStatus.CLOSED_TIME
    assert safe.tracker.state.realized_r == ref.tracker.state.realized_r
    risky = retrack.replay(LONG, P, T, gapped, {bar: _h4(bar, D("96.5"), D("100.5"))})
    assert len(risky.risky) == 1 and "до стопа" in str(risky.risky[0].risk)
    # пропуск сразу после сигнальной свечи: уровни — исходные стоп и TP1
    late_start = retrack.replay(LONG, P, T, full[30:], {T: _h4(T, D(97), D("100.5"))})
    assert late_start.gaps[0].start == T and late_start.gaps[0].minutes == 30
    assert late_start.risky and "до стопа" in str(late_start.risky[0].risk)


# --- на БД -------------------------------------------------------------------------------------


def _db_available() -> bool:
    try:
        with engine.connect() as conn:
            conn.execute(text("select 1 from signal_corrections limit 0"))
        return True
    except (OperationalError, DBAPIError):
        return False


db_only = pytest.mark.skipif(not _db_available(), reason="БД с миграцией 0026 недоступна")


@pytest.fixture
def factory() -> Iterator[sessionmaker[Session]]:
    """Сессии во внешней транзакции: commit в коде — savepoint, в конце всё откатывается."""
    conn = engine.connect()
    outer = conn.begin()
    try:
        yield sessionmaker(
            bind=conn, expire_on_commit=False, join_transaction_mode="create_savepoint"
        )
    finally:
        outer.rollback()
        conn.close()


class World:
    """Версия 1.0.0 (параметры trend-ob-retest@1.0.0), инструменты и сигналы сценариев."""

    def __init__(self, db: Session) -> None:
        self.db = db
        self.tag = secrets.token_hex(3)
        strat = Strategy(slug=f"retrack-{self.tag}", name="retrack test")
        db.add(strat)
        db.flush()
        self.ver = StrategyVersion(
            strategy_id=strat.id, version="1.0.0", params={"t": self.tag}, status="archived"
        )
        db.add(self.ver)
        db.flush()
        self.signals: dict[str, Signal] = {}

    def signal(
        self,
        name: str,
        *,
        close: datetime = T,
        scope: str = "forward",
        status: str = "closed_time",
        events: tuple[tuple[str, datetime, Decimal], ...] = (),
        result: Decimal | None = None,
        cost: Decimal | None = None,
        closed_at: datetime | None = None,
        state: dict[str, Any] | None = None,
    ) -> Signal:
        db = self.db
        inst = Instrument(
            exchange="binance",
            symbol=f"{name}{self.tag}".upper()[:20],
            base=name.upper()[:8],
            quote="USDT",
            market_type="futures",
            tick_size=D("0.01"),
            lot_size=D("0.001"),
        )
        db.add(inst)
        db.flush()
        sig = Signal(
            public_id=f"{name[:6]}{self.tag}",
            strategy_version_id=self.ver.id,
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
            scope=scope,
            input_hash="x" * 64,
            status=status,
        )
        db.add(sig)
        db.flush()
        db.add(SignalEvent(signal_id=sig.id, type="created", occurred_at=close, source="engine"))
        for typ, at, price in events:
            db.add(SignalEvent(signal_id=sig.id, type=typ, price=price, occurred_at=at))
        if result is not None:
            end = closed_at or close + 15 * M1
            db.add(
                SignalResult(
                    signal_id=sig.id,
                    realized_r=result,
                    realized_r_tp1_only=result,
                    realized_r_full_tp2=result,
                    cost_r=cost,
                    duration_hours=D((end - close).total_seconds()) / 3600,
                    max_favorable_r=D("0.167"),
                    max_adverse_r=D("-0.167"),
                    closed_at=end,
                )
            )
        if state is not None:
            db.add(
                SignalTracking(
                    signal_id=sig.id,
                    state=state,
                    timeframe="1m",
                    last_candle_time=(closed_at or close + 15 * M1) - M1,
                )
            )
        db.flush()
        self.signals[name] = sig
        return sig

    def minutes(self, name: str, candles: list[Candle]) -> None:
        self._candles(name, "1m", candles)

    def h4(self, name: str, candles: list[Candle]) -> None:
        self._candles(name, "4h", candles)

    def _candles(self, name: str, tf: str, candles: list[Candle]) -> None:
        inst = self.signals[name].instrument_id
        self.db.execute(
            insert(CandleRow),
            [
                {
                    "instrument_id": inst,
                    "timeframe": tf,
                    "open_time": c.open_time,
                    "open": c.open,
                    "high": c.high,
                    "low": c.low,
                    "close": c.close,
                    "volume": c.volume,
                    "is_closed": True,
                }
                for c in candles
            ],
        )


def _bug_state(realized: Decimal, status: str = "closed_time") -> dict[str, Any]:
    """Состояние трекера до исправления: закрыт через 15 минут (результат до вычета)."""
    exit_type = EventType.TIME_STOP if status == "closed_time" else EventType.SL
    return state_to_json(
        TrackerState(
            status=SignalStatus(status),
            entry_price=D(100),
            stop=D(97),
            realized_r=realized,
            remaining=D(0),
            candles_seen=15,
            candles_active=15,
            r_if_tp1_only=realized,
            r_if_full_tp2=realized,
            events=(
                TrackerEvent(EventType.ACTIVATED, D(100), 0),
                TrackerEvent(exit_type, D(100) + realized * 3, 14),
            ),
        )
    )


BUG_EVENTS = (("activated", T + M1, D(100)), ("time_stop", T + 15 * M1, D("100.1")))
BUG_R = D("0.033")


def _build(db: Session) -> World:
    w = World(db)
    bug: dict[str, Any] = {
        "events": BUG_EVENTS,
        "result": BUG_R,
        "state": _bug_state(D("0.1") / 3),
    }
    # A: ошибка 15 минут, свечи полные — time stop через 60 ч
    w.signal("timestop", **bug)
    w.minutes("timestop", _calm(T, 61 * 60))
    # B: ошибка 15 минут, по 1m — стоп через 5 ч
    w.signal("tostop", **bug)
    path = _calm(T, 400)
    path[300] = Candle(T + 300 * M1, D(100), D("100.5"), D(96), D(97), D(1))
    w.minutes("tostop", path)
    # C: ошибка 15 минут, по 1m — TP1 через 2 ч, дальше сделка открыта (стоп в безубытке)
    w.signal("opentp1", **bug)
    tp1 = [Candle(T + 120 * M1, D(101), D("103.5"), D("100.5"), D(103), D(1))]
    w.minutes("opentp1", [*_calm(T, 120), *tp1, *_calm(T + 121 * M1, 70 * 60, D(101))])
    # D: ошибка 15 минут, пропуск 18:00–18:20, свеча H4 16:00 доходит до стопа — недействителен
    gapped = [c for c in _calm(T, 61 * 60) if not (600 <= (c.open_time - T) // M1 < 620)]
    w.signal("riskgap", **bug)
    w.minutes("riskgap", gapped)
    w.h4("riskgap", [_h4(T + 2 * H4, D("96.5"), D("100.5"))])
    # E: тот же пропуск, свеча H4 далеко от уровней — пересчитан
    w.signal("safegap", **bug)
    w.minutes("safegap", gapped)
    w.h4("safegap", [_h4(T + 2 * H4, D("99.5"), D("100.5"))])
    # F: верный стоп в первые минуты, записан без комиссий — только комиссия
    w.signal(
        "fees",
        status="closed_sl",
        events=(("activated", T + M1, D(100)), ("sl", T + 11 * M1, D(97))),
        result=D(-1),
        closed_at=T + 11 * M1,
        state=_bug_state(D(-1), "closed_sl"),
    )
    # G: верный time stop с комиссией (после задач 1 и 3) — без изменений
    w.signal(
        "ok",
        events=(("activated", T + M1, D(100)), ("time_stop", DEADLINE, D("100.1"))),
        result=D("0.033") - COST.quantize(D("0.001")),
        cost=COST.quantize(D("0.001")),
        closed_at=DEADLINE,
    )
    # H: live-сигнал с той же ошибкой — не трогается; I: сигнал до 26.10 — не трогается
    w.signal("live", scope="live", **bug)
    w.minutes("live", _calm(T, 61 * 60))
    early = T - 10 * 24 * 3600 * timedelta(seconds=1)
    w.signal(
        "early",
        close=early,
        events=(("activated", early + M1, D(100)), ("time_stop", early + 15 * M1, D("100.1"))),
        result=BUG_R,
        closed_at=early + 15 * M1,
    )
    # J: ошибка 15 минут, 1m-свечей нет вовсе — недействителен
    w.signal("nocandle", **bug)
    db.commit()
    return w


def _events(db: Session, sig: Signal) -> list[tuple[Any, ...]]:
    return [
        (e.id, e.type, e.price, e.occurred_at, e.source, e.note)
        for e in db.scalars(
            select(SignalEvent).where(SignalEvent.signal_id == sig.id).order_by(SignalEvent.id)
        ).all()
    ]


def _client(db: Session, user: User) -> TestClient:
    app = FastAPI()
    app.include_router(public.router)
    app.dependency_overrides[auth.get_db] = lambda: db
    app.dependency_overrides[public.optional_user] = lambda: user
    return TestClient(app)


@db_only
def test_retrack_job_end_to_end(
    factory: sessionmaker[Session],
    caplog: pytest.LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = factory()
    w = _build(db)
    s = w.signals
    original = {name: _events(db, sig) for name, sig in s.items()}
    assert forward_notice_shown(db) or not public.settings.forward_notice

    with caplog.at_level(logging.INFO, logger="retrack"):
        summary = retrack.run(factory, now=NOW)
    assert summary is not None and summary["failed"] == []
    db.expire_all()

    # отчёт до применения: строка по каждому кандидату, раньше первой строки «применено»
    msgs = [r.getMessage() for r in caplog.records]
    first_applied = next(i for i, m in enumerate(msgs) if m.startswith("применено"))
    dry = next(i for i, m in enumerate(msgs) if "dry-run" in m)
    assert dry < first_applied
    for name in ("timestop", "tostop", "opentp1", "riskgap", "safegap", "fees", "ok", "nocandle"):
        line = next(m for m in msgs[dry:first_applied] if s[name].public_id in m)
        assert "было —" in line
    for name in ("live", "early"):
        assert not any(s[name].public_id in m for m in msgs)
    report = {r["id"]: r for r in summary["report"]}
    assert report[s["timestop"].public_id]["kind"] == "retrack"
    assert report[s["riskgap"].public_id]["kind"] == "void"
    assert report[s["safegap"].public_id]["gaps"][0]["risk"] is None

    # исходные события не изменены и не удалены
    for name, rows in original.items():
        now_rows = _events(db, s[name])
        assert now_rows[: len(rows)] == rows, name

    def res(name: str) -> SignalResult | None:
        return db.get(SignalResult, s[name].id)

    def corr(name: str) -> SignalCorrection | None:
        return db.scalar(select(SignalCorrection).where(SignalCorrection.signal_id == s[name].id))

    q3 = D("0.001")
    # A: time stop через 60 ч, с комиссией
    a = res("timestop")
    exit_price = _calm(T, 61 * 60)[60 * 60 - 1].close
    assert s["timestop"].status == "closed_time" and a is not None
    assert a.closed_at == DEADLINE and a.duration_hours == D("60.00")
    assert a.cost_r == COST.quantize(q3)
    assert a.realized_r == ((exit_price - 100) / 3 - COST).quantize(q3)
    ca = corr("timestop")
    assert ca is not None and ca.kind == "retrack" and ca.status_before == "closed_time"
    assert ca.result_before is not None and D(ca.result_before["realized_r"]) == BUG_R
    assert ca.result_before["cost_r"] is None
    assert ca.tracking_before is not None and ca.tracking_before["state"]["status"] == "closed_time"
    old_ids = [r[0] for r in original["timestop"] if r[1] != "created"]
    assert sorted(ca.superseded_event_ids) == sorted(old_ids)
    new = _events(db, s["timestop"])[len(original["timestop"]) :]
    assert [(r[1], r[4]) for r in new] == [
        ("activated", "retrack"),
        ("time_stop", "retrack"),
        ("corrected", "retrack"),
    ]
    assert new[1][3] == DEADLINE and "срок 2026-10-29 20:00 UTC" in str(new[1][5])
    note = str(new[2][5])
    assert note == ca.note and ca.note_event_id == new[2][0]
    assert "через 15 мин после сигнала" in note and "Было: по времени, +0.033 R" in note
    assert "Стало: по времени" in note and "комиссия 0.043 R" in note
    state = state_from_json(db.get(SignalTracking, s["timestop"].id).state)  # type: ignore[union-attr]
    assert state.status is SignalStatus.CLOSED_TIME and state.deadline_at == DEADLINE

    # B: стоп через 5 ч
    b = res("tostop")
    assert s["tostop"].status == "closed_sl" and b is not None
    assert b.realized_r == (D(-1) - COST).quantize(q3) and b.closed_at == T + 301 * M1

    # C: TP1, сделка снова открыта: результата нет, состояние — для трекера
    assert s["opentp1"].status == "tp1_hit" and res("opentp1") is None
    tr = db.get(SignalTracking, s["opentp1"].id)
    assert tr is not None and tr.last_candle_time == T + (121 + 70 * 60 - 1) * M1
    assert state_from_json(tr.state).hits == 1 and state_from_json(tr.state).stop == D(100)
    cc = corr("opentp1")
    assert cc is not None and cc.status_after == "tp1_hit" and cc.result_after is None

    # D, J: недействительны — статус voided, результата нет (он в архиве), закрытие заменено
    for name, why in (("riskgap", "доходит до стопа"), ("nocandle", "нет ни одной")):
        assert s[name].status == "voided" and res(name) is None
        cd = corr(name)
        assert cd is not None and cd.kind == "void" and cd.result_before is not None
        closing = [r[0] for r in original[name] if r[1] == "time_stop"]
        assert cd.superseded_event_ids == closing
        last = _events(db, s[name])[-1]
        assert (
            last[1] == "voided" and why in str(last[5]) and "исключён из статистики" in str(last[5])
        )

    # E: безопасный пропуск — пересчитан, пояснение говорит о пропуске
    assert s["safegap"].status == "closed_time" and res("safegap") is not None
    assert "пропуски (20 мин)" in str(corr("safegap").note)  # type: ignore[union-attr]

    # F: только комиссия — события не менялись, исход тот же
    f = res("fees")
    assert s["fees"].status == "closed_sl" and f is not None
    assert f.realized_r == (D(-1) - COST).quantize(q3) and f.cost_r == COST.quantize(q3)
    assert f.closed_at == T + 11 * M1
    cf = corr("fees")
    assert cf is not None and cf.kind == "fees" and cf.superseded_event_ids == []
    assert [r[1] for r in _events(db, s["fees"])][-1] == "corrected"

    # G, H, I: без изменений
    for name in ("ok", "live", "early"):
        assert corr(name) is None and _events(db, s[name]) == original[name]
    assert s["live"].status == "closed_time" and res("live").realized_r == BUG_R  # type: ignore[union-attr]

    # отметка задания, плашка снята, снимки статистики — без недействительных
    job = db.get(DeployJob, RETRACK_JOB)
    assert job is not None and job.completed_at == NOW
    assert job.summary["applied"] == {"fees": 1, "ok": 1, "retrack": 4, "void": 2}
    assert not forward_notice_shown(db)
    trades = {t.facts[0] for t in load_trades(db, "forward", w.ver.id)}
    assert s["riskgap"].public_id not in trades and s["nocandle"].public_id not in trades
    assert {s[n].public_id for n in ("timestop", "tostop", "opentp1", "fees", "ok")} <= trades
    snap = db.scalar(
        select(StatsSnapshot).where(
            StatsSnapshot.scope == "forward",
            StatsSnapshot.strategy_version_id == w.ver.id,
            StatsSnapshot.instrument_id.is_(None),
            StatsSnapshot.grade.is_(None),
        )
    )
    assert snap is not None and snap.computed_at == NOW
    assert snap.metrics["metrics"]["closed"] == 6  # A, B, E, F, G и early

    # карточка: заменённые события не показываются, пояснение — с текстом
    owner = User(email=f"o-{w.tag}@example.test", role="owner", email_verified_at=T)
    db.add(owner)
    db.flush()
    client = _client(db, owner)
    card = client.get(f"/v1/signals/{s['timestop'].public_id}").json()
    assert [(e["type"], e["source"]) for e in card["events"]] == [
        ("created", "engine"),
        ("activated", "retrack"),
        ("time_stop", "retrack"),
        ("corrected", "retrack"),
    ]
    assert card["events"][-1]["note"] == ca.note
    assert card["result"]["closed_at"] == DEADLINE.isoformat()
    stats = client.get(f"/v1/stats?scope=forward&strategy_version_id={w.ver.id}").json()
    assert stats["notice"] is None
    current = db.scalars(
        select(SignalEvent.id).where(SignalEvent.signal_id == s["riskgap"].id, current_event())
    ).all()
    assert set(current).isdisjoint(corr("riskgap").superseded_event_ids)  # type: ignore[union-attr]

    # повторный запуск ничего не меняет
    count = db.scalar(text("select count(*) from signal_events"))
    assert retrack.run(factory, now=NOW + timedelta(hours=1)) is None
    assert db.scalar(text("select count(*) from signal_events")) == count

    # трекер ведёт пересчитанную открытую сделку дальше: возврат к входу — безубыток
    more = _calm(T + (121 + 70 * 60) * M1, 30, D(101))
    more[10] = Candle(more[10].open_time, D(101), D("101.2"), D("99.9"), D(100), D(1))
    w.minutes("opentp1", more)
    db.commit()
    monkeypatch.setattr(worker, "SessionLocal", factory)
    monkeypatch.setattr(worker, "_publish_status", lambda _c: None)
    worker.catch_up(Timeframe.M1, s["opentp1"].instrument_id)
    db.expire_all()
    assert s["opentp1"].status == "closed_be"
    c = res("opentp1")
    assert c is not None and c.realized_r == (D("0.4") - COST).quantize(q3)
    tail = _events(db, s["opentp1"])[-1]
    assert tail[1] == "be" and tail[4] == "tracker"
    n = db.scalar(
        select(text("count(*)"))
        .select_from(SignalCorrection)
        .where(SignalCorrection.signal_id == s["opentp1"].id)
    )
    assert n == 1


@db_only
def test_restart_after_failure_continues_without_duplicates(
    factory: sessionmaker[Session], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Сбой на одном сигнале: остальные применены, отметки нет, плашка остаётся. Следующий старт
    применяет только оставшийся сигнал и ставит отметку; применённые не повторяются."""
    db = factory()
    w = _build(db)
    s = w.signals
    broken = s["tostop"].id
    real = retrack.apply_plan

    def flaky(db_: Session, sig: Signal, plan: retrack.Plan, now: datetime) -> Any:
        if sig.id == broken:
            raise RuntimeError("сбой записи")
        return real(db_, sig, plan, now)

    monkeypatch.setattr(retrack, "apply_plan", flaky)
    first = retrack.run(factory, now=NOW)
    assert first is not None and first["failed"] == [str(broken)]
    db.expire_all()
    assert db.get(DeployJob, RETRACK_JOB) is None
    assert forward_notice_shown(db) or not public.settings.forward_notice
    assert s["tostop"].status == "closed_time"  # откат шага сигнала целиком
    assert db.scalar(select(SignalCorrection).where(SignalCorrection.signal_id == broken)) is None
    events_a = _events(db, s["timestop"])

    monkeypatch.setattr(retrack, "apply_plan", real)
    second = retrack.run(factory, now=NOW + timedelta(minutes=5))
    assert second is not None and second["failed"] == []
    # кандидаты — закрытые: недействительные и снова открытая сделка уже не в выборке
    assert second["applied"] == {"done": 3, "ok": 1, "retrack": 1}
    db.expire_all()
    assert s["tostop"].status == "closed_sl"
    assert _events(db, s["timestop"]) == events_a
    corrections = db.scalars(
        select(SignalCorrection.signal_id).where(
            SignalCorrection.signal_id.in_([sig.id for sig in s.values()])
        )
    ).all()
    assert len(corrections) == len(set(corrections)) == 7
    assert db.get(DeployJob, RETRACK_JOB) is not None
    assert retrack.run(factory, now=NOW + timedelta(minutes=10)) is None


@db_only
def test_planning_alone_writes_nothing(factory: sessionmaker[Session]) -> None:
    """Отчёт (dry-run) только читает: после решений по всем сигналам в БД ничего не изменилось."""
    db = factory()
    w = _build(db)
    tables = ("signal_events", "signal_results", "signal_tracking", "signal_corrections")

    def counts() -> list[Any]:
        return [db.scalar(text(f"select count(*) from {t}")) for t in tables]

    before = counts()
    statuses = {n: sig.status for n, sig in w.signals.items()}
    plans = [retrack.plan_signal(db, sig) for sig in w.signals.values()]
    assert {p.kind for p in plans} == {"retrack", "void", "fees", "ok"}
    db.flush()
    assert counts() == before
    db.expire_all()
    assert {n: sig.status for n, sig in w.signals.items()} == statuses


def test_retrack_once_reports_whether_the_job_is_done(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Ошибка задания не останавливает трекер; ``True`` — только когда задание выполнено."""
    outcomes: list[Any] = [
        RuntimeError("БД недоступна"),
        {"failed": ["7"]},
        {"failed": []},
        None,
    ]

    def fake_run() -> Any:
        out = outcomes.pop(0)
        if isinstance(out, Exception):
            raise out
        return out

    monkeypatch.setattr(retrack, "run", fake_run)
    with caplog.at_level(logging.ERROR, logger="tracker"):
        assert worker.retrack_once() is False
    assert "пересчёт форварда не удался" in caplog.records[0].getMessage()
    assert worker.retrack_once() is False  # не применён сигнал — отметки нет
    assert worker.retrack_once() is True
    assert worker.retrack_once() is True  # выполнено раньше


class _FakePubSub:
    async def subscribe(self, *_a: Any) -> None:
        return None

    async def listen(self) -> Any:
        await asyncio.Event().wait()
        yield {}


class _FakeRedis:
    def __init__(self) -> None:
        self.heartbeats = 0

    def pubsub(self) -> _FakePubSub:
        return _FakePubSub()

    async def set(self, *_a: Any) -> None:
        self.heartbeats += 1

    async def aclose(self) -> None:
        return None


def test_tracker_retries_the_job_with_growing_delay(monkeypatch: pytest.MonkeyPatch) -> None:
    """Пока задание не выполнено, повтор — не раньше срока; интервал удваивается до предела;
    выполненное задание больше не запускается."""
    monkeypatch.setattr(worker.aioredis, "from_url", lambda *_a, **_k: _FakeRedis())
    clock = [1000.0]
    monkeypatch.setattr(worker.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(worker, "RETRACK_RETRY_FIRST", 60)
    monkeypatch.setattr(worker, "RETRACK_RETRY_MAX", 200)
    done = [False] * 4 + [True]
    calls: list[float] = []

    def once() -> bool:
        calls.append(clock[0])
        return done[len(calls) - 1]

    monkeypatch.setattr(worker, "retrack_once", once)
    t = worker.Tracker()

    async def drive() -> None:
        for _ in range(1200):  # шаг 1 с — проход трекера раз в «секунду»
            await t.retrack()
            clock[0] += 1

    asyncio.run(drive())
    # 1000, +60, +120, +200 (предел), +200 — выполнено, дальше не запускается
    assert calls == [1000.0, 1060.0, 1180.0, 1380.0, 1580.0]
    assert t.retrack_done


@db_only
def test_tracker_started_before_migration_completes_the_job_later(
    factory: sessionmaker[Session],
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Трекер выкладывается одновременно с API, а миграция 0026 применяется на выкладке API: при
    старте трекера таблиц задания ещё нет. Задание не откладывается до следующего перезапуска —
    его повторяет периодический проход, и после миграции оно выполняется."""
    db = factory()
    w = _build(db)
    db.execute(text("alter table deploy_jobs rename to deploy_jobs_later"))
    db.commit()
    real_run = retrack.run
    attempts: list[int] = []

    def run_job() -> dict[str, Any] | None:
        attempts.append(1)
        if len(attempts) == 2:  # между попытками API применил миграцию
            with factory() as s:
                s.execute(text("alter table deploy_jobs_later rename to deploy_jobs"))
                s.commit()
        return real_run(factory, now=NOW)

    monkeypatch.setattr(retrack, "run", run_job)
    monkeypatch.setattr(worker.aioredis, "from_url", lambda *_a, **_k: _FakeRedis())
    monkeypatch.setattr(worker, "catch_up", lambda *_a: 0)
    monkeypatch.setattr(worker, "CATCHUP_EVERY", 0)
    monkeypatch.setattr(worker, "RETRACK_RETRY_FIRST", 0)
    t = worker.Tracker()

    async def drive() -> None:
        task = asyncio.create_task(t.run())
        for _ in range(2000):
            if t.retrack_done:
                break
            await asyncio.sleep(0.01)
        t.stop.set()
        await asyncio.wait_for(task, 10)

    with caplog.at_level(logging.WARNING, logger="tracker"):
        asyncio.run(drive())
    assert t.retrack_done and len(attempts) == 2
    assert any("повтор через" in r.getMessage() for r in caplog.records)
    db.expire_all()
    assert db.get(DeployJob, RETRACK_JOB) is not None
    assert w.signals["timestop"].status == "closed_time"
    res = db.get(SignalResult, w.signals["timestop"].id)
    assert res is not None and res.closed_at == DEADLINE
    assert w.signals["riskgap"].status == "voided"


MIGRATION_0026 = (
    Path(__file__).resolve().parents[1]
    / "alembic"
    / "versions"
    / "20261110_0026_signal_corrections.py"
)


def _migrate(db: Session, step: str) -> None:
    """Шаг миграции 0026 в транзакции теста (DDL в PostgreSQL откатывается вместе с ней)."""
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    spec = importlib.util.spec_from_file_location("migration_0026", MIGRATION_0026)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    with Operations.context(MigrationContext.configure(db.connection())):
        getattr(mod, step)()


def _row(db: Session, table: str, sid: int) -> Any:
    return db.execute(
        text(f"select to_jsonb(r) from {table} r where signal_id = :i"), {"i": sid}
    ).scalar()


@db_only
def test_downgrade_restores_signals_without_result_or_tracking_rows(
    factory: sessionmaker[Session], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Откат 0026 после задания. «Истёк» при входе по рынку (состояние есть, результата нет —
    трекер не пишет результат истечения), закрытый по ошибке без состояния трекера и сделка,
    снова открытая пересчётом и закрытая потом трекером: всё возвращается к записанному до
    задания, события трекера после исправления удаляются. «Строки не было» — SQL NULL, JSON null
    в архив не записать."""
    db = factory()
    w = World(db)
    expired = w.signal(
        "expired",
        status="expired",
        events=(("expired", T + 6 * M1, D(100)),),
        state=state_to_json(TrackerState(status=SignalStatus.EXPIRED, candles_seen=6)),
    )
    w.minutes("expired", _calm(T, 61 * 60))
    notrack = w.signal("notrack", events=BUG_EVENTS, result=BUG_R)
    w.minutes("notrack", _calm(T, 61 * 60))
    reopened = w.signal("reopen", events=BUG_EVENTS, result=BUG_R, state=_bug_state(D("0.1") / 3))
    tp1 = [Candle(T + 120 * M1, D(101), D("103.5"), D("100.5"), D(103), D(1))]
    w.minutes("reopen", [*_calm(T, 120), *tp1, *_calm(T + 121 * M1, 70 * 60, D(101))])
    db.commit()
    sigs = (expired, notrack, reopened)
    before = {s.id: (s.status, _events(db, s), _row(db, "signal_results", s.id)) for s in sigs} | {
        -s.id: _row(db, "signal_tracking", s.id) for s in sigs
    }
    assert before[expired.id][2] is None and before[-notrack.id] is None

    summary = retrack.run(factory, now=NOW)
    assert summary is not None and summary["applied"] == {"retrack": 3}
    db.expire_all()
    archived = db.execute(
        text(
            "select signal_id, result_before is null, tracking_before is null "
            "from signal_corrections where signal_id = any(:i) order by signal_id"
        ),
        {"i": [s.id for s in sigs]},
    ).all()
    assert archived == [
        (expired.id, True, False),
        (notrack.id, False, True),
        (reopened.id, False, False),
    ]
    json_null = "update signal_corrections set result_before = 'null'::jsonb where signal_id = :i"
    with (
        pytest.raises(DBAPIError, match="ck_signal_corrections_result_before"),
        db.begin_nested(),
    ):
        db.execute(text(json_null), {"i": expired.id})
    # трекер довёл снова открытую сделку до безубытка
    assert reopened.status == "tp1_hit"
    more = _calm(T + (121 + 70 * 60) * M1, 30, D(101))
    more[10] = Candle(more[10].open_time, D(101), D("101.2"), D("99.9"), D(100), D(1))
    w.minutes("reopen", more)
    db.commit()
    monkeypatch.setattr(worker, "SessionLocal", factory)
    monkeypatch.setattr(worker, "_publish_status", lambda _c: None)
    worker.catch_up(Timeframe.M1, reopened.instrument_id)
    db.expire_all()
    assert reopened.status == "closed_be" and _events(db, reopened)[-1][4] == "tracker"

    _migrate(db, "downgrade")
    db.expire_all()
    for s in sigs:
        assert (s.status, _events(db, s), _row(db, "signal_results", s.id)) == before[s.id], (
            s.public_id
        )
        assert _row(db, "signal_tracking", s.id) == before[-s.id], s.public_id
    assert db.scalar(text("select to_regclass('signal_corrections')")) is None
    _migrate(db, "upgrade")
    assert db.scalar(text("select count(*) from deploy_jobs")) == 0


def test_fees_without_state_uses_recorded_result() -> None:
    """Без сохранённого состояния комиссия вычитается из записанного результата."""

    class NoState:
        def get(self, _model: type, _key: int) -> None:
            return None

    sig = Signal(
        id=1,
        direction="long",
        entry_market=D(100),
        entry_limit=None,
        stop_loss=D(97),
        tp1=D(103),
        tp2=D(107),
        tp3=D(112),
        rr_tp2=D("2.333"),
        candle_close_time=T,
        status="closed_sl",
    )
    res = SignalResult(
        signal_id=1, realized_r=D(-1), realized_r_tp1_only=D(-1), realized_r_full_tp2=None
    )
    out = retrack._fees(NoState(), sig, P, res)  # type: ignore[arg-type]
    assert out.cost_r == execution_cost_r(D(100), _setup_from_row(sig).risk, DEFAULT_EXECUTION)
    assert out.realized_r == D(-1) - COST and out.r_if_full_tp2 is None


def test_overlaps_flag_signals_opened_while_previous_trade_runs() -> None:
    """Справочная пометка правила одной сделки (задача 6): сигнал, открытый до закрытия
    предыдущей сделки той же версии по инструменту или на свече H4 её выхода."""

    def plan(pid: str, opened: datetime, closed: datetime | None, kind: str = "retrack") -> Any:
        return retrack.Plan(
            signal_id=int(opened.timestamp()),
            public_id=pid,
            symbol="XLMUSDT",
            version="1.0.0",
            opened=opened,
            kind=kind,
            reason="",
            before=retrack.Outcome("closed_time"),
            after=retrack.Outcome("closed_sl", closed_at=closed),
        )

    plans = [
        plan("a", T, T + 7 * H4 + 10 * M1),  # закрыта внутри свечи H4, что кончается в T + 8 H4
        plan("b", T + 2 * H4, T + 3 * H4),  # открыт при сделке a
        plan("x", T + 8 * H4, T + 8 * H4 + M1),  # на свече выхода a — в бэктесте тоже занято
        plan("c", T + 9 * H4, None),  # свободно; сделка c ещё открыта
        plan("d", T + 30 * H4, T + 31 * H4),  # c открыта — занято
        plan("e", T + 40 * H4, None, kind="void"),  # недействительные не учитываются
    ]
    assert retrack.overlaps(plans) == {"b": "a", "x": "a", "d": "c"}
    other = [plan("x", T + H4, None)]
    other[0] = retrack.Plan(**{**vars_plan(other[0]), "symbol": "FILUSDT"})
    assert retrack.overlaps([plans[0], *other]) == {}


def vars_plan(p: retrack.Plan) -> dict[str, Any]:
    return {f: getattr(p, f) for f in p.__dataclass_fields__}
