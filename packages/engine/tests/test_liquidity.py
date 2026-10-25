from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

import pytest

from engine.candles import Candle, Timeframe
from engine.liquidity import find_equal_levels, find_sweeps, period_levels
from engine.params import LiquidityParams, StructureParams
from engine.structure import SwingKind, analyze_structure


def ohlc(
    rows: list[tuple[float, float, float, float]], tf: Timeframe = Timeframe.H4
) -> list[Candle]:
    t0 = datetime(2024, 1, 1, tzinfo=UTC)
    return [
        Candle(
            open_time=t0 + tf.delta * i,
            open=Decimal(str(o)),
            high=Decimal(str(h)),
            low=Decimal(str(lo)),
            close=Decimal(str(c)),
            volume=Decimal(1),
        )
        for i, (o, h, lo, c) in enumerate(rows)
    ]


def flat(n: int) -> list[tuple[float, float, float, float]]:
    return [(100, 101, 99, 100)] * n


P = StructureParams(swing_len=1)
LP = LiquidityParams(equal_tolerance_atr=Decimal("0.5"))  # ATR ≈ 2 → допуск ≈ 1


# два минимума 95.0 и 95.4 (разница < 1), потом свеча хвостом под них с закрытием выше
EQUAL_LOWS = [
    *flat(14),
    (100, 101, 97, 98),
    (98, 99, 95, 97),  # swing low 95 (idx 15)
    (97, 100, 96, 99),
    (99, 100, 96, 97),
    (97, 98, 95.4, 96),  # swing low 95.4 (idx 18) → равные минимумы
    (96, 99, 95.6, 98),  # подтверждает swing 18 (len=1)
    (98, 99, 94, 98.5),  # sweep: low 94 < 95.4, close 98.5 выше (idx 20)
    (98.5, 102, 98, 101),
]


def test_equal_lows_detected_and_swept() -> None:
    candles = ohlc(EQUAL_LOWS)
    s = analyze_structure(candles, P)
    levels = find_equal_levels(s.swings, candles, LP)
    lows = [lv for lv in levels if lv.kind is SwingKind.LOW]
    assert len(lows) == 1
    lv = lows[0]
    assert lv.swing_indices == (15, 18)
    assert lv.price == Decimal("95.2")
    assert lv.confirmed_index == 19
    assert lv.swept_index == 20


def test_equal_levels_respect_tolerance() -> None:
    candles = ohlc(EQUAL_LOWS)
    s = analyze_structure(candles, P)
    strict = find_equal_levels(
        s.swings, candles, LiquidityParams(equal_tolerance_atr=Decimal("0.01"))
    )
    assert not [lv for lv in strict if lv.kind is SwingKind.LOW]


def test_sweep_of_swing_low() -> None:
    candles = ohlc(EQUAL_LOWS)
    s = analyze_structure(candles, P)
    sweeps = find_sweeps(candles, s.swings)
    assert [(x.index, x.kind) for x in sweeps] == [(20, SwingKind.LOW)]
    sw = sweeps[0]
    assert sw.level == Decimal("95.4") and sw.extreme == Decimal("94") and sw.swing_index == 18


def test_close_below_level_is_break_not_sweep() -> None:
    rows = [*EQUAL_LOWS[:20], (98, 99, 94, 94.5), (94.5, 96, 93, 95)]  # закрытие ниже 95.4
    candles = ohlc(rows)
    s = analyze_structure(candles, P)
    assert find_sweeps(candles, s.swings) == []


def test_sweep_of_swing_high_mirror() -> None:
    rows = [(200 - o, 200 - lo, 200 - h, 200 - c) for (o, h, lo, c) in EQUAL_LOWS]
    candles = ohlc(rows)
    s = analyze_structure(candles, P)
    sweeps = find_sweeps(candles, s.swings)
    assert [(x.index, x.kind) for x in sweeps] == [(20, SwingKind.HIGH)]
    assert sweeps[0].extreme == Decimal("106")


def test_no_future_leak() -> None:
    candles = ohlc(EQUAL_LOWS)
    full_s = analyze_structure(candles, P)
    full_levels = find_equal_levels(full_s.swings, candles, LP)
    full_sweeps = find_sweeps(candles, full_s.swings)
    for n in range(1, len(candles) + 1):
        part = candles[:n]
        s = analyze_structure(part, P)
        levels = find_equal_levels(s.swings, part, LP)
        expected = [
            (
                lv.swing_indices,
                lv.swept_index if lv.swept_index is not None and lv.swept_index < n else None,
            )
            for lv in full_levels
            if lv.confirmed_index < n
        ]
        assert [(lv.swing_indices, lv.swept_index) for lv in levels] == expected
        assert find_sweeps(part, s.swings) == [x for x in full_sweeps if x.index < n]


def test_period_levels() -> None:
    d1 = ohlc([(100, 110, 90, 105), (105, 120, 100, 115), (115, 118, 108, 110)], Timeframe.D1)
    w1 = ohlc([(100, 130, 80, 120), (120, 140, 110, 125)], Timeframe.W1)
    # 3 января 2024 (среда) 08:00 → предыдущий день 2 января, предыдущая неделя — с 1 января? нет:
    # неделя 1 января ещё идёт, предыдущая закрытая — та, что закрылась 1 января 00:00
    at = datetime(2024, 1, 3, 8, tzinfo=UTC)
    lv = period_levels(at, d1, w1)
    assert (lv.pdh, lv.pdl) == (Decimal(120), Decimal(100))
    assert (lv.pwh, lv.pwl) == (None, None)  # первая недельная свеча открылась 1 января, ещё идёт
    at2 = datetime(2024, 1, 10, 0, tzinfo=UTC)  # среда следующей недели
    lv2 = period_levels(at2, d1, w1)
    assert (lv2.pwh, lv2.pwl) == (Decimal(130), Decimal(80))
    assert period_levels(at) == period_levels(at, [], [])


def test_params_validation() -> None:
    with pytest.raises(ValueError):
        LiquidityParams(equal_tolerance_atr=Decimal(0))
