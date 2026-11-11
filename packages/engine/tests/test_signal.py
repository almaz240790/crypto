"""Интеграционный тест сборки сигнала: синтетический сетап «BOS → первый ретест OB»."""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime, timedelta, timezone
from decimal import Decimal

from engine.candles import Candle, Timeframe
from engine.derivatives import (
    CalendarEvent,
    FundingRate,
    LiquidationBucket,
    LongShortRatio,
    OpenInterest,
    TokenEvent,
)
from engine.filters import ActiveSignalRef
from engine.params import FilterParams, StrategyParams
from engine.scoring import Grade
from engine.signal import (
    FINGERPRINT_HEX,
    MarketInputs,
    NoSignal,
    SignalCandidate,
    evaluate,
    input_hash,
    inputs_fingerprint,
    replay,
)
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


def test_signal_candle_patterns_filters_type_direction_and_significance() -> None:
    from dataclasses import replace
    from datetime import UTC, datetime
    from decimal import Decimal

    from engine.candles import Candle, Timeframe
    from engine.params import ScoringParams, StrategyParams
    from engine.signal import signal_candle_patterns
    from engine.structure import Direction, MarketStructure

    t0 = datetime(2024, 1, 1, tzinfo=UTC)
    rows = [
        (
            f"{100 + i / 1000:.3f}",
            f"{102 + i / 1000:.3f}",
            f"{99 + i / 1000:.3f}",
            f"{101 + i / 1000:.3f}",
            "10",
        )
        for i in range(80)
    ]
    rows += [
        ("100", "100.5", "98.5", "99", "10"),
        ("99", "99.5", "97.5", "98", "10"),
        ("98", "98.5", "96.5", "97", "10"),
        ("97", "97.2", "96.3", "96.4", "10"),
        ("96.4", "98", "96.2", "97.8", "20"),
    ]
    h4 = [
        Candle(
            t0 + Timeframe.H4.delta * i, Decimal(o), Decimal(h), Decimal(lo), Decimal(c), Decimal(v)
        )
        for i, (o, h, lo, c, v) in enumerate(rows)
    ]
    params = StrategyParams()
    st = MarketStructure()
    assert signal_candle_patterns(h4, st, [], [], Direction.UP, params) == ["Бычье поглощение"]
    assert signal_candle_patterns(h4, st, [], [], Direction.DOWN, params) == []
    only_pin = replace(params, scoring=ScoringParams(pattern_types=("pin_bar",)))
    assert signal_candle_patterns(h4, st, [], [], Direction.UP, only_pin) == []
    # без объёма паттерн найден, но не значимый — проходит только при pattern_significant_only=False
    quiet = [*h4[:-1], replace(h4[-1], volume=Decimal(10))]
    assert signal_candle_patterns(quiet, st, [], [], Direction.UP, params) == []
    loose = replace(params, scoring=ScoringParams(pattern_significant_only=False))
    assert signal_candle_patterns(quiet, st, [], [], Direction.UP, loose) == ["Бычье поглощение"]


# --- отпечаток входов --------------------------------------------------------------------------

SERIES = ("h4", "d1", "w1", "funding", "open_interest", "liquidations", "long_short", "other")


def _derivatives(at: datetime) -> dict[str, object]:
    """Записи деривативов: одна до ``at``, одна ровно в ``at`` — обе видны фильтрам."""
    early = at - timedelta(hours=8)
    return {
        "funding": [FundingRate(early, Decimal("0.0001")), FundingRate(at, Decimal("0.0002"))],
        "open_interest": [OpenInterest(early, Decimal(1000)), OpenInterest(at, Decimal(1100))],
        "liquidations": [LiquidationBucket(early, Decimal(5), Decimal(7))],
        "long_short": [LongShortRatio(early, Decimal("0.55"))],
        "avg_daily_turnover": Decimal(50_000_000),
    }


def test_inputs_fingerprint_names_every_series_and_is_stable() -> None:
    fp = inputs_fingerprint(inputs(**_derivatives(AT)), AT)
    assert tuple(fp) == SERIES
    assert all(len(v) == FINGERPRINT_HEX and int(v, 16) >= 0 for v in fp.values())
    assert fp == inputs_fingerprint(
        inputs(**_derivatives(AT)), AT
    )  # те же входы — тот же отпечаток


