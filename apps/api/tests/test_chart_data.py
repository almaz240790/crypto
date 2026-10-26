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


# --- на реальной БД (как в CI): нулевой параметр before и агрегация из хранимых 1m -------------


def _db_available() -> bool:
    from sqlalchemy import text as _t
    from sqlalchemy.exc import DBAPIError, OperationalError

    from app.db import engine

    try:
        with engine.connect() as conn:
            conn.execute(_t("select 1 from candles limit 1"))
        return True
    except (OperationalError, DBAPIError):
        return False


import pytest  # noqa: E402

db_only = pytest.mark.skipif(not _db_available(), reason="БД с миграциями недоступна")


@db_only
def test_load_candles_with_and_without_before() -> None:
    from app.chart_data import current_candle, load_candles
    from app.db import SessionLocal
    from app.models import Instrument
    from app.models.market import Candle as CandleRow

    with SessionLocal() as s:
        s.begin()
        try:
            inst = Instrument(
                exchange="binance", symbol="CHARTTESTUSDT", base="CT", quote="USDT",
                market_type="futures", tick_size=Decimal("0.01"), lot_size=Decimal("0.001"),
            )  # fmt: skip
            s.add(inst)
            s.flush()
            start = datetime(2026, 10, 26, 0, 0, tzinfo=UTC)
            for i in range(130):  # 130 минут → 1h: 00:00 (60), 01:00 (60), 02:00 (10, неполная)
                o = Decimal(100 + i)
                s.add(
                    CandleRow(
                        instrument_id=inst.id,
                        timeframe="1m",
                        open_time=start + timedelta(minutes=i),
                        open=o,
                        high=o + 2,
                        low=o - 1,
                        close=o + 1,
                        volume=Decimal(1),
                    )
                )
            for i in range(3):
                s.add(
                    CandleRow(
                        instrument_id=inst.id,
                        timeframe="4h",
                        open_time=start + timedelta(hours=4 * i),
                        open=Decimal(1),
                        high=Decimal(2),
                        low=Decimal(1),
                        close=Decimal(2),
                        volume=Decimal(5),
                    )
                )
            s.flush()
            rows, more = load_candles(s, inst.id, Timeframe.H4, None, 500)
            assert len(rows) == 3 and more is False
            rows, more = load_candles(s, inst.id, Timeframe.H4, start + timedelta(hours=8), 2)
            assert [r.open_time for r in rows] == [
                start,
                start + timedelta(hours=4),
            ] and more is False
            rows, more = load_candles(s, inst.id, Timeframe.H1, None, 500)
            assert [r.open_time.hour for r in rows] == [0, 1, 2]
            assert rows[0].volume == 60 and rows[2].volume == 10
            cur = current_candle(s, inst.id, Timeframe.H4, start + timedelta(hours=2, minutes=15))
            assert cur is not None and cur.open_time == start and cur.volume == 130
        finally:
            s.rollback()


def test_bucket_last_and_sum() -> None:
    from app.chart_data import bucket_last, bucket_sum

    t0 = datetime(2026, 10, 26, 12, 0, tzinfo=UTC)
    rows = [(t0 + timedelta(minutes=m), Decimal(m)) for m in (0, 5, 10, 240, 245)]
    out = bucket_last(rows, 14400)
    assert [(o["t"], o["v"]) for o in out] == [
        (int(t0.timestamp()), "10"),
        (int(t0.timestamp()) + 14400, "245"),
    ]
    liq = [(t0 + timedelta(minutes=m), Decimal(1), Decimal(2)) for m in (0, 1, 240)]
    out2 = bucket_sum(liq, 14400)
    assert out2[0]["long"] == "2" and out2[0]["short"] == "4" and out2[1]["long"] == "1"
