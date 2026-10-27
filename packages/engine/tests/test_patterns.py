"""Свечные паттерны (план 2A.10.1, 2B.10): синтетика на каждый тип, утечка будущего, replay."""

from __future__ import annotations

import random
from datetime import UTC, datetime
from decimal import Decimal

import pytest

from engine.candles import Candle, Timeframe
from engine.indicators import atr
from engine.liquidity import Sweep
from engine.patterns import (
    DEFAULT_PATTERN_PARAMS,
    PatternParams,
    PatternType,
    detect_last,
    detect_patterns,
    outcome,
    outcomes,
    title,
)
from engine.patterns.context import prior_run
from engine.structure import Direction, MarketStructure, Swing, SwingKind, Trend
from engine.zones import Zone, ZoneKind

T0 = datetime(2024, 1, 1, tzinfo=UTC)
D = Decimal


def c(o: str, h: str, lo: str, cl: str, v: str = "10") -> tuple[str, str, str, str, str]:
    return (o, h, lo, cl, v)


def build(*specs: tuple[str, str, str, str, str], warm: int = 60) -> list[Candle]:
    """Разогрев с дрейфом вверх (тело 1, диапазон 3 → avg_body 1, ATR 3), затем заданные свечи.

    Дрейф нужен, чтобы одинаковые свечи не образовывали внутренние бары.
    """
    rows = [
        c(
            f"{100 + i / 1000:.3f}",
            f"{102 + i / 1000:.3f}",
            f"{99 + i / 1000:.3f}",
            f"{101 + i / 1000:.3f}",
        )
        for i in range(warm)
    ] + list(specs)
    return [
        Candle(T0 + Timeframe.H4.delta * i, D(o), D(h), D(lo), D(cl), D(v))
        for i, (o, h, lo, cl, v) in enumerate(rows)
    ]


DECLINE = [
    c("100", "100.5", "98.5", "99"),
    c("99", "99.5", "97.5", "98"),
    c("98", "98.5", "96.5", "97"),
]
RISE = [
    c("101", "102.5", "100.5", "102"),
    c("102", "103.5", "101.5", "103"),
    c("103", "104.5", "102.5", "104"),
]


def last_of(candles: list[Candle], type_: PatternType, **kw: object):
    found = [
        m for m in detect_patterns(candles, **kw) if m.type is type_ and m.index == len(candles) - 1
    ]  # type: ignore[arg-type]
    assert len(found) == 1, f"ожидали один {type_}, нашли {found}"
    return found[0]


def test_warmup_and_empty() -> None:
    assert detect_patterns([]) == []
    assert DEFAULT_PATTERN_PARAMS.warmup == 53
    assert detect_patterns(build(warm=10)) == []


def test_engulfing_bullish_after_decline_with_volume() -> None:
    cs = build(*DECLINE, c("97", "97.2", "96.3", "96.4"), c("96.4", "98", "96.2", "97.8", "20"))
    m = last_of(cs, PatternType.ENGULFING)
    assert m.direction is Direction.UP
    assert m.start_index == len(cs) - 2
    assert m.context.prior_run <= -3
    assert m.context.volume_ratio == D(2)
    assert m.significant is True
    assert m.price == D("96.2")
    assert m.title == "Бычье поглощение"
    assert m.rules_version == "candles@1.0.0"
    assert m.atr == atr(cs, 14)[m.index]


def test_engulfing_without_volume_is_found_but_not_significant() -> None:
    cs = build(*DECLINE, c("97", "97.2", "96.3", "96.4"), c("96.4", "98", "96.2", "97.8"))
    assert last_of(cs, PatternType.ENGULFING).significant is False


def test_engulfing_bearish_and_small_body_rejected() -> None:
    cs = build(
        *RISE, c("104", "104.6", "103.8", "104.5"), c("104.6", "104.7", "102.9", "103", "20")
    )
    m = last_of(cs, PatternType.ENGULFING)
    assert m.direction is Direction.DOWN and m.significant and m.price == D("104.7")
    small = build(
        *RISE, c("104", "104.6", "103.8", "104.5"), c("104.6", "104.7", "103.3", "103.6", "20")
    )
    assert not [m for m in detect_patterns(small) if m.type is PatternType.ENGULFING]


