"""Трекер-воркер без БД: сериализация состояния и запись событий/результата (сессия-заглушка)."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from app.models import Signal, SignalEvent, SignalResult, SignalTracking, StrategyVersion
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


def _signal(status: str = "pending") -> Signal:
    return Signal(
        id=1,
        public_id="t1",
        strategy_version_id=1,
        instrument_id=1,
        direction="long",
        candle_close_time=SIGNAL_CLOSE,
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
