from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime
from decimal import Decimal

import pytest

from engine.candles import Candle, Timeframe
from engine.params import ZoneParams
from engine.structure import Direction, EventType, analyze_structure
from engine.zones import Zone, ZoneKind, ZoneStatus, active_zones, analyze_zones


def ohlc(rows: list[tuple[float, float, float, float]]) -> list[Candle]:
    t0 = datetime(2024, 1, 1, tzinfo=UTC)
    return [
        Candle(
            open_time=t0 + Timeframe.H4.delta * i,
            open=Decimal(str(o)),
            high=Decimal(str(h)),
            low=Decimal(str(lo)),
            close=Decimal(str(c)),
            volume=Decimal(1),
        )
        for i, (o, h, lo, c) in enumerate(rows)
    ]


FLAT = [(100, 101, 99, 100)] * 14  # прогрев ATR, без swing-точек (равные максимумы)
OFF = len(FLAT)
# swing high на 2 (105), swing low на 5 (97), OB — медвежья свеча 6, BOS на 9 (107 > 105)
SCENARIO = [
    (100, 102, 98, 101),
    (101, 103, 99, 102),
    (102, 105, 101, 104),
    (104, 104.5, 100, 101),
    (101, 102, 99, 100),
    (100, 101, 97, 98),
    (99, 99.5, 97.5, 98.8),  # OB и база S/D: тело 0.2 при диапазоне 2
    (98.8, 101, 97.8, 100.5),
    (100.5, 104, 100, 103.5),
    (103.5, 108, 103, 107),  # BOS вверх
]
AFTER = [
    (107, 109, 106, 108),
    (108, 108.5, 99, 100),  # касание зон
    (100, 101, 96, 97),  # закрытие ниже зон — инвалидация
]


def _scenario(extra: list[tuple[float, float, float, float]] | None = None) -> list[Candle]:
    return ohlc([*FLAT, *SCENARIO, *(extra or [])])


def _zones_for_bos(candles: list[Candle], params: ZoneParams | None = None) -> list[Zone]:
    s = analyze_structure(candles)
    bos = [e for e in s.events if e.type is EventType.BOS and e.direction is Direction.UP]
    assert bos and bos[0].index == OFF + 9
    zones = analyze_zones(candles, s, params or ZoneParams())
    return [z for z in zones if z.event_index == OFF + 9]


def test_order_block_is_last_bearish_candle_before_impulse() -> None:
    zones = _zones_for_bos(_scenario())
    ob = next(z for z in zones if z.kind is ZoneKind.OB)
    assert ob.direction is Direction.UP
    assert ob.source_start == ob.source_end == OFF + 6
    assert (ob.bottom, ob.top) == (Decimal("97.5"), Decimal("99"))  # low..open
    assert ob.created_index == OFF + 9 and ob.status is ZoneStatus.ACTIVE


def test_order_block_aggressive_uses_high() -> None:
    zones = _zones_for_bos(_scenario(), ZoneParams(ob_aggressive=True))
    ob = next(z for z in zones if z.kind is ZoneKind.OB)
    assert ob.top == Decimal("99.5")


def test_supply_demand_base_before_impulse() -> None:
    zones = _zones_for_bos(_scenario())
    sd = next(z for z in zones if z.kind is ZoneKind.SD)
    assert (sd.bottom, sd.top) == (Decimal("97.5"), Decimal("99.5"))
    assert sd.source_start == sd.source_end == OFF + 6
    ob = next(z for z in zones if z.kind is ZoneKind.OB)
    assert ob.overlaps(sd)


def test_supply_demand_requires_impulse() -> None:
    zones = _zones_for_bos(_scenario(), ZoneParams(sd_min_impulse_atr=Decimal("50")))
    assert not [z for z in zones if z.kind is ZoneKind.SD]


def test_fair_value_gaps_inside_impulse() -> None:
    zones = _zones_for_bos(_scenario())
    fvg = sorted((z.bottom, z.top) for z in zones if z.kind is ZoneKind.FVG)
    assert fvg == [(Decimal("99.5"), Decimal("100")), (Decimal("101"), Decimal("103"))]


def test_zone_touched_then_invalidated() -> None:
    candles = _scenario(AFTER)
    zones = _zones_for_bos(candles)
    ob = next(z for z in zones if z.kind is ZoneKind.OB)
    assert ob.touched_index == OFF + 11
    assert ob.invalidated_index == OFF + 12
    assert ob.status is ZoneStatus.INVALIDATED
    assert ob not in active_zones(zones)
    only_touch = _zones_for_bos(_scenario(AFTER[:2]))
    ob2 = next(z for z in only_touch if z.kind is ZoneKind.OB)
    assert ob2.status is ZoneStatus.TOUCHED and ob2 in active_zones(only_touch, Direction.UP)


def test_no_future_leak() -> None:
    candles = _scenario(AFTER)
    s_full = analyze_structure(candles)
    full = analyze_zones(candles, s_full)
    for n in range(1, len(candles) + 1):
        part = analyze_zones(candles[:n], analyze_structure(candles[:n]))
        expected = [
            replace(
                z,
                touched_index=z.touched_index
                if z.touched_index is not None and z.touched_index < n
                else None,
                invalidated_index=(
                    z.invalidated_index
                    if z.invalidated_index is not None and z.invalidated_index < n
                    else None
                ),
            )
            for z in full
            if z.created_index < n
        ]
        assert part == expected


def test_short_direction_mirror() -> None:
    mirrored = [(200 - o, 200 - lo, 200 - h, 200 - c) for (o, h, lo, c) in [*FLAT, *SCENARIO]]
    candles = ohlc(mirrored)
    s = analyze_structure(candles)
    down = [e for e in s.events if e.direction is Direction.DOWN]
    assert down and down[0].index == OFF + 9
    zones = [z for z in analyze_zones(candles, s) if z.event_index == OFF + 9]
    ob = next(z for z in zones if z.kind is ZoneKind.OB)
    assert ob.direction is Direction.DOWN
    assert (ob.bottom, ob.top) == (Decimal("101"), Decimal("102.5"))  # open..high зеркально


def test_zone_helpers_and_params() -> None:
    z = Zone(ZoneKind.OB, Direction.UP, Decimal(10), Decimal(8), 5, 3, 3, 5)
    assert z.mid == Decimal(9) and z.height == Decimal(2)
    assert analyze_zones([], analyze_structure([])) == []
    with pytest.raises(ValueError):
        ZoneParams(sd_base_max_candles=0)
    with pytest.raises(ValueError):
        ZoneParams(sd_body_max_ratio=Decimal(2))
