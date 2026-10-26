"""chart-data (план 2A.3): агрегация 1m → 5m/15m/1h совпадает с ручной, свёртка текущей свечи."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from app.chart_data import aggregate, bucket_start, fold
from engine.candles import Candle, Timeframe


def _m1(n: int, start: datetime) -> list[Candle]:
    out = []
    for i in range(n):
        o = Decimal(100 + i)
        out.append(
            Candle(start + timedelta(minutes=i), o, o + 2, o - 1, o + 1, Decimal(1), Decimal(10), 1)
        )
    return out


def test_aggregate_5m_matches_hand_calculation() -> None:
    start = datetime(2026, 10, 26, 12, 0, tzinfo=UTC)
    m1 = _m1(12, start)
    out = aggregate(m1, Timeframe.M5)
    assert [c.open_time for c in out] == [
        start,
        start + timedelta(minutes=5),
        start + timedelta(minutes=10),
    ]
    first = out[0]
    assert (first.open, first.high, first.low, first.close) == (
        Decimal(100),
        Decimal(106),
        Decimal(99),
        Decimal(105),
    )
    assert first.volume == 5 and first.trades == 5
    assert out[2].volume == 2  # неполная корзина отдаётся как есть


def test_aggregate_respects_bucket_alignment() -> None:
    start = datetime(2026, 10, 26, 12, 3, tzinfo=UTC)  # не на границе 5 минут
    out = aggregate(_m1(4, start), Timeframe.M5)
    assert [c.open_time.minute for c in out] == [0, 5]
    assert out[0].volume == 2 and out[1].volume == 2


def test_fold_and_bucket_start() -> None:
    now = datetime(2026, 10, 28, 13, 37, tzinfo=UTC)  # среда
    assert bucket_start(Timeframe.H4, now) == datetime(2026, 10, 28, 12, tzinfo=UTC)
    assert bucket_start(Timeframe.D1, now) == datetime(2026, 10, 28, tzinfo=UTC)
    assert bucket_start(Timeframe.W1, now) == datetime(2026, 10, 26, tzinfo=UTC)
    start = bucket_start(Timeframe.H4, now)
    c = fold(_m1(97, start), start)
    assert (
        c.open_time == start and c.open == 100 and c.close == 197 and c.high == 198 and c.low == 99
    )
    assert c.volume == 97