def test_pin_bar_hammer_with_sweep_or_pierce() -> None:
    cs = build(c("100", "100.8", "97", "100.6"))
    i = len(cs) - 1
    m = last_of(cs, PatternType.PIN_BAR)
    assert m.direction is Direction.UP and m.significant is False
    sweep = Sweep(
        index=i, time=cs[i].open_time, kind=SwingKind.LOW, level=D(98), extreme=D(97), swing_index=5
    )
    assert last_of(cs, PatternType.PIN_BAR, sweeps=[sweep]).context.sweep is True
    assert last_of(cs, PatternType.PIN_BAR, sweeps=[sweep]).significant is True
    wrong = Sweep(
        index=i,
        time=cs[i].open_time,
        kind=SwingKind.HIGH,
        level=D(98),
        extreme=D(97),
        swing_index=5,
    )
    assert last_of(cs, PatternType.PIN_BAR, sweeps=[wrong]).context.sweep is False
    pierced = last_of(cs, PatternType.PIN_BAR, levels=[D(98)])
    assert pierced.context.pierced is True and pierced.significant is True
    a = atr(cs, 14)[i]
    assert a is not None and pierced.context.level_distance_atr == D(1) / a


def test_pin_bar_shooting_star_after_rise() -> None:
    cs = build(*RISE, c("104", "107", "103.8", "104.6"))
    m = last_of(cs, PatternType.PIN_BAR)
    assert m.direction is Direction.DOWN and m.context.prior_run >= 3 and m.significant
    assert m.title == "Падающая звезда (пин-бар)"


def test_doji_variants_and_near_zone() -> None:
    plain = last_of(build(c("100", "102", "98", "100.1")), PatternType.DOJI)
    assert plain.direction is None and plain.significant is False and plain.price == D("100.1")
    assert last_of(build(c("100", "100.2", "97", "100.1")), PatternType.DOJI_DRAGONFLY)
    assert last_of(build(c("100", "103", "99.9", "100.1")), PatternType.DOJI_GRAVESTONE)
    # маленький диапазон — не доджи, тело 0.05 от диапазона 1 — и не пин-бар
    small = detect_patterns(build(c("100", "100.6", "99.6", "100.05")))
    assert {m.type for m in small} == {PatternType.INSIDE_BAR}
    cs = build(c("100", "102", "98", "100.1"))
    zone = Zone(
        ZoneKind.OB,
        Direction.UP,
        D("100.5"),
        D("99.5"),
        created_index=10,
        source_start=8,
        source_end=9,
        event_index=10,
    )
    m = last_of(cs, PatternType.DOJI, zones=[zone])
    assert m.context.zone_distance_atr == D(0) and m.significant is True
    later = Zone(
        ZoneKind.OB,
        Direction.UP,
        D("100.5"),
        D("99.5"),
        created_index=len(cs),
        source_start=8,
        source_end=9,
        event_index=10,
    )
    assert last_of(cs, PatternType.DOJI, zones=[later]).context.zone_distance_atr is None


def test_morning_and_evening_star() -> None:
    cs = build(
        *DECLINE,
        c("97", "97.2", "95.7", "95.8"),
        c("95.8", "96", "95.4", "95.6"),
        c("95.6", "97.2", "95.3", "96.9", "12"),
    )
    m = last_of(cs, PatternType.STAR)
    assert m.direction is Direction.UP and m.significant is True and m.start_index == len(cs) - 3
    assert m.title == "Утренняя звезда"
    quiet = build(
        *DECLINE,
        c("97", "97.2", "95.7", "95.8"),
        c("95.8", "96", "95.4", "95.6"),
        c("95.6", "97.2", "95.3", "96.9", "5"),
    )
    assert last_of(quiet, PatternType.STAR).significant is False
    ev = build(
        *RISE,
        c("104", "105.4", "103.8", "105.2"),
        c("105.2", "105.6", "105", "105.4"),
        c("105.4", "105.5", "103.9", "104.1"),
    )
    assert last_of(ev, PatternType.STAR).direction is Direction.DOWN


def test_three_soldiers_crows_and_overheat() -> None:
    cs = build(
        c("100", "101.2", "99.8", "101"),
        c("101", "102.2", "100.8", "102"),
        c("102", "103.2", "101.8", "103"),
    )
    m = last_of(cs, PatternType.THREE_LINE)
    assert m.direction is Direction.UP and m.context.overheat is False and m.significant is False
    assert last_of(cs, PatternType.THREE_LINE, levels=[D("99.9")]).significant is True
    hot = build(
        c("100", "104.2", "99.8", "104"),
        c("104", "108.2", "103.8", "108"),
        c("108", "112.2", "107.8", "112"),
    )
    assert last_of(hot, PatternType.THREE_LINE).context.overheat is True
    crows = build(
        c("101", "101.2", "99.8", "100"),
        c("100", "100.2", "98.8", "99"),
        c("99", "99.2", "97.8", "98"),
    )
    assert last_of(crows, PatternType.THREE_LINE).direction is Direction.DOWN
    # верхняя тень длиннее 0.3 тела — не солдаты
    tail = build(
        c("100", "101.6", "99.8", "101"),
        c("101", "102.2", "100.8", "102"),
        c("102", "103.2", "101.8", "103"),
    )
    assert not [m for m in detect_patterns(tail) if m.type is PatternType.THREE_LINE]


