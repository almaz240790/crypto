"""Трекер эквивалентен simulate_trade на любом ряде свечей (случайные сценарии)."""

from __future__ import annotations

import random
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from engine.backtest import ExecutionParams, TradeStatus, simulate_trade
from engine.candles import SIGNAL_TIMEFRAME, Candle, Timeframe
from engine.params import TradeParams
from engine.structure import Direction
from engine.tracker import EventType, SignalStatus, SignalTracker, TrackerEvent, TrackerState
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


# --- сроки по времени: 1m-поток (план 2.6 п. 3 и 7, 2.10) -----------------------------------

M1 = Timeframe.M1.delta
H4 = SIGNAL_TIMEFRAME.delta
SIGNAL_CLOSE = datetime(2026, 11, 4, 8, tzinfo=UTC)
"""Закрытие сигнальной свечи H4 (как у форвард-сигнала XLMUSDT 04.11.2026 08:00 UTC)."""


def flat_minutes(start: datetime, n: int, price: str = "100") -> list[Candle]:
    """Минуты без касаний входа лимита, стопа и тейков LONG/SHORT: цена стоит у 100 ± 0.5."""
    p = D(price)
    return [
        Candle(start + M1 * i, p, p + D("0.5"), p - D("0.5"), p + D("0.1") * (i % 3 - 1), D(1))
        for i in range(n)
    ]


def m1_tracker(
    setup: TradeSetup = LONG, params: TradeParams | None = None, entry_type: str = "market"
) -> SignalTracker:
    return SignalTracker(
        setup,
        params or TradeParams(),
        entry_type,
        signal_close=SIGNAL_CLOSE,
        timeframe=Timeframe.M1,
    )


def test_market_time_stop_on_1m_closes_60h_after_signal_close() -> None:
    """Регрессия: на 1m-потоке time stop — через 15 свечей H4 (60 ч), а не через 15 минут."""
    deadline = SIGNAL_CLOSE + H4 * TradeParams().time_stop_candles
    assert deadline - SIGNAL_CLOSE == timedelta(hours=60)
    minutes = flat_minutes(SIGNAL_CLOSE, 60 * 60 + 30)
    t = m1_tracker()
    closed_on: Candle | None = None
    for c in minutes:
        events = t.step(c)
        if c.close_time(Timeframe.M1) < deadline:
            # до срока — ни одного закрытия
            assert all(e.type is EventType.ACTIVATED for e in events), (c.open_time, events)
            assert t.state.status is SignalStatus.ACTIVE
        elif closed_on is None:
            closed_on = c
            assert [e.type for e in events] == [EventType.TIME_STOP]
        else:
            assert events == []
    assert closed_on is not None
    assert closed_on.close_time(Timeframe.M1) == deadline
    assert t.state.status is SignalStatus.CLOSED_TIME
    stop_event = t.state.events[-1]
    assert stop_event.at == deadline
    assert stop_event.price == closed_on.close
    assert t.state.realized_r == t.r_at(closed_on.close)
    assert t.state.activated_at == SIGNAL_CLOSE and t.state.deadline_at == deadline
    assert t.state.candles_seen == 60 * 60


def test_limit_on_1m_expires_24h_after_signal_close() -> None:
    expiry = SIGNAL_CLOSE + H4 * TradeParams().limit_expiry_candles
    assert expiry - SIGNAL_CLOSE == timedelta(hours=24)
    t = m1_tracker(entry_type="limit")
    events = t.run(flat_minutes(SIGNAL_CLOSE, 24 * 60 + 10))
    assert [e.type for e in events] == [EventType.EXPIRED]
    assert events[0].at == expiry
    assert t.state.status is SignalStatus.EXPIRED
    assert t.state.candles_seen == 24 * 60  # минута с закрытием ровно на сроке — последняя


