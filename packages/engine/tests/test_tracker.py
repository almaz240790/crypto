"""Трекер эквивалентен simulate_trade на любом ряде свечей (случайные сценарии)."""

from __future__ import annotations

import random
from datetime import UTC, datetime
from decimal import Decimal

from engine.backtest import ExecutionParams, TradeStatus, simulate_trade
from engine.candles import Candle, Timeframe
from engine.params import TradeParams
from engine.structure import Direction
from engine.tracker import EventType, SignalStatus, SignalTracker, TrackerState
from engine.trade import TradeSetup

D = Decimal
T0 = datetime(2024, 1, 1, tzinfo=UTC)
NO_COST = ExecutionParams(fee_rate=D(0), slippage=D(0))
LONG = TradeSetup(
    Direction.UP, D(100), D("98.5"), D(97), D(103), D(107), D(112), D(3), D(7) / D(3), ()
)
SHORT = TradeSetup(
    Direction.DOWN, D(100), D("101.5"), D(103), D(97), D(93), D(88), D(3), D(7) / D(3), ()
)

STATUS_MAP = {
    TradeStatus.CLOSED_SL: SignalStatus.CLOSED_SL,
    TradeStatus.CLOSED_BE: SignalStatus.CLOSED_BE,
    TradeStatus.CLOSED_TP3: SignalStatus.CLOSED_TP3,
    TradeStatus.CLOSED_TIME: SignalStatus.CLOSED_TIME,
    TradeStatus.EXPIRED: SignalStatus.EXPIRED,
}


def random_path(rng: random.Random, n: int, start: float = 100.0) -> list[Candle]:
    out = []
    price = start
    for i in range(n):
        o = price
        c = o + rng.uniform(-4, 4)
        h = max(o, c) + rng.uniform(0, 3)
        lo = min(o, c) - rng.uniform(0, 3)
        out.append(
            Candle(
                T0 + Timeframe.H4.delta * i,
                D(f"{o:.2f}"),
                D(f"{h:.2f}"),
                D(f"{lo:.2f}"),
                D(f"{c:.2f}"),
                D(1),
            )
        )
        price = c
    return out


def test_tracker_matches_simulate_trade_on_random_paths() -> None:
    rng = random.Random(7)
    for trial in range(300):
        setup = LONG if trial % 2 == 0 else SHORT
        params = TradeParams(be_after_tp1=trial % 3 != 0, time_stop_candles=rng.choice([5, 15]))
        entry_type = "limit" if trial % 5 == 0 else "market"
        path = random_path(rng, rng.randint(1, 30))
        sim = simulate_trade(setup, path, params, ExecutionParams(D(0), D(0), entry_type))
        tracker = SignalTracker(setup, params, entry_type)
        tracker.run(path)
        st = tracker.state
        if sim.status is TradeStatus.OPEN:
            assert st.status.is_open, (trial, sim, st)
            expected_status = {
                0: SignalStatus.ACTIVE,
                1: SignalStatus.TP1_HIT,
                2: SignalStatus.TP2_HIT,
            }[sim.tp_hits]
            if entry_type == "limit" and sim.entry_index is None:
                expected_status = SignalStatus.PENDING
            assert st.status is expected_status, (trial, sim, st)
        else:
            assert st.status is STATUS_MAP[sim.status], (trial, sim, st)
        assert st.hits == sim.tp_hits
        if st.status is not SignalStatus.PENDING and st.status is not SignalStatus.EXPIRED:
            assert abs(st.realized_r - sim.realized_r) < D("1e-12"), (
                trial,
                st.realized_r,
                sim.realized_r,
            )
            assert st.mfe_r == sim.max_favorable_r and st.mae_r == sim.max_adverse_r
            assert st.r_if_tp1_only == sim.r_if_tp1_only and st.r_if_full_tp2 == sim.r_if_full_tp2


def test_events_sequence_and_resume_from_state() -> None:
    path = [
        Candle(T0, D(100), D(104), D(99), D(103), D(1)),
        Candle(T0 + Timeframe.H4.delta, D(103), D(108), D(102), D(107), D(1)),
        Candle(T0 + Timeframe.H4.delta * 2, D(107), D(113), D(106), D(112), D(1)),
    ]
    t = SignalTracker(LONG, TradeParams())
    first = t.step(path[0])
    assert [e.type for e in first] == [EventType.ACTIVATED, EventType.TP1]
    assert t.state.status is SignalStatus.TP1_HIT and t.state.stop == D(100)
    # восстановление из сохранённого состояния — продолжаем с той же точки
    resumed = SignalTracker(
        LONG,
        TradeParams(),
        state=TrackerState(**{f: getattr(t.state, f) for f in TrackerState.__slots__}),
    )
    rest = resumed.run(path[1:])
    assert [e.type for e in rest] == [EventType.TP2, EventType.TP3]
    assert resumed.state.status is SignalStatus.CLOSED_TP3
    assert abs(resumed.state.realized_r - D("2.1333")) < D("0.001")
    assert resumed.step(path[0]) == []  # закрытый сигнал больше не меняется


def test_limit_expiry_and_r_at() -> None:
    t = SignalTracker(LONG, TradeParams(limit_expiry_candles=2), entry_type="limit")
    flat = [
        Candle(T0 + Timeframe.H4.delta * i, D(100), D(101), D(99), D(100), D(1)) for i in range(3)
    ]
    events = t.run(flat)
    assert [e.type for e in events] == [
        EventType.EXPIRED
    ] and t.state.status is SignalStatus.EXPIRED
    active = SignalTracker(LONG, TradeParams())
    active.step(flat[0])
    assert active.r_at(D(103)) == D(1)
