from __future__ import annotations

from decimal import Decimal

import pytest

from engine.params import ScoringParams
from engine.scoring import Grade, ScoreInput, grade_for, score_signal
from engine.structure import Trend
from engine.zones import ZoneKind

D = Decimal


def inp(**kw: object) -> ScoreInput:
    base: dict[str, object] = {
        "w1_trend": Trend.UP,
        "signal_up": True,
        "bos_strength_atr": D("0.4"),
        "zone_kinds": frozenset({ZoneKind.OB, ZoneKind.SD, ZoneKind.FVG}),
        "sweep_before_entry": True,
        "volume_ratio": D("1.6"),
        "rr_tp2": D("3.2"),
        "obstacle_before_tp1": False,
        "filter_delta": 0,
    }
    base.update(kw)
    return ScoreInput(**base)  # type: ignore[arg-type]


def test_perfect_setup_is_grade_a() -> None:
    s = score_signal(inp())
    assert s.components == {
        "w1_agreement": 15,
        "bos_strength": 15,
        "zone_quality": 20,
        "sweep": 15,
        "volume": 10,
        "rr": 15,
        "no_obstacles": 10,
        "filters": 0,
    }
    assert s.total == 100 and s.grade is Grade.A and s.publishable


def test_tiers_and_partial_credit() -> None:
    s = score_signal(
        inp(
            w1_trend=Trend.FLAT,
            bos_strength_atr=D("0.2"),
            zone_kinds=frozenset({ZoneKind.OB}),
            sweep_before_entry=False,
            volume_ratio=D("1.3"),
            rr_tp2=D("2.6"),
            obstacle_before_tp1=True,
        )
    )
    assert s.components["w1_agreement"] == 7
    assert s.components["bos_strength"] == 8
    assert s.components["zone_quality"] == 6
    assert s.components["volume"] == 5 and s.components["rr"] == 10
    assert s.components["no_obstacles"] == 0
    assert s.total == 36 and s.grade is Grade.NONE and not s.publishable


def test_w1_against_gives_zero_and_short_mirror() -> None:
    assert score_signal(inp(w1_trend=Trend.DOWN)).components["w1_agreement"] == 0
    assert score_signal(inp(signal_up=False, w1_trend=Trend.DOWN)).components["w1_agreement"] == 15


def test_filters_delta_clamped_and_total_bounded() -> None:
    s = score_signal(inp(filter_delta=60))
    assert s.components["filters"] == 25 and s.total == 100
    s2 = score_signal(inp(filter_delta=-80))
    assert s2.components["filters"] == -45 and s2.total == 55 and s2.grade is Grade.B
    s3 = score_signal(
        inp(zone_kinds=frozenset(), volume_ratio=None, filter_delta=-45, w1_trend=Trend.DOWN)
    )
    assert s3.total == 10 and s3.grade is Grade.NONE


def test_zone_two_kinds_and_weak_bos() -> None:
    s = score_signal(
        inp(zone_kinds=frozenset({ZoneKind.OB, ZoneKind.FVG}), bos_strength_atr=D("0.05"))
    )
    assert s.components["zone_quality"] == 12 and s.components["bos_strength"] == 0


def test_grade_thresholds_and_params() -> None:
    assert grade_for(75) is Grade.A and grade_for(74) is Grade.B
    assert grade_for(55) is Grade.B and grade_for(54) is Grade.C
    assert grade_for(40) is Grade.C and grade_for(39) is Grade.NONE
    with pytest.raises(ValueError):
        ScoringParams(grade_a=50)


def test_pattern_component_only_when_enabled() -> None:
    from engine.params import ScoringParams
    from engine.scoring import ScoreInput, score_signal
    from engine.structure import Trend
    from engine.zones import ZoneKind

    base = dict(
        w1_trend=Trend.UP,
        signal_up=True,
        bos_strength_atr=Decimal("0.5"),
        zone_kinds=frozenset({ZoneKind.OB}),
        sweep_before_entry=False,
        volume_ratio=None,
        rr_tp2=Decimal(2),
        obstacle_before_tp1=False,
        filter_delta=0,
    )
    off = score_signal(ScoreInput(**base, pattern_on_signal_candle=True))
    assert "pattern" not in off.components
    on = score_signal(
        ScoreInput(**base, pattern_on_signal_candle=True), ScoringParams(pattern_points=5)
    )
    assert on.components["pattern"] == 5 and on.total == off.total + 5
    none = score_signal(
        ScoreInput(**base, pattern_on_signal_candle=False), ScoringParams(pattern_points=5)
    )
    assert none.components["pattern"] == 0 and none.total == off.total
