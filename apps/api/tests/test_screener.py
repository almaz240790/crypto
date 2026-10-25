"""Чистые расчёты скринера: бета к BTC, изменение за 24 ч, ближайшая зона."""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

from app.screener import beta_to_btc, change_pct, nearest_zone
from engine.candles import Timeframe
from engine.structure import Direction
from engine.testing import make_candles
from engine.zones import Zone, ZoneKind


def test_beta_and_change() -> None:
    btc = make_candles(120, Timeframe.D1, base=100, step=1)
    doubled = [
        c.__class__(c.open_time, c.open * 2, c.high * 2, c.low * 2, c.close * 2, c.volume)
        for c in btc
    ]
    assert beta_to_btc(doubled, btc) is not None
    assert abs(beta_to_btc(doubled, btc) - Decimal(1)) < Decimal("0.01")  # type: ignore[operator]
    assert beta_to_btc(btc[:10], btc) is None
    h4 = make_candles(10, Timeframe.H4, base=100, step=1)
    assert change_pct(h4, 6) == (Decimal(109) / Decimal(103) - 1) * 100
    assert change_pct(h4, 20) is None


def test_nearest_zone_distance() -> None:
    t0 = datetime(2026, 1, 1, tzinfo=UTC)
    mk = lambda top, bottom, idx: Zone(  # noqa: E731
        kind=ZoneKind.OB,
        direction=Direction.UP,
        top=Decimal(top),
        bottom=Decimal(bottom),
        created_index=idx,
        event_index=idx,
        source_start=idx,
        source_end=idx,
    )
    zones = [mk(90, 88, 1), mk(120, 118, 2)]
    z = nearest_zone(zones, Decimal(100), Decimal(2))
    assert z and z["top"] == "90" and z["distance_atr"] == "5" and z["distance_pct"] == "10"
    inside = nearest_zone([mk(101, 99, 3)], Decimal(100), Decimal(2))
    assert inside and inside["distance_atr"] == "0"
    assert nearest_zone([], Decimal(100), Decimal(2)) is None
    _ = t0
