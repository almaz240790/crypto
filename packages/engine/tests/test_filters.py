from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from engine.candles import Candle, Timeframe
from engine.derivatives import (
    CalendarEvent,
    FundingRate,
    LiquidationBucket,
    LongShortRatio,
    OpenInterest,
    TokenEvent,
    upto,
)
from engine.filters import (
    ActiveSignalRef,
    FilterAction,
    atr_regime,
    correlation_filter,
    fresh_choch,
    funding_filter,
    liquidation_filter,
    long_short_filter,
    news_filter,
    open_interest_filter,
    run_filters,
    session_filter,
    session_label,
    token_events_filter,
    turnover_filter,
    volume_filter,
)
from engine.params import FilterParams, StructureParams
from engine.structure import Direction, analyze_structure
from engine.testing import make_candles

T0 = datetime(2024, 1, 1, tzinfo=UTC)
P = FilterParams()
H4 = Timeframe.H4.delta


def candles_with_ranges(ranges: list[float], volume: float = 10) -> list[Candle]:
    out = []
    for i, r in enumerate(ranges):
        out.append(
            Candle(
                open_time=T0 + H4 * i,
                open=Decimal(100),
                high=Decimal(100 + r),
                low=Decimal(100 - r),
                close=Decimal(100),
                volume=Decimal(str(volume)),
            )
        )
    return out


# --- ATR-режим ---------------------------------------------------------------------------


def test_atr_regime_blocks_extremes_and_passes_middle() -> None:
    base = [1.0 + (i % 10) * 0.1 for i in range(260)]  # диапазоны 1.0–1.9
    normal = candles_with_ranges([*base, *([1.45] * 20)])  # ATR сходится к середине
    assert atr_regime(normal, P).action is FilterAction.PASS
    panic = candles_with_ranges([*base, *([10.0] * 20)])
    assert atr_regime(panic, P).action is FilterAction.BLOCK
    assert "экстремальная" in atr_regime(panic, P).reason
    calm = candles_with_ranges([*base, *([0.1] * 20)])
    assert atr_regime(calm, P).action is FilterAction.BLOCK
    assert "низкая" in atr_regime(calm, P).reason


def test_atr_regime_top_decile_penalty_and_short_history() -> None:
    base = [1.0 + (i % 10) * 0.1 for i in range(260)]
    hot = candles_with_ranges([*base, *([2.3] * 20)])  # выше всех, но плавно → p ≈ 97 → блок
    assert atr_regime(hot, P).action is FilterAction.BLOCK
    lenient = FilterParams(atr_high_pct=Decimal(1), atr_top_decile=Decimal("0.8"))
    res = atr_regime(hot, lenient)
    assert res.action is FilterAction.PASS and res.score_delta == -P.atr_top_decile_penalty
    assert atr_regime(candles_with_ranges([1.0] * 20), P).action is FilterAction.PASS


# --- объём, сессия -----------------------------------------------------------------------


def test_volume_filter_tiers() -> None:
    c = make_candles(30)
    strong = [
        *c[:-1],
        Candle(c[-1].open_time, c[-1].open, c[-1].high, c[-1].low, c[-1].close, Decimal(20)),
    ]
    assert volume_filter(strong, 29, P).score_delta == P.volume_strong_bonus
    weak = [
        *c[:-1],
        Candle(c[-1].open_time, c[-1].open, c[-1].high, c[-1].low, c[-1].close, Decimal(13)),
    ]
    assert volume_filter(weak, 29, P).score_delta == P.volume_weak_bonus
    low = volume_filter(c, 29, P)
    assert low.score_delta == -P.volume_penalty and low.action is FilterAction.PASS
    assert volume_filter(c, 0, P).score_delta == 0


def test_session_label_and_weekend_penalty() -> None:
    assert session_label(datetime(2024, 1, 1, 3, tzinfo=UTC)) == "asia"
    assert session_label(datetime(2024, 1, 1, 10, tzinfo=UTC)) == "europe"
    assert session_label(datetime(2024, 1, 1, 15, tzinfo=UTC)) == "us"
    assert session_label(datetime(2024, 1, 1, 22, tzinfo=UTC)) == "late_us"
    c = make_candles(40, start=datetime(2024, 1, 1, tzinfo=UTC))  # индекс 30 = суббота 06.01 00:00
    sat = c[30]
    assert sat.open_time.weekday() == 5
    quiet = [
        *c[:30],
        Candle(sat.open_time, sat.open, sat.high, sat.low, sat.close, Decimal(1)),
        *c[31:],
    ]
    res = session_filter(quiet, 30, P)
    assert res.score_delta == -P.weekend_penalty
    assert session_filter(c, 30, P).score_delta == 0
    assert session_filter(c, 1, P).data["session"] == "asia"


