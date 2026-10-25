from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone
from decimal import Decimal

import pytest

from engine.candles import Candle, Timeframe, closed_only, ensure_continuous, find_gaps
from engine.testing import make_candles


def test_candle_requires_utc() -> None:
    with pytest.raises(ValueError, match="UTC"):
        Candle(datetime(2024, 1, 1), Decimal(1), Decimal(2), Decimal(0), Decimal(1), Decimal(1))
    msk = timezone(timedelta(hours=3))
    with pytest.raises(ValueError, match="UTC"):
        Candle(
            datetime(2024, 1, 1, tzinfo=msk),
            Decimal(1),
            Decimal(2),
            Decimal(0),
            Decimal(1),
            Decimal(1),
        )


def test_candle_validates_ohlc() -> None:
    t = datetime(2024, 1, 1, tzinfo=UTC)
    with pytest.raises(ValueError, match="low<=open"):
        Candle(t, Decimal(5), Decimal(2), Decimal(0), Decimal(1), Decimal(1))
    with pytest.raises(ValueError, match="объём"):
        Candle(t, Decimal(1), Decimal(2), Decimal(0), Decimal(1), Decimal(-1))


def test_candle_properties() -> None:
    t = datetime(2024, 1, 1, tzinfo=UTC)
    c = Candle(t, Decimal(10), Decimal(15), Decimal(8), Decimal(12), Decimal(1))
    assert c.body == Decimal(2)
    assert c.range == Decimal(7)
    assert c.is_bullish
    assert c.close_time(Timeframe.H4) == datetime(2024, 1, 1, 4, tzinfo=UTC)


def test_timeframe_seconds() -> None:
    assert Timeframe.H4.seconds == 4 * 3600
    assert Timeframe.W1.delta == timedelta(weeks=1)


def test_closed_only_drops_unclosed_candle() -> None:
    candles = make_candles(3)  # 00:00, 04:00, 08:00
    now = datetime(2024, 1, 1, 10, tzinfo=UTC)  # свеча 08:00 ещё идёт
    closed = closed_only(candles, Timeframe.H4, now)
    assert [c.open_time.hour for c in closed] == [0, 4]
    # ровно в момент закрытия свеча считается закрытой
    assert len(closed_only(candles, Timeframe.H4, datetime(2024, 1, 1, 12, tzinfo=UTC))) == 3


def test_closed_only_requires_tz() -> None:
    with pytest.raises(ValueError):
        closed_only(make_candles(2), Timeframe.H4, datetime(2024, 1, 1))


def test_ensure_continuous_ok_and_gap() -> None:
    candles = make_candles(5)
    ensure_continuous(candles, Timeframe.H4)
    broken = candles[:2] + candles[3:]
    with pytest.raises(ValueError, match="пропуск"):
        ensure_continuous(broken, Timeframe.H4)
    gaps = find_gaps(broken, Timeframe.H4)
    assert gaps == [(candles[2].open_time, candles[3].open_time)]
    assert find_gaps(candles, Timeframe.H4) == []