def test_harami_and_inside_bar_are_neutral() -> None:
    cs = build(c("100", "102", "99", "101.5"), c("100.5", "101", "100", "100.8"))
    h = last_of(cs, PatternType.HARAMI)
    ib = last_of(cs, PatternType.INSIDE_BAR)
    assert h.direction is None and h.significant is False
    assert ib.direction is None and ib.significant is False and ib.price == D("100.8")
    # тело 1 меньше 1.2 avg_body — харами нет, внутренний бар есть
    cs2 = build(c("100", "102", "99", "101"), c("100.5", "101", "100", "100.8"))
    assert not [m for m in detect_patterns(cs2) if m.type is PatternType.HARAMI]
    assert last_of(cs2, PatternType.INSIDE_BAR)


def test_inside_bar_breakout() -> None:
    cs = build(
        c("100", "102", "99", "101.5"),
        c("100.5", "101", "100", "100.8"),
        c("100.8", "102.8", "100.3", "102.5", "15"),
    )
    m = last_of(cs, PatternType.INSIDE_BAR_BREAKOUT)
    assert m.direction is Direction.UP and m.significant is True and m.start_index == len(cs) - 3
    down = build(
        c("100", "102", "99", "101.5"),
        c("100.5", "101", "100", "100.8"),
        c("100.8", "101", "98.5", "98.7"),
    )
    d = last_of(down, PatternType.INSIDE_BAR_BREAKOUT)
    assert d.direction is Direction.DOWN and d.significant is False
    none = build(
        c("100", "102", "99", "101.5"),
        c("100.5", "101", "100", "100.8"),
        c("100.8", "101.9", "99.1", "101"),
    )
    assert not [m for m in detect_patterns(none) if m.type is PatternType.INSIDE_BAR_BREAKOUT]


def test_marubozu_pierces_level() -> None:
    cs = build(c("100", "102.05", "99.95", "102"))
    m = last_of(cs, PatternType.MARUBOZU)
    assert m.direction is Direction.UP and m.significant is False
    assert last_of(cs, PatternType.MARUBOZU, levels=[D(101)]).significant is True
    zone = Zone(
        ZoneKind.SD,
        Direction.DOWN,
        D("101.5"),
        D("100.5"),
        created_index=10,
        source_start=8,
        source_end=9,
        event_index=10,
    )
    assert last_of(cs, PatternType.MARUBOZU, zones=[zone]).context.pierced is True
    bear = build(c("102", "102.05", "99.95", "100"))
    assert last_of(bear, PatternType.MARUBOZU).direction is Direction.DOWN
    assert not [
        m
        for m in detect_patterns(build(c("100", "102.5", "99.5", "102")))
        if m.type is PatternType.MARUBOZU
    ]


def test_tweezer_bottom_and_top() -> None:
    cs = build(c("100", "100.2", "98", "99"), c("99", "100.2", "98.2", "100"))
    m = last_of(cs, PatternType.TWEEZER)
    assert m.direction is Direction.UP and m.significant is False and m.price == D(98)
    assert last_of(cs, PatternType.TWEEZER, levels=[D("98.1")]).significant is True
    top = build(c("99", "101", "98.8", "100"), c("100", "101.2", "98.9", "99.2"))
    assert last_of(top, PatternType.TWEEZER).direction is Direction.DOWN
    far = build(c("100", "100.2", "97.5", "99"), c("99", "100.2", "98.2", "100"))
    assert not [m for m in detect_patterns(far) if m.type is PatternType.TWEEZER]
    same = build(c("99", "100.2", "98", "100"), c("100", "101.2", "98.2", "101"))
    assert not [m for m in detect_patterns(same) if m.type is PatternType.TWEEZER]


def test_context_trend_ema_and_htf() -> None:
    cs = build(c("100", "100.8", "97", "100.6"))
    n = len(cs)
    swings = [
        Swing(5, cs[5].open_time, D(90), SwingKind.LOW, 7),
        Swing(10, cs[10].open_time, D(110), SwingKind.HIGH, 12),
        Swing(15, cs[15].open_time, D(95), SwingKind.LOW, 17),
        Swing(20, cs[20].open_time, D(115), SwingKind.HIGH, 22),
    ]
    st = MarketStructure(swings=swings)
    m = last_of(cs, PatternType.PIN_BAR, structure=st, htf_trend=Trend.DOWN)
    assert m.context.trend is Trend.UP and m.context.htf_trend is Trend.DOWN
    assert m.context.above_ema is False  # EMA50 ≈ 101, закрытие 100.6
    # swing, подтверждённый позже закрытия паттерна, не учитывается
    future = MarketStructure(
        swings=[*swings, Swing(n - 1, cs[-1].open_time, D(80), SwingKind.LOW, n + 1)]
    )
    assert last_of(cs, PatternType.PIN_BAR, structure=future).context.trend is Trend.UP