# --- свежий CHoCH ------------------------------------------------------------------------


def path(closes: list[float]) -> list[Candle]:
    return [
        Candle(
            T0 + H4 * i,
            Decimal(str(c)),
            Decimal(str(c + 1)),
            Decimal(str(c - 1)),
            Decimal(str(c)),
            Decimal(1),
        )
        for i, c in enumerate(closes)
    ]


UPTREND = [100, 101, 101.5, 102, 101, 99, 98, 100, 103, 105, 104, 102, 101, 103, 106, 108, 109]


def test_fresh_choch_blocks_until_bos_restores() -> None:
    closes = [*UPTREND, 107, 104, 99, 97]  # CHoCH вниз на последней свече
    s = analyze_structure(path(closes), StructureParams())
    last = len(closes) - 1
    assert fresh_choch(s, Direction.UP, last, P).action is FilterAction.BLOCK
    assert fresh_choch(s, Direction.DOWN, last, P).action is FilterAction.PASS
    assert fresh_choch(s, Direction.UP, last + P.choch_lookback, P).action is FilterAction.PASS


# --- новости -----------------------------------------------------------------------------


def test_news_defer_soon_penalty_and_pass() -> None:
    fomc = CalendarEvent(T0 + timedelta(hours=10), "FOMC", 3)
    assert news_filter([fomc], T0 + timedelta(hours=9), P).action is FilterAction.DEFER
    assert news_filter([fomc], T0 + timedelta(hours=10, minutes=30), P).action is FilterAction.DEFER
    soon = news_filter([fomc], T0, P)
    assert soon.action is FilterAction.PASS and soon.score_delta == -P.news_soon_penalty
    assert news_filter([fomc], T0 + timedelta(hours=12), P).score_delta == 0
    minor = CalendarEvent(T0 + timedelta(hours=10), "PMI", 2)
    assert news_filter([minor], T0 + timedelta(hours=9), P).action is FilterAction.PASS


# --- корреляция, оборот ------------------------------------------------------------------


def test_correlation_filter() -> None:
    against = correlation_filter("ETHUSDT", Direction.UP, [], Direction.DOWN, P)
    assert against.action is FilterAction.BLOCK
    btc_itself = correlation_filter("BTCUSDT", Direction.UP, [], Direction.DOWN, P)
    assert btc_itself.action is FilterAction.PASS
    active = [ActiveSignalRef("ETHUSDT", Direction.UP, Decimal("0.9"))]
    flagged = correlation_filter("SOLUSDT", Direction.UP, active, Direction.UP, P)
    assert flagged.action is FilterAction.FLAG and flagged.risk_multiplier == Decimal("0.5")
    weak = [ActiveSignalRef("ETHUSDT", Direction.UP, Decimal("0.5"))]
    assert correlation_filter("SOLUSDT", Direction.UP, weak, None, P).action is FilterAction.PASS


def test_turnover_filter() -> None:
    assert turnover_filter(Decimal(10_000_000), P).action is FilterAction.BLOCK
    assert turnover_filter(Decimal(90_000_000), P).action is FilterAction.PASS
    assert turnover_filter(None, P).action is FilterAction.PASS


# --- деривативы --------------------------------------------------------------------------


def funding_series(rates: list[str]) -> list[FundingRate]:
    return [FundingRate(T0 + timedelta(hours=8 * i), Decimal(r)) for i, r in enumerate(rates)]


def test_funding_filter_bonus_block_neutral() -> None:
    at = T0 + timedelta(days=30)
    neutral = funding_series(["0.0001"] * 90)
    assert funding_filter(neutral, at, Direction.UP, P).score_delta == 0
    contrarian = funding_series([*(["0.0001"] * 89), "-0.0002"])
    assert funding_filter(contrarian, at, Direction.UP, P).score_delta == P.funding_bonus
    overheated = funding_series([*(["0.0001"] * 89), "0.0008"])
    assert funding_filter(overheated, at, Direction.UP, P).action is FilterAction.BLOCK
    # для шорта тот же экстремально положительный funding — топливо
    assert funding_filter(overheated, at, Direction.DOWN, P).score_delta == P.funding_bonus
    assert funding_filter([], at, Direction.UP, P).action is FilterAction.PASS
    assert funding_filter(overheated, T0 - timedelta(days=1), Direction.UP, P).reason.endswith(
        "нет данных"
    )


