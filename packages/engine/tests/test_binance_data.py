from __future__ import annotations

import csv
import io
import zipfile
from datetime import UTC, date, datetime
from decimal import Decimal

import httpx

from engine.candles import Timeframe
from engine.data.binance import (
    BinanceHistory,
    data_vision_url,
    month_range,
    parse_kline_row,
    parse_zip,
)


def _row(open_ms: int, close: str = "100") -> list[str]:
    return [
        str(open_ms),
        "99",
        "101",
        "98",
        close,
        "10",
        str(open_ms + 1),
        "1000",
        "5",
        "4",
        "400",
        "0",
    ]


def _zip_bytes(rows: list[list[str]], header: bool = False) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf)
    if header:
        w.writerow(
            [
                "open_time",
                "open",
                "high",
                "low",
                "close",
                "volume",
                "close_time",
                "qv",
                "n",
                "a",
                "b",
                "i",
            ]
        )
    w.writerows(rows)
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as zf:
        zf.writestr("BTCUSDT-4h-2024-01.csv", buf.getvalue())
    return out.getvalue()


H4_MS = 4 * 3600 * 1000
T0 = int(datetime(2024, 1, 1, tzinfo=UTC).timestamp() * 1000)


def test_parse_kline_row_handles_ms_and_us() -> None:
    c = parse_kline_row(_row(T0))
    assert c.open_time == datetime(2024, 1, 1, tzinfo=UTC)
    c_us = parse_kline_row(_row(T0 * 1000))
    assert c_us.open_time == c.open_time
    assert c.trades == 5


def test_parse_zip_skips_header_and_sorts() -> None:
    rows = [_row(T0 + H4_MS), _row(T0)]
    candles = parse_zip(_zip_bytes(rows, header=True))
    assert [c.open_time.hour for c in candles] == [0, 4]


def test_month_range_and_url() -> None:
    assert list(month_range(date(2023, 11, 1), date(2024, 2, 1))) == [
        (2023, 11),
        (2023, 12),
        (2024, 1),
        (2024, 2),
    ]
    assert data_vision_url("BTCUSDT", Timeframe.H4, 2024, 1, "futures").endswith(
        "/futures/um/monthly/klines/BTCUSDT/4h/BTCUSDT-4h-2024-01.zip"
    )
    assert "/spot/monthly/" in data_vision_url("BTCUSDT", Timeframe.H4, 2024, 1, "spot")


def test_fetch_range_merges_archive_and_rest() -> None:
    archive_rows = [_row(T0 + i * H4_MS) for i in range(3)]  # 00:00, 04:00, 08:00
    rest_rows = [_row(T0 + 2 * H4_MS, close="100.5"), _row(T0 + 3 * H4_MS)]  # пересечение + новая

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "data.binance.vision":
            if request.url.path.endswith("2024-01.zip"):
                return httpx.Response(200, content=_zip_bytes(archive_rows))
            return httpx.Response(404)
        assert request.url.params["symbol"] == "BTCUSDT"
        return httpx.Response(200, json=rest_rows)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    history = BinanceHistory("futures", client=client)
    candles = history.fetch_range("BTCUSDT", Timeframe.H4, date(2024, 1, 1), date(2024, 2, 1))
    assert [c.open_time.hour for c in candles] == [0, 4, 8, 12]
    assert candles[2].close == Decimal("100.5")  # REST перекрывает архив при пересечении


def test_fetch_rest_pagination() -> None:
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        start = int(request.url.params["startTime"])
        calls.append(start)
        if len(calls) == 1:
            return httpx.Response(200, json=[_row(start + i * H4_MS) for i in range(1500)])
        return httpx.Response(200, json=[_row(start)])

    client = httpx.Client(transport=httpx.MockTransport(handler))
    history = BinanceHistory("futures", client=client)
    start = datetime(2024, 1, 1, tzinfo=UTC)
    end = datetime(2025, 1, 1, tzinfo=UTC)
    candles = history.fetch_rest("BTCUSDT", Timeframe.H4, start, end)
    assert len(candles) == 1501
    assert calls[1] == T0 + 1500 * H4_MS


def test_weekly_uses_rest_only() -> None:
    hosts: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        hosts.append(request.url.host)
        return httpx.Response(200, json=[_row(T0)])

    client = httpx.Client(transport=httpx.MockTransport(handler))
    history = BinanceHistory("futures", client=client)
    candles = history.fetch_range("BTCUSDT", Timeframe.W1, date(2024, 1, 1), date(2024, 3, 1))
    assert len(candles) == 1
    assert "data.binance.vision" not in hosts
