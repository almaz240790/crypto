from __future__ import annotations

import csv
import io
import zipfile
from datetime import UTC, date, datetime
from decimal import Decimal

import httpx

from engine.data.binance_derivatives import (
    BinanceDerivativesHistory,
    funding_url,
    metrics_url,
    parse_funding_rows,
    parse_metrics_rows,
)

FUNDING_CSV = [
    ["calc_time", "funding_interval_hours", "last_funding_rate"],
    ["1704096000000", "8", "0.00027213"],
    ["1704067200000", "8", "0.00037409"],
]
METRICS_CSV = [
    [
        "create_time",
        "symbol",
        "sum_open_interest",
        "sum_open_interest_value",
        "count_toptrader_long_short_ratio",
        "sum_toptrader_long_short_ratio",
        "count_long_short_ratio",
        "sum_taker_long_short_vol_ratio",
    ],
    [
        "2024-01-05 00:00:00",
        "BTCUSDT",
        "71362.087",
        "3150422054.789",
        "1.12838535",
        "1.19790392",
        "1.17457089",
        "0.85127979",
    ],
    [
        "2024-01-05 00:05:00",
        "BTCUSDT",
        "71311.694",
        "3151182635.352",
        "1.1328879",
        "1.19740362",
        "1.17855452",
        "1.10175992",
    ],
    ["2024-01-05 01:00:00", "BTCUSDT", "71000", "3100000000", "1.0", "1.1", "1.5", "0.9"],
    ["2024-01-05 02:00:00", "BTCUSDT", "70500", "3050000000", "", "", "", ""],
]


def _zip(rows: list[list[str]], name: str) -> bytes:
    buf = io.StringIO()
    csv.writer(buf).writerows(rows)
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as zf:
        zf.writestr(name, buf.getvalue())
    return out.getvalue()


def test_parse_funding_sorted() -> None:
    rows = parse_funding_rows(FUNDING_CSV)
    assert [r.time for r in rows] == [
        datetime(2024, 1, 1, 0, tzinfo=UTC),
        datetime(2024, 1, 1, 8, tzinfo=UTC),
    ]
    assert rows[0].rate == Decimal("0.00037409")


def test_parse_metrics_hourly_sampling_and_pcts() -> None:
    rows = parse_metrics_rows(METRICS_CSV)
    assert [r.time.minute for r in rows] == [0, 0, 0] and len(rows) == 3
    assert not rows[2].has_ratios and rows[2].top_long_pct is None
    assert rows[2].oi_quote == Decimal("3050000000")
    first = rows[0]
    assert first.oi_quote == Decimal("3150422054.789")
    assert first.top_traders_ratio == Decimal("1.12838535")
    assert abs(first.top_long_pct - Decimal("0.5301")) < Decimal("0.001")
    assert rows[1].global_long_pct is not None
    assert abs(rows[1].global_long_pct - Decimal("0.6")) < Decimal("0.0001")
    assert len(parse_metrics_rows(METRICS_CSV, step_minutes=5)) == 4


def test_parse_metrics_drops_garbage_ratios() -> None:
    """Binance отдаёт мусор вроде taker ratio 37655 — такие значения становятся None."""
    rows = parse_metrics_rows(
        [
            ["create_time", "symbol", "oi", "oi_value", "a", "b", "c", "d"],
            ["2023-11-16 06:00:00", "ADAUSDT", "1", "2", "3.10", "0.7", "3.33", "37655.00000000"],
            ["2023-11-16 07:00:00", "ADAUSDT", "1", "2", "-1", "0.7", "3.33", "0.79"],
        ]
    )
    assert rows[0].taker_ratio is None and rows[0].global_ratio == Decimal("3.33")
    assert rows[1].top_traders_ratio is None and rows[1].taker_ratio == Decimal("0.79")


def test_urls() -> None:
    assert funding_url("BTCUSDT", 2024, 1).endswith(
        "/fundingRate/BTCUSDT/BTCUSDT-fundingRate-2024-01.zip"
    )
    assert metrics_url("BTCUSDT", date(2024, 1, 5)).endswith(
        "/metrics/BTCUSDT/BTCUSDT-metrics-2024-01-05.zip"
    )


def test_iter_funding_archive_plus_rest_and_metrics_days() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "fundingRate-2024-01.zip" in url:
            return httpx.Response(200, content=_zip(FUNDING_CSV, "f.csv"))
        if "fundingRate-2024-02.zip" in url:
            return httpx.Response(404)
        if "metrics-2024-01-05.zip" in url:
            return httpx.Response(200, content=_zip(METRICS_CSV, "m.csv"))
        if "metrics-" in url:
            return httpx.Response(404)
        assert request.url.host == "fapi.binance.com"
        start = int(request.url.params["startTime"])
        assert start == 1704096000000 + 1000  # через секунду после последней архивной записи
        return httpx.Response(200, json=[{"fundingTime": 1704124800000, "fundingRate": "0.0001"}])

    h = BinanceDerivativesHistory(httpx.Client(transport=httpx.MockTransport(handler)))
    batches = list(h.iter_funding("BTCUSDT", date(2024, 1, 1), date(2024, 2, 10)))
    assert [len(b) for b in batches] == [2, 1]
    assert batches[1][0].time == datetime(2024, 1, 1, 16, tzinfo=UTC)
    days = list(h.iter_metrics("BTCUSDT", date(2024, 1, 4), date(2024, 1, 5)))
    assert days[0] == (date(2024, 1, 4), None)
    assert days[1][0] == date(2024, 1, 5) and len(days[1][1] or []) == 3