def test_inputs_fingerprint_ignores_everything_after_the_moment() -> None:
    """Утечка будущего: свечи и записи позже ``at`` отпечаток не меняют — как и сам сигнал."""
    base = inputs(**_derivatives(AT))
    later = AT + timedelta(minutes=1)
    with_future = replace(
        inputs(FUTURE, **_derivatives(AT)),
        # дневная и недельная свечи, не закрытые к ``at``
        d1=[*base.d1, *zigzag(2, Timeframe.D1, 300, 2, AT - timedelta(hours=4))],
        w1=[*base.w1, *zigzag(1, Timeframe.W1, 300, 2, AT - timedelta(days=1))],
        funding=[*base.funding, FundingRate(later, Decimal("0.01"))],
        open_interest=[*base.open_interest, OpenInterest(later, Decimal(9))],
        liquidations=[*base.liquidations, LiquidationBucket(later, Decimal(1), Decimal(1))],
        long_short=[*base.long_short, LongShortRatio(later, Decimal("0.9"))],
    )
    assert inputs_fingerprint(with_future, AT) == inputs_fingerprint(base, AT)
    # а на более позднем моменте те же ряды дают другой отпечаток: данные стали видны
    assert inputs_fingerprint(with_future, AT + H4) != inputs_fingerprint(base, AT + H4)


def test_inputs_fingerprint_changes_only_in_the_series_that_changed() -> None:
    base = inputs(**_derivatives(AT))
    reference = inputs_fingerprint(base, AT)

    def changed(**kw: object) -> set[str]:
        fp = inputs_fingerprint(replace(base, **kw), AT)  # type: ignore[arg-type]
        return {k for k in SERIES if fp[k] != reference[k]}

    first_h4 = replace(base.h4[0], volume=Decimal(2))  # самая старая свеча окна — тоже вход
    assert changed(h4=[first_h4, *base.h4[1:]]) == {"h4"}
    assert changed(h4=base.h4[1:]) == {"h4"}  # окно на свечу короче
    assert changed(d1=[*base.d1[:-1], replace(base.d1[-1], volume=Decimal(3))]) == {"d1"}
    assert changed(w1=base.w1[:-1]) == {"w1"}
    assert changed(funding=[FundingRate(AT, Decimal("0.0003"))]) == {"funding"}
    assert changed(open_interest=base.open_interest[:1]) == {"open_interest"}
    assert changed(liquidations=()) == {"liquidations"}
    assert changed(long_short=[LongShortRatio(AT, Decimal("0.4"))]) == {"long_short"}
    for other in (
        {"avg_daily_turnover": None},
        {"btc_bias_direction": Direction.DOWN},
        {"active_signals": [ActiveSignalRef("ETHUSDT", Direction.UP, Decimal("0.9"))]},
        # календарь и события токена входят целиком: фильтры смотрят в них вперёд от ``at``
        {"calendar": [CalendarEvent(AT + timedelta(hours=3), "FOMC", 3)]},
        {"token_events": [TokenEvent(AT + timedelta(days=2), "unlock", Decimal(4))]},
    ):
        assert changed(**other) == {"other"}, other


def test_inputs_fingerprint_reads_equal_numbers_and_moments_alike() -> None:
    """БД отдаёт NUMERIC с хвостом нулей, а время — в поясе соединения: отпечаток тот же."""
    base = inputs(**_derivatives(AT))
    msk = timezone(timedelta(hours=3))
    same = replace(
        base,
        h4=[replace(c, close=c.close + Decimal("0.000"), volume=Decimal("1.00")) for c in base.h4],
        funding=[
            FundingRate(r.time.astimezone(msk), r.rate + Decimal("0.0000000")) for r in base.funding
        ],
        avg_daily_turnover=Decimal("50000000.00"),
    )
    assert str(same.h4[0].close) != str(base.h4[0].close)  # запись числа другая, число то же
    assert inputs_fingerprint(same, AT.astimezone(msk)) == inputs_fingerprint(base, AT)
