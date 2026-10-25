from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

import pytest

from engine.candles import Candle, Timeframe
from engine.params import StructureParams
from engine.structure import (
    Direction,
    EventType,
    SwingKind,
    Trend,
    analyze_structure,
    classify_trend,
)


def path(closes: list[float], spread: float = 1.0) -> list[Candle]:
    """Свечи по списку закрытий: open = close, high = close + spread, low = close - spread."""
    t0 = datetime(2024, 1, 1, tzinfo=UTC)
    out = []
    for i, c in enumerate(closes):
        out.append(
            Candle(
                open_time=t0 + Timeframe.H4.delta * i,
                open=Decimal(str(c)),
                high=Decimal(str(c + spread)),
                low=Decimal(str(c - spread)),
                close=Decimal(str(c)),
                volume=Decimal(1),
            )
        )
    return out


# Зигзаг вверх: пик на 3 (102), дно на 6 (98), пик на 9 (105), дно на 12 (101), пробой на 14+
UPTREND = [100, 101, 101.5, 102, 101, 99, 98, 100, 103, 105, 104, 102, 101, 103, 106, 108, 109]


def test_swings_detected_with_confirmation_delay() -> None:
    s = analyze_structure(path(UPTREND), StructureParams(swing_len=2))
    kinds = [(x.index, x.kind) for x in s.swings]
    assert (3, SwingKind.HIGH) in kinds
    assert (6, SwingKind.LOW) in kinds
    assert (9, SwingKind.HIGH) in kinds
    assert (12, SwingKind.LOW) in kinds
    first_high = next(x for x in s.swings if x.index == 3)
    assert first_high.confirmed_index == 5  # index + swing_len
    assert first_high.price == Decimal("103.0")  # close 102 + spread 1


def test_bos_up_after_close_above_swing_high() -> None:
    s = analyze_structure(path(UPTREND))
    bos = [e for e in s.events if e.direction is Direction.UP]
    assert bos, "ожидался пробой вверх"
    first = bos[0]
    # первый пробой: закрытие 105 на свече 9 выше swing high 103 (свеча 3)
    assert first.index == 9
    assert first.level == Decimal("103.0")
    assert first.broken_swing.index == 3
    assert first.origin_swing is not None and first.origin_swing.kind is SwingKind.LOW
    assert s.direction is Direction.UP
    assert s.trend is Trend.UP


def test_choch_when_close_breaks_last_higher_low() -> None:
    closes = [*UPTREND, 107, 104, 99, 97]  # закрытие 99 < swing low 100 (свеча 12: 101 - 1)
    s = analyze_structure(path(closes))
    down = [e for e in s.events if e.direction is Direction.DOWN]
    assert down and down[0].type is EventType.CHOCH
    assert down[0].broken_swing.index == 12
    assert s.direction is Direction.DOWN
    assert s.last_choch is not None and s.last_choch.index == down[0].index


def test_each_level_broken_once() -> None:
    s = analyze_structure(path(UPTREND))
    levels = [(e.broken_swing.index, e.direction) for e in s.events]
    assert len(levels) == len(set(levels))


def test_first_break_without_direction_is_bos() -> None:
    s = analyze_structure(path(UPTREND))
    assert s.events[0].type is EventType.BOS


def test_no_future_leak() -> None:
    """Результат на префиксе ряда совпадает с префиксом результата на полном ряде."""
    closes = [*UPTREND, 107, 104, 99, 97, 98, 101, 103, 100, 96]
    candles = path(closes)
    full = analyze_structure(candles)
    for n in range(1, len(candles) + 1):
        part = analyze_structure(candles[:n])
        assert part.swings == [s for s in full.swings if s.confirmed_index < n]
        assert part.events == [e for e in full.events if e.index < n]


def test_equal_highs_are_not_swings() -> None:
    closes = [100, 101, 102, 102, 101, 100, 99]
    s = analyze_structure(path(closes), StructureParams(swing_len=1))
    assert all(x.kind is not SwingKind.HIGH or x.index not in (2, 3) for x in s.swings)


def test_classify_trend() -> None:
    assert classify_trend([]) is Trend.FLAT
    s = analyze_structure(path(UPTREND))
    assert classify_trend(s.swings) is Trend.UP
    down = analyze_structure(
        path([110, 108, 106, 107, 108, 105, 102, 100, 101, 102, 99, 96, 94, 95, 96, 93])
    )
    assert down.trend is Trend.DOWN


def test_params_validation() -> None:
    with pytest.raises(ValueError):
        StructureParams(swing_len=0)


def test_empty_and_short_series() -> None:
    assert analyze_structure([]).events == []
    s = analyze_structure(path([100, 101, 102]))
    assert s.swings == [] and s.last_bos is None and s.last_event is None
