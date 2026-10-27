"""Слияние рядов L/S ratio (top / global) по времени."""

from __future__ import annotations

from decimal import Decimal

from app.forward import merge_long_short


def test_merge_long_short_by_time() -> None:
    top = [
        {"timestamp": 1000_000, "longShortRatio": "1.5"},
        {"timestamp": 4600_000, "longShortRatio": "1.7"},
    ]
    glob = [
        {"timestamp": 1000_000, "longShortRatio": "1.1"},
        {"timestamp": 8200_000, "longShortRatio": "0.9"},
    ]
    rows = merge_long_short(top, glob)
    assert [r["time"].timestamp() for r in rows] == [1000, 4600, 8200]
    assert rows[0]["top_traders_ratio"] == Decimal("1.5") and rows[0]["global_ratio"] == Decimal(
        "1.1"
    )
    # ряд без пары — значение копируется, чтобы NOT NULL не падал
    assert rows[1]["global_ratio"] == Decimal("1.7") and rows[2]["top_traders_ratio"] == Decimal(
        "0.9"
    )
    assert merge_long_short([], []) == []
