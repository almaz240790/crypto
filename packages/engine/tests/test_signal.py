"""Интеграционный тест сборки сигнала: синтетический сетап «BOS → первый ретест OB»."""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from engine.candles import Candle, Timeframe
from engine.derivatives import CalendarEvent, TokenEvent
from engine.params import FilterParams, StrategyParams
from engine.scoring import Grade
from engine.signal import MarketInputs, NoSignal, SignalCandidate, evaluate, input_hash, replay
from engine.structure import Direction
from engine.zones import ZoneKind

T0 = datetime(2024, 1, 1, tzinfo=UTC)
H4 = Timeframe.H4.delta


def ohlc(rows: list[tuple[float, float, float, float]], start: datetime = T0) -> list[Candle]:
    return [
        Candle(
            open_time=start + H4 * i,
            open=Decimal(str(o)),
            high=Decimal(str(h)),
            low=Decimal(str(lo)),
            close=Decimal(str(c)),
            volume=Decimal(1),
        )
        for i, (o, h, lo, c) in enumerate(rows)
    ]


def zigzag(n: int, tf: Timeframe, start_price: float, step: float, start: datetime) -> list[Candle]:
    out = []
    for i in range(n):
        leg, pos = i // 4, i % 4
        base = start_price + step * leg + (3.0 if pos == 2 else 0) * (1 if step > 0 else -1)
        close = base + (0.5 if pos in (1, 2) else -0.5) * (1 if step > 0 else -1)
        out.append(
            Candle(
                open_time=start + tf.delta * i,
                open=Decimal(str(base)),
                high=Decimal(str(max(base, close) + 1)),
                low=Decimal(str(min(base, close) - 1)),
                close=Decimal(str(close)),
                volume=Decimal(1),
            )
        )
    return out


FLAT = [(100, 101, 99, 100)] * 260
SETUP = [
    (100, 102, 98, 101),
    (101, 103, 99, 102),
    (102, 105, 101, 104),  # swing high 105
    (104, 104.5, 100, 101),
    (101, 102, 99, 100),
    (100, 101, 97, 98),  # swing low 97
    (99, 99.5, 97.5, 98.8),  # OB 97.5–99, база S/D 97.5–99.5
    (98.8, 101, 97.8, 100.5),
    (100.5, 104, 100, 103.5),
    (103.5, 108, 103, 107),  # BOS вверх
    (107, 109, 106, 108),
    (107, 107.5, 98.8, 99.5),  # первый ретест OB: хвост 98.8 ≤ 99, закрытие внутри зоны
]
FUTURE = [(99.5, 104, 99, 103), (103, 106, 102, 105)]

PARAMS = StrategyParams(filters=FilterParams(atr_min_history=10**6))  # ATR-режим не проверяем


def inputs(
    extra: list[tuple[float, float, float, float]] | None = None, **kw: object
) -> MarketInputs:
    h4 = ohlc([*FLAT, *SETUP, *(extra or [])])
    d1 = zigzag(120, Timeframe.D1, 100, 2, T0 - timedelta(days=120))
    w1 = zigzag(40, Timeframe.W1, 100, 2, T0 - timedelta(weeks=40))
    return MarketInputs(symbol="BTCUSDT", h4=h4, d1=d1, w1=w1, **kw)  # type: ignore[arg-type]


AT = T0 + H4 * (len(FLAT) + len(SETUP))  # закрытие свечи ретеста


def test_signal_is_built_on_first_retest() -> None:
    res = evaluate(inputs(), AT, PARAMS)
    assert isinstance(res, SignalCandidate), res
    assert res.direction is Direction.UP and res.zone.kind is ZoneKind.OB
    assert res.zone_kinds == frozenset({ZoneKind.OB, ZoneKind.SD})
    assert res.trade.entry_market == Decimal("99.5")
    assert res.trade.tp2 == Decimal("105")  # swing high в окне [1.8; 3] R
    assert res.trade.rr_tp2 >= Decimal("1.8")
    assert res.score.grade is Grade.B and res.score.total == 57 and res.publishable
    assert res.strategy_version == PARAMS.version and len(res.input_hash) == 64
    assert any("BOS up" in f for f in res.facts) and any("OB+SD" in f for f in res.facts)
    assert not res.deferred


def test_replay_ignores_future_data() -> None:
    with_future = inputs(FUTURE)
    truncated = inputs()
    assert replay(with_future, AT, PARAMS) == evaluate(truncated, AT, PARAMS)
    assert input_hash(with_future.h4, "v", 400) != input_hash(truncated.h4, "v", 400)


def test_no_signal_before_retest_and_on_wrong_moment() -> None:
    before = evaluate(inputs(), AT - H4, PARAMS)
    assert isinstance(before, NoSignal) and before.stage == "trigger"
    off = evaluate(inputs(), AT + timedelta(hours=1), PARAMS)
    assert isinstance(off, NoSignal) and off.stage == "data"
    short = replace(inputs(), h4=inputs().h4[-100:])
    assert isinstance(evaluate(short, AT, PARAMS), NoSignal)


def test_neutral_bias_stops_early() -> None:
    down_w1 = zigzag(40, Timeframe.W1, 300, -2, T0 - timedelta(weeks=40))
    res = evaluate(replace(inputs(), w1=down_w1), AT, PARAMS)
    assert isinstance(res, NoSignal) and res.stage == "bias"


def test_blocking_filter_stops_signal() -> None:
    unlock = TokenEvent(AT + timedelta(hours=10), "unlock", Decimal("0.05"))
    res = evaluate(inputs(token_events=[unlock]), AT, PARAMS)
    assert isinstance(res, NoSignal) and res.stage == "filters" and "Разблокировка" in res.reason


def test_news_defers_signal() -> None:
    cpi = CalendarEvent(AT + timedelta(minutes=30), "CPI", 3)
    res = evaluate(inputs(calendar=[cpi]), AT, PARAMS)
    assert isinstance(res, SignalCandidate) and res.deferred and not res.publishable