def test_prior_run() -> None:
    cs = build(*DECLINE, c("97", "98", "96", "97.5"))
    assert prior_run(cs, len(cs) - 1) == -3  # 99 → 98 → 97, до этого разогрев рос
    assert prior_run(cs, 1) == 0
    assert prior_run(cs, 5) == 4  # разогрев: четыре шага роста перед индексом 5


def random_walk(n: int, seed: int = 7) -> list[Candle]:
    rng = random.Random(seed)
    out: list[Candle] = []
    price = 100.0
    for i in range(n):
        o = price
        cl = o * (1 + rng.uniform(-0.03, 0.03))
        h = max(o, cl) * (1 + rng.uniform(0, 0.02))
        lo = min(o, cl) * (1 - rng.uniform(0, 0.02))
        v = rng.uniform(5, 30)
        out.append(
            Candle(
                T0 + Timeframe.H4.delta * i,
                D(f"{o:.4f}"),
                D(f"{h:.4f}"),
                D(f"{lo:.4f}"),
                D(f"{cl:.4f}"),
                D(f"{v:.2f}"),
            )
        )
        price = cl
    return out


def test_no_future_leak_and_replay() -> None:
    cs = random_walk(400)
    full = detect_patterns(cs)
    assert len({m.type for m in full}) >= 6, "случайный ряд должен дать разнообразные паттерны"
    assert detect_patterns(cs) == full, "детерминизм"
    for k in (120, 200, 333, 399):
        prefix = detect_patterns(cs[: k + 1])
        assert prefix == [m for m in full if m.index <= k], f"утечка будущего на префиксе {k}"
    last = detect_last(cs)
    assert last == [m for m in full if m.index == len(cs) - 1]
    assert detect_last([]) == []
    assert detect_patterns(cs, since=300) == [m for m in full if m.index >= 300]


def test_outcomes() -> None:
    cs = build(*DECLINE, c("97", "97.2", "96.3", "96.4"), c("96.4", "98", "96.2", "97.8", "20"))
    m = last_of(cs, PatternType.ENGULFING)
    a = atr(cs, 14)[m.index]
    assert a is not None
    pending = outcome(cs, m, 3, a)
    assert pending.hit is None and pending.max_favorable_atr is None
    after = cs + [
        Candle(
            cs[-1].open_time + Timeframe.H4.delta * (i + 1),
            D("97.8"),
            D(str(98 + 2 * i)),
            D("97"),
            D(str(97.9 + 1.5 * i)),
            D(10),
        )
        for i in range(5)
    ]
    o3 = outcome(after, m, 3, a)
    assert o3.hit is True and o3.max_favorable_atr is not None and o3.max_favorable_atr >= 1
    assert o3.max_adverse_atr == (D("97.8") - D(97)) / a
    res = outcomes(after, m, a)
    assert [r.horizon for r in res] == [3, 5, 10] and res[2].hit is None
    assert outcome(after, m, 3, D(0)).hit is None
    # без направления — только ходы
    dj = last_of(build(c("100", "102", "98", "100.1")), PatternType.DOJI)
    djc = build(c("100", "102", "98", "100.1")) + [
        Candle(T0 + Timeframe.H4.delta * (61 + i), D(100), D(103), D(99), D(102), D(10))
        for i in range(3)
    ]
    od = outcome(djc, dj, 3, D(3))
    assert (
        od.hit is None
        and od.max_favorable_atr == (D(103) - D("100.1")) / 3
        and od.max_adverse_atr == (D("100.1") - D(99)) / 3
    )
    bear = last_of(build(*RISE, c("104", "107", "103.8", "104.6")), PatternType.PIN_BAR)
    bc = build(*RISE, c("104", "107", "103.8", "104.6")) + [
        Candle(T0 + Timeframe.H4.delta * (64 + i), D("104.6"), D(105), D(100), D(101), D(10))
        for i in range(3)
    ]
    assert outcome(bc, bear, 3, D(3)).hit is True


def test_params_and_titles() -> None:
    p = PatternParams(rules_version="candles@1.1.0", avg_body_window=30)
    assert p.warmup == 53 and p.rules_version == "candles@1.1.0"
    assert title(PatternType.TWEEZER, Direction.DOWN) == "Пинцет-вершина"
    assert title(PatternType.HARAMI, Direction.UP) == "harami"
    with pytest.raises(AssertionError):
        last_of(build(), PatternType.DOJI)