def test_open_interest_filter() -> None:
    c = make_candles(40)  # цена растёт
    at = c[-1].close_time(Timeframe.H4)
    rising = [OpenInterest(c[i].open_time, Decimal(100 + i)) for i in range(40)]
    rising.append(OpenInterest(at, Decimal(140)))
    res = open_interest_filter(rising, c, 30, 39, Direction.UP, P)
    assert res.score_delta == P.oi_confirm_bonus
    falling = [OpenInterest(c[i].open_time, Decimal(200 - i)) for i in range(40)]
    falling.append(OpenInterest(at, Decimal(160)))
    res = open_interest_filter(falling, c, 30, 39, Direction.UP, P)
    assert res.score_delta == -P.oi_squeeze_penalty
    small = [OpenInterest(c[i].open_time, Decimal(100)) for i in range(40)]
    assert open_interest_filter(small, c, 30, 39, Direction.UP, P).score_delta == 0
    assert open_interest_filter([], c, 30, 39, Direction.UP, P).action is FilterAction.PASS


def test_open_interest_accumulation_flag() -> None:
    flat = candles_with_ranges([1.0] * 40, volume=10)
    at = flat[-1].close_time(Timeframe.H4)
    oi = [OpenInterest(flat[i].open_time, Decimal(100)) for i in range(35)]
    oi += [OpenInterest(flat[i].open_time, Decimal(120)) for i in range(35, 40)]
    oi.append(OpenInterest(at, Decimal(120)))
    res = open_interest_filter(oi, flat, 30, 39, Direction.UP, P)
    assert res.action is FilterAction.FLAG and "каскада" in res.reason


def test_liquidation_filter() -> None:
    at = T0 + H4 * 40
    calm = [LiquidationBucket(T0 + H4 * i, Decimal(100), Decimal(100)) for i in range(40)]
    assert liquidation_filter(calm, at, Direction.UP, P).score_delta == 0
    cascade = [*calm[:-1], LiquidationBucket(calm[-1].time, Decimal(500), Decimal(100))]
    assert liquidation_filter(cascade, at, Direction.UP, P).score_delta == P.liq_bonus
    assert liquidation_filter(cascade, at, Direction.DOWN, P).score_delta == 0
    assert liquidation_filter(calm[:5], at, Direction.UP, P).action is FilterAction.PASS
    zeros = [LiquidationBucket(T0 + H4 * i, Decimal(0), Decimal(0)) for i in range(40)]
    assert "нет базы" in liquidation_filter(zeros, at, Direction.UP, P).reason


def test_long_short_filter() -> None:
    at = T0 + timedelta(hours=1)
    crowded = [LongShortRatio(T0, Decimal("0.7"))]
    assert long_short_filter(crowded, at, Direction.UP, P).score_delta == -P.crowd_penalty
    assert long_short_filter(crowded, at, Direction.DOWN, P).score_delta == 0
    assert long_short_filter([], at, Direction.UP, P).action is FilterAction.PASS


def test_token_events_filter() -> None:
    unlock = TokenEvent(T0 + timedelta(hours=48), "unlock", Decimal("0.02"))
    assert token_events_filter([unlock], T0, Direction.UP, P).action is FilterAction.BLOCK
    assert token_events_filter([unlock], T0, Direction.DOWN, P).action is FilterAction.FLAG
    far = TokenEvent(T0 + timedelta(hours=100), "unlock", Decimal("0.02"))
    assert token_events_filter([far], T0, Direction.UP, P).action is FilterAction.PASS
    tiny = TokenEvent(T0 + timedelta(hours=48), "unlock", Decimal("0.001"))
    assert token_events_filter([tiny], T0, Direction.UP, P).action is FilterAction.PASS


# --- сводка и утилиты --------------------------------------------------------------------


def test_run_filters_summary() -> None:
    at = T0 + timedelta(hours=1)
    results = [
        token_events_filter(
            [TokenEvent(T0 + timedelta(hours=48), "unlock", Decimal("0.02"))], T0, Direction.UP, P
        ),
        long_short_filter([LongShortRatio(T0, Decimal("0.7"))], at, Direction.UP, P),
        correlation_filter(
            "SOLUSDT",
            Direction.UP,
            [ActiveSignalRef("ETHUSDT", Direction.UP, Decimal("0.9"))],
            None,
            P,
        ),
        news_filter([CalendarEvent(at, "CPI", 3)], at, P),
    ]
    summary = run_filters(results)
    assert summary.blocked and summary.deferred
    assert summary.score_delta == -P.crowd_penalty - P.correlation_penalty
    assert summary.risk_multiplier == Decimal("0.5")
    assert len(summary.flags) == 1 and len(summary.block_reasons) == 1


def test_upto_and_params_validation() -> None:
    rows = funding_series(["0.0001"] * 3)
    assert len(upto(rows, T0 + timedelta(hours=8))) == 2
    with pytest.raises(ValueError):
        FilterParams(atr_low_pct=Decimal("0.9"), atr_high_pct=Decimal("0.1"))
