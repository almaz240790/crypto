"""Сериализация состояния трекера (без БД)."""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

from app.workers.scheduler import done_key
from app.workers.tracker import state_from_json, state_to_json
from engine.candles import Candle
from engine.params import TradeParams
from engine.structure import Direction
from engine.tracker import SignalStatus, SignalTracker
from engine.trade import TradeSetup

D = Decimal
LONG = TradeSetup(
    Direction.UP, D(100), D("98.5"), D(97), D(103), D(107), D(112), D(3), D(7) / D(3), ()
)


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
