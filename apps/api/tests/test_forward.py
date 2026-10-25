"""Чистые части форвард-теста (без БД)."""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

from app.forward import _status_from_result, last_h4_close
from engine.backtest import TradeResult, TradeStatus


def test_last_h4_close_floors_to_4h_grid() -> None:
    assert last_h4_close(datetime(2026, 10, 25, 9, 17, tzinfo=UTC)) == datetime(
        2026, 10, 25, 8, tzinfo=UTC
    )
    assert last_h4_close(datetime(2026, 10, 25, 12, 0, tzinfo=UTC)) == datetime(
        2026, 10, 25, 12, tzinfo=UTC
    )
    assert last_h4_close(datetime(2026, 10, 25, 3, 59, tzinfo=UTC)) == datetime(
        2026, 10, 25, 0, tzinfo=UTC
    )


def _res(status: TradeStatus, hits: int) -> TradeResult:
    return TradeResult(
        status, Decimal(0), None, None, hits, 0, None, Decimal(0), Decimal(0), Decimal(0)
    )


def test_status_mapping() -> None:
    assert _status_from_result(_res(TradeStatus.OPEN, 0)) == "active"
    assert _status_from_result(_res(TradeStatus.OPEN, 1)) == "tp1_hit"
    assert _status_from_result(_res(TradeStatus.OPEN, 2)) == "tp2_hit"
    assert _status_from_result(_res(TradeStatus.CLOSED_TP3, 3)) == "closed_tp3"
    assert _status_from_result(_res(TradeStatus.CLOSED_SL, 0)) == "closed_sl"
    assert _status_from_result(_res(TradeStatus.EXPIRED, 0)) == "expired"
