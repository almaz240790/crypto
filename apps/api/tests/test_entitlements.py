"""Тарифные ограничения (раздел 4, задача 3.3): каждое ограничение проверяется отдельно."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.entitlements import ENTITLEMENTS, entitlements, restrictions_dict, signal_visible


def test_free_sees_only_grade_a_with_delay() -> None:
    now = datetime(2026, 10, 26, 12, tzinfo=UTC)
    free = entitlements("free")
    assert signal_visible(free, "A", now - timedelta(hours=13), now)
    assert not signal_visible(free, "A", now - timedelta(hours=11), now)
    assert not signal_visible(free, "B", now - timedelta(hours=30), now)
    pro = entitlements("pro")
    assert signal_visible(pro, "C", now, now)


def test_limits_per_plan() -> None:
    free, pro, premium = (ENTITLEMENTS[p] for p in ("free", "pro", "premium"))
    assert (free.watchlist_limit, pro.watchlist_limit, premium.watchlist_limit) == (5, 50, None)
    assert (free.journal_limit, pro.journal_limit) == (20, None)
    assert not free.csv_export and pro.csv_export
    assert not free.instant_notifications and pro.instant_notifications
    assert not pro.forward_scope and premium.forward_scope
    assert not free.all_instruments and pro.all_instruments
    assert entitlements("unknown") is free


def test_restrictions_dict_shape() -> None:
    d = restrictions_dict(ENTITLEMENTS["free"])
    assert d["grades"] == ["A"] and d["delay_hours"] == 12 and d["watchlist_limit"] == 5
    assert restrictions_dict(ENTITLEMENTS["pro"])["grades"] is None