def test_limit_touch_in_last_minute_of_window_activates() -> None:
    minutes = flat_minutes(SIGNAL_CLOSE, 24 * 60 + 10)
    last = 24 * 60 - 1  # минута, закрывающаяся ровно в signal_close + 24 ч
    m = minutes[last]
    minutes[last] = Candle(m.open_time, m.open, m.high, LONG.entry_limit, m.close, m.volume)
    t = m1_tracker(entry_type="limit")
    events = t.run(minutes)
    assert [e.type for e in events] == [EventType.ACTIVATED]
    assert events[0].at == SIGNAL_CLOSE + timedelta(hours=24)
    assert t.state.status is SignalStatus.ACTIVE
    # активация в интервале H4 [+20 ч; +24 ч) — он первый из 15: срок = +20 ч + 60 ч
    assert t.state.activated_at == m.open_time
    assert t.state.deadline_at == SIGNAL_CLOSE + timedelta(hours=80)
    # касание через минуту после окна уже не активирует
    late = flat_minutes(SIGNAL_CLOSE, 24 * 60 + 10)
    n = late[24 * 60]
    late[24 * 60] = Candle(n.open_time, n.open, n.high, LONG.entry_limit, n.close, n.volume)
    t2 = m1_tracker(entry_type="limit")
    assert [e.type for e in t2.run(late)] == [EventType.EXPIRED]


def test_limit_time_stop_counts_from_activation_h4_interval() -> None:
    """Активация в 13:17 (интервал 12:00–16:00) → time stop в 12:00 + 60 ч, как в simulate_trade."""
    minutes = flat_minutes(SIGNAL_CLOSE, 80 * 60)
    k = 5 * 60 + 17
    m = minutes[k]
    minutes[k] = Candle(m.open_time, m.open, m.high, LONG.entry_limit, m.close, m.volume)
    t = m1_tracker(entry_type="limit")
    events = t.run(minutes)
    assert [e.type for e in events] == [EventType.ACTIVATED, EventType.TIME_STOP]
    assert events[1].at == SIGNAL_CLOSE + timedelta(hours=4 + 60)
    assert t.state.realized_r == t.r_at(events[1].price)


# --- свойство: 1m-трекер против simulate_trade на тех же минутах, агрегированных в H4 -------------


def random_minutes(
    rng: random.Random,
    start: datetime,
    n: int,
    vol: float,
    drift: float = 0.0,
    turn: int | None = None,
) -> list[Candle]:
    """Случайное блуждание цены по минутам от 100 (цены с шагом 0.01). С минуты ``turn``
    тренд ``drift`` меняет знак: так получаются возвраты к входу после TP1."""
    out: list[Candle] = []
    price = 100.0
    for i in range(n):
        o = price
        c = o + (drift if turn is None or i < turn else -drift) + rng.gauss(0, vol)
        h = max(o, c) + abs(rng.gauss(0, vol / 2))
        lo = min(o, c) - abs(rng.gauss(0, vol / 2))
        out.append(
            Candle(
                start + M1 * i,
                D(f"{o:.2f}"),
                D(f"{h:.2f}"),
                D(f"{lo:.2f}"),
                D(f"{c:.2f}"),
                D(1),
            )
        )
        price = c
    return out


