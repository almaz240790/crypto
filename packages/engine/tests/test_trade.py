from __future__ import annotations

from decimal import Decimal

import pytest

from engine.params import TradeParams
from engine.structure import Direction
from engine.trade import TradeRejection, TradeSetup, build_trade
from engine.zones import Zone, ZoneKind

D = Decimal
ATR = D(2)
# зона спроса 97.5–99, закрытие 100 → стоп 97.5 − max(0.5, 0.15) = 97, риск 3
LONG_ZONE = Zone(ZoneKind.OB, Direction.UP, D("99"), D("97.5"), 9, 6, 6, 9)
SHORT_ZONE = Zone(ZoneKind.OB, Direction.DOWN, D("102.5"), D("101"), 9, 6, 6, 9)


def test_long_setup_with_structural_targets() -> None:
    setup = build_trade(Direction.UP, LONG_ZONE, D(100), ATR, [D(101), D(107), D(112)])
    assert isinstance(setup, TradeSetup)
    assert setup.stop_loss == D("97") and setup.risk == D(3)
    assert setup.entry_limit == D("98.25")
    assert setup.tp1 == D(103)
    assert setup.tp2 == D(107)  # 2.33 R — в окне [1.8; 3]
    assert setup.tp3 == D(112)  # следующий уровень (4 R) ближе или равен 4 R
    assert setup.rr_tp2 == D(7) / D(3)
    assert setup.r_at(D(103)) == D(1) and setup.r_at(D(97)) == D(-1)


def test_tp3_defaults_to_4r_when_next_level_is_farther() -> None:
    setup = build_trade(Direction.UP, LONG_ZONE, D(100), ATR, [D(107), D(120)])
    assert isinstance(setup, TradeSetup) and setup.tp3 == D(112)


def test_no_levels_in_window_uses_3r() -> None:
    setup = build_trade(Direction.UP, LONG_ZONE, D(100), ATR, [D(120)])
    assert isinstance(setup, TradeSetup)
    assert setup.tp2 == D(109) and setup.rr_tp2 == D(3)
    assert any("уровня в окне нет" in n for n in setup.notes)
    empty = build_trade(Direction.UP, LONG_ZONE, D(100), ATR, [])
    assert isinstance(empty, TradeSetup) and any(
        "уровней по направлению нет" in n for n in empty.notes
    )


def test_reject_when_nearest_level_too_close() -> None:
    rej = build_trade(Direction.UP, LONG_ZONE, D(100), ATR, [D(104)])  # 1.33 R
    assert isinstance(rej, TradeRejection) and "ближе" in rej.reason


def test_reject_wide_stop() -> None:
    rej = build_trade(Direction.UP, LONG_ZONE, D(100), D("1"), [D(107)])  # риск 3 > 2.5 ATR
    assert isinstance(rej, TradeRejection) and "широкий" in rej.reason


def test_reject_zone_above_price() -> None:
    above = Zone(ZoneKind.OB, Direction.UP, D(105), D(103), 9, 6, 6, 9)
    rej = build_trade(Direction.UP, above, D(100), ATR, [])
    assert isinstance(rej, TradeRejection)


def test_pct_buffer_dominates_for_expensive_asset() -> None:
    zone = Zone(ZoneKind.OB, Direction.UP, D(99_800), D(99_500), 9, 6, 6, 9)
    setup = build_trade(Direction.UP, zone, D(100_000), D(500), [])
    assert isinstance(setup, TradeSetup)
    assert setup.stop_loss == D(99_500) - D("0.0015") * D(100_000)  # 150 > 0.25 × 500 = 125


def test_short_mirror() -> None:
    setup = build_trade(Direction.DOWN, SHORT_ZONE, D(100), ATR, [D(93), D(88)])
    assert isinstance(setup, TradeSetup)
    assert setup.stop_loss == D("103") and setup.risk == D(3)
    assert setup.entry_limit == D("101.75")
    assert setup.tp1 == D(97) and setup.tp2 == D(93) and setup.tp3 == D(88)
    assert setup.r_at(D(94)) == D(2)


def test_params_validation() -> None:
    with pytest.raises(ValueError):
        TradeParams(tp2_min_r=D(5))
    with pytest.raises(ValueError):
        TradeParams(split=(D("0.5"), D("0.5"), D("0.5")))
