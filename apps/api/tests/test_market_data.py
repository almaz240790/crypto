"""Разбор событий Binance в market-data (без сети и БД)."""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

from app.workers.market_data import MarketData


def _md() -> MarketData:
    md = MarketData.__new__(MarketData)
    md.symbols = {"BTCUSDT": 1}
    md.candle_buffer = {}
    from collections import defaultdict

    md.liq_buffer = defaultdict(lambda: [Decimal(0), Decimal(0)])
    md.closed_events = []
    md.n_klines = md.n_flushed = md.n_published = md.n_flush_errors = 0
    return md


KLINE = {
    "s": "BTCUSDT",
    "i": "4h",
    "t": 1704067200000,
    "o": "42000.1",
    "h": "42500",
    "l": "41800",
    "c": "42300",
    "v": "1234.5",
    "q": "52000000",
    "n": 1000,
    "x": False,
}


def test_kline_open_then_closed_and_event() -> None:
    md = _md()
    md.on_kline(KLINE)
    key = (1, "4h", datetime(2024, 1, 1, tzinfo=UTC))
    assert md.candle_buffer[key]["is_closed"] is False and md.closed_events == []
    md.on_kline({**KLINE, "c": "42400", "x": True})
    assert md.candle_buffer[key]["close"] == Decimal("42400") and md.candle_buffer[key]["is_closed"]
    assert md.closed_events[0]["tf"] == "4h"
    assert md.closed_events[0]["close_time"] == "2024-01-01T04:00:00+00:00"
    md.on_kline({**KLINE, "s": "UNKNOWN"})
    assert len(md.candle_buffer) == 1


def test_force_order_aggregation_by_minute_and_side() -> None:
    md = _md()
    t = 1704067230000  # 00:00:30
    md.on_force_order({"s": "BTCUSDT", "S": "SELL", "q": "2", "ap": "42000", "T": t})
    md.on_force_order({"s": "BTCUSDT", "S": "BUY", "q": "1", "ap": "42000", "T": t + 10_000})
    md.on_force_order({"s": "BTCUSDT", "S": "SELL", "q": "1", "ap": "42000", "T": t + 60_000})
    minute = datetime(2024, 1, 1, 0, 0, tzinfo=UTC)
    assert md.liq_buffer[(1, minute)] == [Decimal(84000), Decimal(42000)]
    assert md.liq_buffer[(1, datetime(2024, 1, 1, 0, 1, tzinfo=UTC))][0] == Decimal(42000)


def test_streams_are_chunked() -> None:
    md = _md()
    md.symbols = {f"S{i}USDT": i for i in range(40)}
    chunks = md._streams()
    assert sum(len(c) for c in chunks) == 40 * 5
    assert all(len(c) <= 150 for c in chunks) and len(chunks) == 2