def to_h4(minutes: list[Candle], start: datetime) -> list[Candle]:
    groups: dict[int, list[Candle]] = {}
    for m in minutes:
        groups.setdefault((m.open_time - start) // H4, []).append(m)
    return [
        Candle(
            start + H4 * k,
            g[0].open,
            max(x.high for x in g),
            min(x.low for x in g),
            g[-1].close,
            sum((x.volume for x in g), D(0)),
        )
        for k, g in sorted(groups.items())
    ]


def ambiguous_inside_h4(
    setup: TradeSetup, h4: list[Candle], params: TradeParams, ex: ExecutionParams
) -> bool:
    """Есть ли H4-свеча, исход которой зависит от порядка минут внутри неё.

    Это свеча, где одновременно задеты действующий стоп (исходный или безубыток после TP1) и
    следующий тейк; а при лимитном входе ещё и свеча активации, задевшая TP1: на H4 тейк
    засчитывается после входа, а по минутам он мог быть до касания цены входа.
    """
    up = setup.direction is Direction.UP

    def below(c: Candle, p: Decimal) -> bool:
        return c.low <= p if up else c.high >= p

    def above(c: Candle, p: Decimal) -> bool:
        return c.high >= p if up else c.low <= p

    full = simulate_trade(setup, h4, params, ex)
    if full.entry_index is None:
        return False
    entry = setup.entry_limit if ex.entry_type == "limit" else setup.entry_market
    tps = (setup.tp1, setup.tp2, setup.tp3)
    start = full.entry_index
    end = full.exit_index if full.exit_index is not None else len(h4) - 1
    for k in range(start, end + 1):
        hits = 0 if k == start else simulate_trade(setup, h4[:k], params, ex).tp_hits
        stop = entry if (hits >= 1 and params.be_after_tp1) else setup.stop_loss
        bar = h4[k]
        if hits < 3 and below(bar, stop) and above(bar, tps[hits]):
            return True
        if params.be_after_tp1 and hits == 0 and above(bar, tps[0]) and below(bar, entry):
            return True
        if ex.entry_type == "limit" and k == start and above(bar, tps[0]):
            return True
    return False


def expected_deadlines(
    setup: TradeSetup, minutes: list[Candle], params: TradeParams, entry_type: str
) -> tuple[datetime | None, datetime]:
    """(срок time stop или None, если лимит не исполнился; срок лимита) — посчитано независимо."""
    up = setup.direction is Direction.UP
    expiry = SIGNAL_CLOSE + H4 * params.limit_expiry_candles
    if entry_type == "market":
        return SIGNAL_CLOSE + H4 * params.time_stop_candles, expiry
    for m in minutes:
        if m.open_time >= expiry:
            break
        if (m.low <= setup.entry_limit) if up else (m.high >= setup.entry_limit):
            bar = SIGNAL_CLOSE + H4 * ((m.open_time - SIGNAL_CLOSE) // H4)
            return bar + H4 * params.time_stop_candles, expiry
    return None, expiry


def test_1m_tracker_matches_simulate_trade_on_aggregated_h4() -> None:
    rng = random.Random(20261105)
    combos = [
        (setup, entry_type, be)
        for setup in (LONG, SHORT)
        for entry_type in ("market", "limit")
        for be in (True, False)
    ]
    clean: dict[SignalStatus, int] = {}
    ambiguous = 0
    trials = 400
    for trial in range(trials):
        setup, entry_type, be = combos[trial % len(combos)]
        params = TradeParams(
            be_after_tp1=be,
            time_stop_candles=rng.choice([3, 5, 15]),
            limit_expiry_candles=rng.choice([2, 6]),
        )
        min_bars = params.limit_expiry_candles if entry_type == "limit" else 1
        n_bars = rng.randint(min_bars, params.limit_expiry_candles + params.time_stop_candles + 2)
        vol = rng.choice([0.02, 0.04, 0.07, 0.12])
        # часть путей с трендом в сторону сделки (TP2, TP3) и с разворотом (возврат к входу)
        sign = 1 if setup.direction is Direction.UP else -1
        drift = sign * rng.choice([0.0, 0.0, 0.008, 0.008])
        turn = rng.choice([None, rng.randrange(240, 3 * 240)])
        minutes = random_minutes(rng, SIGNAL_CLOSE, n_bars * 240, vol, drift, turn)
        h4 = to_h4(minutes, SIGNAL_CLOSE)
        ex = ExecutionParams(D(0), D(0), entry_type)
        sim = simulate_trade(setup, h4, params, ex)
        tracker = SignalTracker(
            setup, params, entry_type, signal_close=SIGNAL_CLOSE, timeframe=Timeframe.M1
        )
        tracker.run(minutes)
        st = tracker.state
        ctx = (trial, entry_type, be, params.time_stop_candles, sim, st.status, st.events[-3:])

        # сроки совпадают на любых путях
        ts_deadline, expiry = expected_deadlines(setup, minutes, params, entry_type)
        assert (st.status is SignalStatus.EXPIRED) == (sim.status is TradeStatus.EXPIRED), ctx
        if st.status is SignalStatus.EXPIRED:
            assert st.events[-1].at == expiry, ctx
            continue
        assert ts_deadline is not None and st.deadline_at in (ts_deadline, None), ctx
        if st.status is SignalStatus.CLOSED_TIME:
            assert st.events[-1].at == ts_deadline, ctx
        elif st.status.is_open and st.hits == 0:
            assert minutes[-1].close_time(Timeframe.M1) < ts_deadline, ctx
        if sim.status is TradeStatus.CLOSED_TIME:
            assert sim.exit_index is not None
            assert h4[sim.exit_index].close_time(SIGNAL_TIMEFRAME) == ts_deadline, ctx
        for e in st.events:
            assert e.at is not None and e.at > SIGNAL_CLOSE, ctx  # не раньше первой минуты

        if ambiguous_inside_h4(setup, h4, params, ex):
            ambiguous += 1
            continue
        # однозначные пути: исход тот же, что у simulate_trade на H4 (без комиссий)
        if sim.status is TradeStatus.OPEN:
            expected = {0: SignalStatus.ACTIVE, 1: SignalStatus.TP1_HIT, 2: SignalStatus.TP2_HIT}
            assert st.status is expected[sim.tp_hits], ctx
        else:
            assert st.status is STATUS_MAP[sim.status], ctx
        assert st.hits == sim.tp_hits, ctx
        assert st.realized_r == sim.realized_r, ctx
        assert st.r_if_tp1_only == sim.r_if_tp1_only, ctx
        assert st.r_if_full_tp2 == sim.r_if_full_tp2, ctx
        clean[st.status] = clean.get(st.status, 0) + 1

    # проверка содержательна: однозначных путей большинство, и среди них есть все исходы
    assert sum(clean.values()) >= trials // 2, (clean, ambiguous)
    assert ambiguous > 0
    for status in (
        SignalStatus.CLOSED_TIME,
        SignalStatus.CLOSED_SL,
        SignalStatus.CLOSED_TP3,
        SignalStatus.CLOSED_BE,
        SignalStatus.ACTIVE,
    ):
        assert clean.get(status, 0) >= 3, (status, clean)


def test_missing_minutes_do_not_shift_deadlines() -> None:
    """10 % минут выброшено: срок не раньше дедлайна и не позже первой имеющейся минуты после."""
    rng = random.Random(11)
    checked_ts = checked_exp = 0
    for trial in range(60):
        entry_type = "limit" if trial % 3 == 0 else "market"
        params = TradeParams(time_stop_candles=rng.choice([2, 15]), limit_expiry_candles=2)
        minutes = flat_minutes(SIGNAL_CLOSE, (params.time_stop_candles + 3) * 240)
        if entry_type == "limit" and trial % 2 == 0:  # половина лимитов исполняется
            k = rng.randrange(0, 2 * 240)
            m = minutes[k]
            minutes[k] = Candle(m.open_time, m.open, m.high, LONG.entry_limit, m.close, m.volume)
        kept = [m for m in minutes if rng.random() >= 0.10]
        ts_deadline, expiry = expected_deadlines(LONG, kept, params, entry_type)
        t = SignalTracker(
            LONG, params, entry_type, signal_close=SIGNAL_CLOSE, timeframe=Timeframe.M1
        )
        t.run(kept)
        last = t.state.events[-1]
        assert last.at is not None
        deadline = expiry if t.state.status is SignalStatus.EXPIRED else ts_deadline
        assert deadline is not None
        first_after = next(m for m in kept if m.close_time(Timeframe.M1) >= deadline)
        assert last.at >= deadline
        assert last.at == first_after.close_time(Timeframe.M1)
        assert last.price == first_after.close
        if t.state.status is SignalStatus.EXPIRED:
            checked_exp += 1
        else:
            assert t.state.status is SignalStatus.CLOSED_TIME
            checked_ts += 1
    assert checked_ts >= 20 and checked_exp >= 5


def test_no_lookahead_events_depend_only_on_candles_up_to_them() -> None:
    """Утечка будущего: события до момента T не меняются, если поменять свечи после T."""
    rng = random.Random(3)
    for _ in range(20):
        minutes = random_minutes(rng, SIGNAL_CLOSE, 8 * 240, 0.07)
        cut = rng.randrange(1, len(minutes))
        tail = random_minutes(rng, minutes[cut].open_time, len(minutes) - cut, 0.3)
        altered = minutes[:cut] + tail
        a = m1_tracker(params=TradeParams(time_stop_candles=3))
        b = m1_tracker(params=TradeParams(time_stop_candles=3))
        a.run(minutes)
        b.run(altered)
        horizon = minutes[cut].open_time
        before_a = [e for e in a.state.events if e.at is not None and e.at <= horizon]
        before_b = [e for e in b.state.events if e.at is not None and e.at <= horizon]
        assert before_a == before_b


# --- таймфрейм потока и восстановление старого состояния ---------------------------------------


def test_stream_timeframe_is_checked_by_open_time_grid() -> None:
    minutes = flat_minutes(SIGNAL_CLOSE, 3)
    h4_tracker = SignalTracker(LONG, TradeParams(), signal_close=SIGNAL_CLOSE)
    h4_tracker.step(minutes[0])  # 08:00 лежит и на сетке H4
    with pytest.raises(ValueError, match="не на сетке 4h"):
        h4_tracker.step(minutes[1])  # 08:01 — 1m-свеча не считается за H4
    with pytest.raises(ValueError, match="не делит"):
        SignalTracker(LONG, TradeParams(), timeframe=Timeframe.D1)
    with pytest.raises(ValueError, match="не на сетке 4h"):  # без signal_close — по первой свече
        SignalTracker(LONG, TradeParams()).step(minutes[1])
    t = m1_tracker()
    t.step(minutes[1])
    with pytest.raises(ValueError, match="не позже предыдущей"):
        t.step(minutes[1])
    with pytest.raises(ValueError, match="раньше закрытия сигнальной"):
        m1_tracker().step(Candle(SIGNAL_CLOSE - M1, D(100), D(100), D(100), D(100), D(1)))


def test_signal_close_must_be_utc_h4_boundary() -> None:
    with pytest.raises(ValueError, match="UTC"):
        SignalTracker(LONG, TradeParams(), signal_close=datetime(2026, 11, 4, 8))
    with pytest.raises(ValueError, match="не на границе"):
        SignalTracker(LONG, TradeParams(), signal_close=SIGNAL_CLOSE + M1)


def test_legacy_state_without_deadline_is_restored_from_signal_close() -> None:
    """Состояние, сохранённое старым трекером (счётчик свечей, без сроков), доводится по времени."""
    minutes = flat_minutes(SIGNAL_CLOSE, 61 * 60)
    legacy = TrackerState(
        status=SignalStatus.ACTIVE,
        entry_price=LONG.entry_market,
        stop=LONG.stop_loss,
        candles_seen=5,
        candles_active=5,
        events=(TrackerEvent(EventType.ACTIVATED, LONG.entry_market, 0),),
    )
    t = SignalTracker(
        LONG, TradeParams(), state=legacy, signal_close=SIGNAL_CLOSE, timeframe=Timeframe.M1
    )
    events = t.run(minutes[5:])
    assert [e.type for e in events] == [EventType.TIME_STOP]
    assert events[0].at == SIGNAL_CLOSE + timedelta(hours=60)
    assert t.state.activated_at == SIGNAL_CLOSE
    # без signal_close срок не восстановить — ошибка, а не молчаливое закрытие
    with pytest.raises(ValueError, match="нужен signal_close"):
        SignalTracker(LONG, TradeParams(), state=legacy, timeframe=Timeframe.M1).step(minutes[5])


def test_legacy_limit_state_takes_activation_from_events() -> None:
    by_index = TrackerState(
        status=SignalStatus.ACTIVE,
        entry_price=LONG.entry_limit,
        stop=LONG.stop_loss,
        candles_seen=300,
        events=(TrackerEvent(EventType.ACTIVATED, LONG.entry_limit, 299),),
    )
    t = SignalTracker(
        LONG,
        TradeParams(),
        "limit",
        by_index,
        signal_close=SIGNAL_CLOSE,
        timeframe=Timeframe.M1,
    )
    t.step(flat_minutes(SIGNAL_CLOSE + M1 * 300, 1)[0])
    assert t.state.activated_at == SIGNAL_CLOSE + M1 * 299
    assert t.state.deadline_at == SIGNAL_CLOSE + timedelta(hours=4 + 60)
    at = SIGNAL_CLOSE + timedelta(hours=9, minutes=1)  # время события — close свечи активации
    with_time = replace(
        by_index, events=(TrackerEvent(EventType.ACTIVATED, LONG.entry_limit, 299, at),)
    )
    t2 = SignalTracker(
        LONG, TradeParams(), "limit", with_time, signal_close=SIGNAL_CLOSE, timeframe=Timeframe.M1
    )
    t2.step(flat_minutes(SIGNAL_CLOSE + timedelta(hours=9, minutes=1), 1)[0])
    assert t2.state.deadline_at == SIGNAL_CLOSE + timedelta(hours=8 + 60)
    no_event = replace(by_index, events=())
    with pytest.raises(ValueError, match="нет события активации"):
        SignalTracker(LONG, TradeParams(), "limit", no_event, signal_close=SIGNAL_CLOSE).step(
            flat_minutes(SIGNAL_CLOSE + H4, 1)[0]
        )
