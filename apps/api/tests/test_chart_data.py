"""chart-data (план 2A.3, 2B.4): агрегация 1m → 5m/15m/1h совпадает с ручной, свёртка текущей
свечи; SQL-агрегат равен aggregate()/fold(), /found = элементы, бюджет серверного времени."""

from __future__ import annotations

import random
import time
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import select, text

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


def test_weekly_derivative_buckets_match_monday_candle_open() -> None:
    """1w: корзины OI и ликвидаций начинаются в понедельник 00:00 UTC, как open_time недельной свечи
    (раньше — от эпохи, в четверг, и ни одна точка OI не совпадала со свечой)."""
    from app.chart_data import bucket_key, bucket_last, bucket_sum

    week = Timeframe.W1.seconds
    candle_open = bucket_start(Timeframe.W1, datetime(2026, 10, 29, 15, 30, tzinfo=UTC))
    assert candle_open == datetime(2026, 10, 26, tzinfo=UTC) and candle_open.weekday() == 0
    rows = [
        (datetime(2026, 10, 26, 0, 0, tzinfo=UTC), Decimal(1)),  # пн, начало недели
        (datetime(2026, 10, 29, 12, 0, tzinfo=UTC), Decimal(2)),  # чт
        (datetime(2026, 11, 1, 23, 59, tzinfo=UTC), Decimal(3)),  # вс, последняя минута недели
        (datetime(2026, 11, 2, 0, 0, tzinfo=UTC), Decimal(4)),  # пн, следующая неделя
    ]
    out = bucket_last(rows, week)
    assert [(o["t"], o["v"]) for o in out] == [
        (int(candle_open.timestamp()), "3"),
        (int((candle_open + timedelta(weeks=1)).timestamp()), "4"),
    ]
    liq = [(t, Decimal(1), Decimal(2)) for t, _ in rows]
    sums = bucket_sum(liq, week)
    assert [(o["t"], o["long"], o["short"]) for o in sums] == [
        (int(candle_open.timestamp()), "3", "6"),
        (int((candle_open + timedelta(weeks=1)).timestamp()), "1", "2"),
    ]
    # каждая корзина совпадает с open_time своей недельной свечи на годе данных
    for d in range(0, 365, 3):
        t = datetime(2026, 1, 1, 7, tzinfo=UTC) + timedelta(days=d)
        candle_t = int(bucket_start(Timeframe.W1, t).timestamp())
        assert bucket_key(int(t.timestamp()), week) == candle_t
    # остальные таймфреймы — как раньше, от эпохи
    t = datetime(2026, 10, 29, 15, 30, tzinfo=UTC)
    for tf in (Timeframe.H1, Timeframe.H4, Timeframe.D1):
        assert bucket_key(int(t.timestamp()), tf.seconds) == int(bucket_start(tf, t).timestamp())


def test_candles_tick_size_in_fixed_point(monkeypatch: pytest.MonkeyPatch) -> None:
    """tick_size отдаётся обычной записью: str(Decimal('1.000E-7')) дал бы '1.000E-7', и клиент
    считал 6 знаков вместо 7 — у 1000PEPE шкала без делений и «цена 0.00»."""
    from types import SimpleNamespace

    from fastapi.testclient import TestClient

    from app import auth
    from app.main import app
    from app.routers import chart

    start = datetime(2026, 10, 26, 0, 0, tzinfo=UTC)
    d = Decimal
    c = Candle(start, d("0.0049"), d("0.005"), d("0.0048"), d("0.00494"), d(1))
    for tick, want in (("1.000E-7", "0.0000001"), ("0.10", "0.1"), ("1E+1", "10")):
        inst = SimpleNamespace(id=1, symbol="1000PEPEUSDT", tick_size=Decimal(tick))
        monkeypatch.setattr(chart, "_instrument", lambda db, symbol, inst=inst: inst)
        monkeypatch.setattr(chart, "load_candles", lambda *a, **k: ([c], False))
        monkeypatch.setattr(chart, "current_bar", lambda *a, **k: None)
        app.dependency_overrides[auth.get_db] = lambda: object()
        try:
            r = TestClient(app).get("/v1/chart/candles?symbol=1000PEPEUSDT&tf=4h")
        finally:
            app.dependency_overrides.pop(auth.get_db, None)
        assert r.status_code == 200, r.text
        assert r.json()["tick_size"] == want
        assert r.json()["candles"][0]["c"] == "0.00494"


# --- SQL-агрегат 5m/15m/1h и текущая свеча против эталонов aggregate()/fold() (план 2B.4) -------

AGG_TFS = (Timeframe.M5, Timeframe.M15, Timeframe.H1)
FIX_START = datetime(2026, 10, 20, 0, 23, tzinfo=UTC)  # данные начинаются с середины часа
FIX_END = datetime(2026, 10, 23, 0, 23, tzinfo=UTC)
FIX_GAPS = (
    (datetime(2026, 10, 20, 5, 41, tzinfo=UTC), datetime(2026, 10, 20, 5, 48, tzinfo=UTC)),
    (datetime(2026, 10, 21, 10, 50, tzinfo=UTC), datetime(2026, 10, 21, 13, 0, tzinfo=UTC)),
    (datetime(2026, 10, 22, 3, 0, tzinfo=UTC), datetime(2026, 10, 22, 3, 1, tzinfo=UTC)),
)


def _instrument_row(s: Any, symbol: str) -> Any:
    from app.models import Instrument

    inst = Instrument(
        exchange="binance", symbol=symbol, base=symbol[:-4], quote="USDT",
        market_type="futures", tick_size=Decimal("0.01"), lot_size=Decimal("0.001"),
    )  # fmt: skip
    s.add(inst)
    s.flush()
    return inst


def _m1_rows(inst_id: int, minutes: list[datetime], seed: int = 7) -> list[dict[str, Any]]:
    """Случайное блуждание с точными Decimal: OHLC, объёмы, quote_volume и trades."""
    rng = random.Random(seed)
    price = Decimal("100")
    rows = []
    for t in minutes:
        o = price
        c = o + Decimal(rng.randint(-50, 50)) / 100
        rows.append(
            {
                "instrument_id": inst_id,
                "timeframe": "1m",
                "open_time": t,
                "open": o,
                "high": max(o, c) + Decimal(rng.randint(0, 30)) / 100,
                "low": min(o, c) - Decimal(rng.randint(0, 30)) / 100,
                "close": c,
                "volume": Decimal(rng.randint(1, 10_000)) / 1000,
                "quote_volume": Decimal(rng.randint(1, 10**6)) / 100,
                "trades": rng.randint(0, 500),
            }
        )
        price = c
    return rows


def _insert_m1(s: Any, rows: list[dict[str, Any]]) -> None:
    from sqlalchemy import insert

    from app.models.market import Candle as CandleRow

    for i in range(0, len(rows), 5000):
        s.execute(insert(CandleRow), rows[i : i + 5000])
    s.flush()


def _fixture_minutes() -> list[datetime]:
    out = []
    t = FIX_START
    while t < FIX_END:
        if not any(a <= t < b for a, b in FIX_GAPS):
            out.append(t)
        t += timedelta(minutes=1)
    return out


def _forming(inst_id: int, t: datetime, prev: Candle) -> dict[str, Any]:
    """Формирующаяся минута, как её пишет market-data (``is_closed = false``, перезаписывается
    раз в секунду): нарочно крайние high/low и большой объём — попадание в свёртку видно сразу."""
    return {
        "instrument_id": inst_id,
        "timeframe": "1m",
        "open_time": t,
        "open": prev.close,
        "high": prev.close + 1000,
        "low": Decimal("0.01"),
        "close": prev.close + 500,
        "volume": Decimal(10**6),
        "quote_volume": Decimal(10**8),
        "trades": 10**6,
        "is_closed": False,
    }


def _m1_before(s: Any, inst_id: int, before: datetime | None) -> list[Candle]:
    from app.chart_data import _rows_to_candles

    rows = s.execute(
        text(
            "select open_time, open, high, low, close, volume, quote_volume, trades from candles "
            "where instrument_id=:i and timeframe='1m' "
            "and (CAST(:b AS timestamptz) is null or open_time < CAST(:b AS timestamptz)) "
            "order by open_time"
        ),
        {"i": inst_id, "b": before},
    ).all()
    return _rows_to_candles(list(rows))


def _old_load(
    s: Any, inst_id: int, tf: Timeframe, before: datetime | None, limit: int
) -> tuple[list[Candle], bool]:
    """Прежний путь load_candles для 5m/15m/1h: окно (limit+2)·mult строк и свёртка в Python."""
    mult = tf.seconds // 60
    m1 = _m1_before(s, inst_id, before)
    rows = m1[-(limit + 2) * mult :]
    candles = aggregate(rows, tf)
    if len(candles) > limit + 1:
        candles = candles[-(limit + 1) :]
    elif candles and len(rows) >= (limit + 2) * mult:
        candles = candles[1:]
    has_older = len(candles) > limit
    return (candles[-limit:] if has_older else candles), has_older


@db_only
def test_sql_aggregate_equals_python_aggregate() -> None:
    """5m/15m/1h из SQL (time_bucket, first/last) совпадают с aggregate() по всем полям: на
    данных с пропусками, с before и без, на границе корзины и внутри пропуска."""
    from app.chart_data import load_candles
    from app.db import SessionLocal

    befores: list[datetime | None] = [
        None,
        datetime(2026, 10, 23, 0, 0, tzinfo=UTC),
        datetime(2026, 10, 22, 7, 37, tzinfo=UTC),  # не на границе корзины
        datetime(2026, 10, 21, 14, 0, tzinfo=UTC),  # сразу после большого пропуска
        datetime(2026, 10, 21, 12, 0, tzinfo=UTC),  # внутри пропуска
        datetime(2026, 10, 20, 0, 30, tzinfo=UTC),  # в первой (неполной) корзине данных
    ]
    with SessionLocal() as s:
        s.begin()
        try:
            inst = _instrument_row(s, "AGGTESTUSDT")
            _insert_m1(s, _m1_rows(inst.id, _fixture_minutes()))
            for tf in AGG_TFS:
                size = timedelta(seconds=tf.seconds)
                for before in befores:
                    ref = aggregate(_m1_before(s, inst.id, before), tf)
                    by_t = {c.open_time: c for c in ref}
                    for limit in (20, 37, 500):
                        got, more = load_candles(s, inst.id, tf, before, limit)
                        assert got, (tf, before, limit)
                        # каждая свеча — та же корзина aggregate() по всем 1m раньше before
                        for c in got:
                            assert c == by_t[c.open_time], (tf, before, limit, c.open_time)
                        # окно — limit корзин по времени, кончается корзиной последней минуты
                        lo = ref[-1].open_time - (limit - 1) * size
                        assert got == [c for c in ref if c.open_time >= lo]
                        assert more == any(c.open_time < lo for c in ref)
                    # окно накрыло все данные — ровно прежний результат
                    got, more = load_candles(s, inst.id, tf, before, 500)
                    if not more:
                        assert (got, more) == _old_load(s, inst.id, tf, before, 500), (tf, before)
                    # у пропусков прежнее окно по строкам шире; общие корзины совпадают
                    for limit in (20, 500):
                        old = {c.open_time: c for c in _old_load(s, inst.id, tf, before, limit)[0]}
                        got, _ = load_candles(s, inst.id, tf, before, limit)
                        assert {c.open_time for c in got} <= set(old), (tf, before, limit)
                        assert all(c == old[c.open_time] for c in got), (tf, before, limit)
            # без пропусков в окне — совпадает с прежним путём целиком, включая has_older
            for tf, before, limit in (
                (Timeframe.M5, datetime(2026, 10, 23, 0, 0, tzinfo=UTC), 50),
                (Timeframe.M15, datetime(2026, 10, 22, 23, 0, tzinfo=UTC), 60),
                (Timeframe.H1, datetime(2026, 10, 23, 0, 0, tzinfo=UTC), 20),
                (Timeframe.H1, None, 20),
            ):
                assert load_candles(s, inst.id, tf, before, limit) == _old_load(
                    s, inst.id, tf, before, limit
                ), (tf, before, limit)
            # раньше данных и у инструмента без минут — пусто
            early = datetime(2026, 10, 20, 0, 0, tzinfo=UTC)
            assert load_candles(s, inst.id, Timeframe.H1, early, 500) == ([], False)
            assert load_candles(s, inst.id + 10_000, Timeframe.H1, None, 500) == ([], False)
        finally:
            s.rollback()


@db_only
def test_current_bar_and_through_equal_fold() -> None:
    """current_candle и current_through из SQL равны fold() по закрытым минутам текущего
    интервала; формирующаяся минута (``is_closed = false``) в свёртку и в through не входит."""
    from app.chart_data import current_bar, current_candle
    from app.db import SessionLocal

    with SessionLocal() as s:
        s.begin()
        try:
            inst = _instrument_row(s, "CURTESTUSDT")
            _insert_m1(s, _m1_rows(inst.id, _fixture_minutes(), seed=11))
            m1 = _m1_before(s, inst.id, None)
            _insert_m1(s, [_forming(inst.id, FIX_END, m1[-1])])
            now = FIX_END + timedelta(seconds=30)
            for tf in (Timeframe.M5, Timeframe.M15, Timeframe.H1, Timeframe.H4, Timeframe.D1,
                       Timeframe.W1):  # fmt: skip
                start = bucket_start(tf, now)
                inside = [c for c in m1 if c.open_time >= start]
                bar = current_bar(s, inst.id, tf, now)
                assert bar is not None, tf
                assert bar[0] == fold(inside, start), tf
                assert bar[1] == inside[-1].open_time == FIX_END - timedelta(minutes=1)
                assert current_candle(s, inst.id, tf, now) == bar[0]
            # текущая неделя содержит все три пропуска: fold по всем минутам с понедельника
            assert bucket_start(Timeframe.W1, now) < FIX_GAPS[0][0]
            # в текущем интервале нет минут — None; у 1m текущей свечи нет
            assert current_bar(s, inst.id, Timeframe.H1, FIX_END + timedelta(hours=5)) is None
            assert current_bar(s, inst.id, Timeframe.M1, now) is None
            # в интервале только формирующаяся минута — свёртки нет
            later = FIX_END + timedelta(hours=2)
            _insert_m1(s, [_forming(inst.id, later, m1[-1])])
            assert current_bar(s, inst.id, Timeframe.H1, later + timedelta(seconds=30)) is None
        finally:
            s.rollback()


def _fold_minute(bar: dict[str, Any], m: Candle) -> dict[str, Any]:
    """foldMinute клиента (packages/charts/src/live.ts) на полях ответа: та же корзина."""

    def s(x: Decimal) -> str:
        return format(x.normalize(), "f")

    return {
        **bar,
        "h": s(max(Decimal(bar["h"]), m.high)),
        "l": s(min(Decimal(bar["l"]), m.low)),
        "c": s(m.close),
        "v": s(Decimal(bar["v"]) + m.volume),
    }


@db_only
def test_open_bar_and_current_through_agree(monkeypatch: pytest.MonkeyPatch) -> None:
    """/candles: незакрытая свеча ответа — ровно fold() закрытых минут интервала до
    ``current_through``, формирующаяся минута не входит ни в неё, ни в историю 5m/15m/1h.
    Клиент, досворачивающий минуты новее ``current_through`` (включая закрытую версию
    формирующейся), получает ту же свечу, что и полная свёртка, — без потерь и двойного счёта.
    Для 4h снимок биржи в порции заменяется той же свёрткой; без закрытых минут — остаётся."""
    from types import SimpleNamespace

    from fastapi.testclient import TestClient
    from sqlalchemy import insert

    from app import auth
    from app.chart_data import load_candles
    from app.db import SessionLocal
    from app.main import app
    from app.models.market import Candle as CandleRow
    from app.routers import chart
    from app.routers.public import optional_user

    now = FIX_END + timedelta(seconds=40)  # 00:23:40, минута 00:23 формируется
    monkeypatch.setattr(chart, "_now", lambda: now)
    with SessionLocal() as s:
        s.begin()
        try:
            inst = _instrument_row(s, "OPENTESTUSDT")
            _insert_m1(s, _m1_rows(inst.id, _fixture_minutes(), seed=5))
            closed = _m1_before(s, inst.id, None)
            forming = _forming(inst.id, FIX_END, closed[-1])
            _insert_m1(s, [forming])
            for tf in AGG_TFS:
                got, _ = load_candles(s, inst.id, tf, None, 500)
                assert got[-1].open_time == bucket_start(tf, now), tf
                assert got == aggregate(closed, tf)[-len(got) :], tf
            app.dependency_overrides[auth.get_db] = lambda: s
            app.dependency_overrides[optional_user] = lambda: SimpleNamespace(id=1, role="admin")
            client = TestClient(app)
            sym = "symbol=OPENTESTUSDT"
            # закрытая версия формирующейся минуты, как её потом доставит WebSocket
            p = closed[-1].close
            final = Candle(FIX_END, p, p + 3, p - 2, p + 1, Decimal(7), Decimal(70), 9)
            for tf in (Timeframe.M5, Timeframe.M15, Timeframe.H1, Timeframe.H4):
                body = client.get(f"/v1/chart/candles?{sym}&tf={tf.value}").json()
                start = bucket_start(tf, now)
                inside = [c for c in closed if c.open_time >= start]
                want = chart.candle_dict(fold(inside, start), open_=True)
                opened = [c for c in body["candles"] if c["open"]]
                live = body["current"] or opened[-1]
                assert live == want, tf
                assert len(opened) == (0 if body["current"] else 1), tf
                assert body["current_through"] == int(closed[-1].open_time.timestamp()), tf
                # клиент: минуты ≤ current_through пропускает, новее — сворачивает
                assert int(final.open_time.timestamp()) > body["current_through"]
                live = _fold_minute(live, final)
                assert live == chart.candle_dict(fold([*inside, final], start), open_=True), tf
            # 4h: снимок биржи текущего интервала (с формирующейся минутой) в порции
            start4 = bucket_start(Timeframe.H4, now)
            snap = {**forming, "timeframe": "4h", "open_time": start4, "open": closed[0].open}
            s.execute(insert(CandleRow), [snap])
            body = client.get(f"/v1/chart/candles?{sym}&tf=4h").json()
            bar4 = fold([c for c in closed if c.open_time >= start4], start4)
            assert body["current"] is None
            assert body["candles"][-1] == chart.candle_dict(bar4, open_=True)
            assert body["current_through"] == int(closed[-1].open_time.timestamp())
            # закрытых минут в новом интервале ещё нет: снимок как есть, current_through null
            nxt = start4 + Timeframe.H4.delta
            monkeypatch.setattr(chart, "_now", lambda: nxt + timedelta(seconds=20))
            s.execute(insert(CandleRow), [{**snap, "open_time": nxt}])
            _insert_m1(s, [_forming(inst.id, nxt, closed[-1])])
            body = client.get(f"/v1/chart/candles?{sym}&tf=4h").json()
            assert body["current"] is None and body["current_through"] is None
            assert body["candles"][-1]["t"] == int(nxt.timestamp())
            assert body["candles"][-1]["open"] is True
            assert body["candles"][-1]["v"] == "1000000"
        finally:
            app.dependency_overrides.clear()
            s.rollback()


@db_only
def test_found_counts_equal_items() -> None:
    """/found считает то же, что /patterns и /figures отдают элементами (тот же отбор), а
    patterns view=chart / ids — правила полей и total."""
    from fastapi.testclient import TestClient

    from app import auth
    from app.db import SessionLocal
    from app.main import app
    from app.models import FigureRow, Pattern, PatternRulesVersion

    t0 = datetime(2026, 9, 1, tzinfo=UTC)
    h4 = timedelta(hours=4)
    with SessionLocal() as s:
        s.begin()
        try:
            inst = _instrument_row(s, "FOUNDTESTUSDT")
            other = _instrument_row(s, "FOUNDOTHERUSDT")
            rv = PatternRulesVersion(version="found-" + datetime.now(tz=UTC).strftime("%H%M%S%f"))
            s.add(rv)
            s.flush()
            for i in range(30):
                for owner in (inst, other):
                    t = t0 + h4 * i
                    s.add(
                        Pattern(
                            instrument_id=owner.id, timeframe="4h",
                            type=("engulfing", "doji", "pin_bar")[i % 3],
                            direction=None if i % 3 == 1 else ("up", "down")[i % 2],
                            status="confirmed", start_time=t - h4, confirm_time=t + h4,
                            candle_close_time=t + h4,
                            geometry={"candle_time": int(t.timestamp()), "price": "1", "atr": "1"},
                            context={"trend": "up", "volume_ratio": "1.5"},
                            is_significant=i % 4 == 0, rules_version_id=rv.id, source="backfill",
                        )
                    )  # fmt: skip
            for i in range(9):
                start = t0 + h4 * (3 * i)
                s.add(
                    FigureRow(
                        instrument_id=inst.id, timeframe="4h", type="double_top",
                        direction="down", status=("forming", "confirmed", "invalidated")[i % 3],
                        scale=1, start_time=start, end_time=start + h4 * 10,
                        known_time=start + h4 * 11, geometry={"points": [], "lines": []},
                        quality=Decimal("0.5"), metrics={"x": 1}, rules_version="t",
                        source="backfill",
                    )
                )  # fmt: skip
            s.flush()
            app.dependency_overrides[auth.get_db] = lambda: s
            client = TestClient(app)
            sym = "symbol=FOUNDTESTUSDT&tf=4h"
            ranges = [
                (1, None),
                (int((t0 + h4 * 7).timestamp()), None),
                (int((t0 + h4 * 5).timestamp()), int((t0 + h4 * 21).timestamp())),
                (int((t0 + h4 * 100).timestamp()), None),  # пусто
            ]
            for since, until in ranges:
                q = f"{sym}&since={since}" + (f"&until={until}" if until else "")
                found = client.get(f"/v1/chart/found?{q}").json()
                items = client.get(f"/v1/chart/patterns?{q}&limit=1000").json()["items"]
                light = client.get(f"/v1/chart/patterns?{q}&limit=1000&view=chart").json()
                figs = client.get(f"/v1/chart/figures?{q}&limit=500").json()["items"]
                assert found["patterns"]["total"] == len(items) == light["total"]
                assert found["patterns"]["significant_t"] == sorted(
                    p["t"] for p in items if p["significant"]
                )
                assert found["figures"]["active_end_t"] == sorted(
                    f["end_t"] for f in figs if f["status"] != "invalidated"
                )
                assert [p["id"] for p in light["items"]] == [p["id"] for p in items]
            # view=chart: total без учёта limit, контекст только у значимых, без source/tf
            light = client.get(f"/v1/chart/patterns?{sym}&since=1&limit=5&view=chart").json()
            assert len(light["items"]) == 5 and light["total"] == 30
            for p in light["items"]:
                assert "source" not in p and "tf" not in p
                assert ("context" in p) == p["significant"]
            fig = client.get(f"/v1/chart/figures?{sym}&since=1&view=chart").json()["items"][0]
            assert not {"metrics", "source", "tf"} & set(fig)
            # ids: только свои отметки этого инструмента и tf, полными элементами
            all_items = client.get(f"/v1/chart/patterns?{sym}&since=1&limit=1000").json()["items"]
            want = [all_items[1]["id"], all_items[2]["id"]]
            foreign = s.scalar(select(Pattern.id).where(Pattern.instrument_id == other.id))
            ids = ",".join(str(x) for x in [*want, foreign])
            got = client.get(f"/v1/chart/patterns?{sym}&ids={ids}&view=chart").json()
            assert [p["id"] for p in got["items"]] == want and got["total"] == 2
            assert all("context" in p and p["source"] == "backfill" for p in got["items"])
            # фигур на 1h нет — figures: null
            one_h = client.get("/v1/chart/found?symbol=FOUNDTESTUSDT&tf=1h&since=1").json()
            assert one_h["figures"] is None and one_h["patterns"]["total"] == 0
        finally:
            app.dependency_overrides.pop(auth.get_db, None)
            s.rollback()


@db_only
def test_chart_signals_follow_plan_on_db(monkeypatch: pytest.MonkeyPatch) -> None:
    """/v1/chart/signals и ``signals`` в /layers по правам тарифа, как /v1/signals: биллинг
    включён, Free — только градация A, через 12 ч после закрытия свечи, только BTC, ETH и
    инструменты вотчлиста; Pro — все live-сигналы инструмента."""
    from types import SimpleNamespace

    from fastapi.testclient import TestClient

    from app import auth
    from app import entitlements as ent_mod
    from app.config import settings
    from app.db import SessionLocal
    from app.main import app
    from app.models import Signal, Strategy, StrategyVersion, User, Watchlist, WatchlistItem
    from app.routers import chart
    from app.routers.public import optional_user

    now = datetime(2026, 10, 28, 12, tzinfo=UTC)
    monkeypatch.setattr(chart, "_now", lambda: now)
    monkeypatch.setattr(chart, "_redis", lambda: None)
    monkeypatch.setattr(settings, "billing_enabled", True)
    plan = SimpleNamespace(name="free")
    monkeypatch.setattr(ent_mod, "plan_for", lambda *a, **k: plan.name)
    with SessionLocal() as s:
        s.begin()
        try:
            inst = _instrument_row(s, "SIGTESTUSDT")
            stamp = datetime.now(tz=UTC).strftime("%H%M%S%f")
            strat = Strategy(slug="chart-signals-" + stamp, name="t")
            user = User(email=f"chart-signals-{stamp}@example.com", role="user")
            s.add_all([strat, user])
            s.flush()
            ver = StrategyVersion(strategy_id=strat.id, version="9.9.9", params={}, status="live")
            s.add(ver)
            s.flush()
            for i, (grade, hours) in enumerate((("A", 13), ("A", 1), ("B", 14), ("C", 30))):
                s.add(
                    Signal(
                        public_id=f"cs{stamp[-8:]}{i}", strategy_version_id=ver.id,
                        instrument_id=inst.id, direction="long",
                        candle_close_time=now - timedelta(hours=hours), entry_market=Decimal(100),
                        stop_loss=Decimal(95), tp1=Decimal(105), tp2=Decimal(110),
                        tp3=Decimal(120), rr_tp2=Decimal(2), score=80, grade=grade,
                        input_hash="x" * 64,
                    )
                )  # fmt: skip
            s.flush()
            app.dependency_overrides[auth.get_db] = lambda: s
            app.dependency_overrides[auth.current_user] = lambda: user
            app.dependency_overrides[optional_user] = lambda: user
            client = TestClient(app)
            urls = ("/v1/chart/signals?symbol=SIGTESTUSDT", "/v1/chart/layers?symbol=SIGTESTUSDT")

            def seen(url: str) -> list[tuple[str, int]]:
                r = client.get(url)
                assert r.status_code == 200, (url, r.text)
                return sorted((x["grade"], x["t"]) for x in r.json()["signals"])

            for url in urls:  # Free: инструмент не BTC/ETH и не в вотчлисте
                assert seen(url) == [], url
            wl = Watchlist(user_id=user.id)
            s.add(wl)
            s.flush()
            s.add(WatchlistItem(watchlist_id=wl.id, instrument_id=inst.id))
            s.flush()
            for url in urls:
                assert seen(url) == [("A", int((now - timedelta(hours=13)).timestamp()))], url
            plan.name = "pro"
            for url in urls:
                assert [g for g, _ in seen(url)] == ["A", "A", "B", "C"], url
        finally:
            app.dependency_overrides.clear()
            s.rollback()


# --- бюджет серверного времени (план 2B.4: p95 < 300 мс; B16: ≤ тривиальный запрос + 60 мс) ---

BUDGET_P95_MS = 300.0
BUDGET_OVER_TRIVIAL_MS = 60.0
BUDGET_SAMPLES = 20


def _timed(client: Any, url: str, n: int) -> list[float]:
    out = []
    for _ in range(n):
        t = time.perf_counter()
        client.get(url)
        out.append((time.perf_counter() - t) * 1000)
    return sorted(out)


BUDGET_NOW = datetime(2026, 10, 25, 23, 58, 40, tzinfo=UTC)
"""Воскресенье: текущая неделя почти полная (10 077 закрытых минут), 23:58 формируется. Время
запроса заморожено — результат не зависит от того, попал ли запуск на смену часа или недели."""


@db_only
def test_candles_server_time_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    """Свечи 1h (500 корзин = 30 000 минут) и 1w (текущая неделя до 10 080 минут) укладываются в
    p95 < 300 мс и p50 ≤ p50 тривиального запроса + 60 мс: агрегат в SQL, а не в Python."""
    from fastapi.testclient import TestClient

    from app import auth
    from app.db import SessionLocal
    from app.main import app
    from app.routers import chart

    now = BUDGET_NOW
    monkeypatch.setattr(chart, "_now", lambda: now)
    last = now.replace(second=0) - timedelta(minutes=1)  # последняя закрытая минута, 23:57
    minutes = [last - timedelta(minutes=i) for i in range(21 * 24 * 60, -1, -1)]
    with SessionLocal() as s:
        s.begin()
        try:
            inst = _instrument_row(s, "BUDGETTESTUSDT")
            rows = _m1_rows(inst.id, minutes, seed=3)
            _insert_m1(s, rows)
            prev = Candle(last, rows[-1]["open"], rows[-1]["high"], rows[-1]["low"],
                          rows[-1]["close"], rows[-1]["volume"])  # fmt: skip
            _insert_m1(s, [_forming(inst.id, last + timedelta(minutes=1), prev)])
            s.execute(text("analyze candles"))
            app.dependency_overrides[auth.get_db] = lambda: s
            client = TestClient(app)
            h1 = "/v1/chart/candles?symbol=BUDGETTESTUSDT&tf=1h"
            w1 = "/v1/chart/candles?symbol=BUDGETTESTUSDT&tf=1w"
            trivial = "/v1/chart/candles?symbol=NOSUCHUSDT&tf=1h"  # 404 после одного запроса
            body = client.get(h1).json()
            assert len(body["candles"]) == 500 and body["has_older"] is True
            assert body["candles"][-1]["open"] is True and body["current"] is None
            assert body["current_through"] == int(last.timestamp())
            body = client.get(w1).json()
            week = bucket_start(Timeframe.W1, now)
            assert (now - week) > timedelta(days=6, hours=23)
            assert body["current"]["t"] == int(week.timestamp())
            assert body["current_through"] == int(last.timestamp())
            base = _timed(client, trivial, BUDGET_SAMPLES)
            base_p50 = base[len(base) // 2]
            for url in (h1, w1):
                ms = _timed(client, url, BUDGET_SAMPLES)
                p50, p95 = ms[len(ms) // 2], ms[int(0.95 * (len(ms) - 1))]
                print(f"{url}: p50 {p50:.1f} мс, p95 {p95:.1f} мс; тривиальный p50 {base_p50:.1f}")
                assert p95 < BUDGET_P95_MS, (url, p95)
                assert p50 <= base_p50 + BUDGET_OVER_TRIVIAL_MS, (url, p50, base_p50)
        finally:
            app.dependency_overrides.pop(auth.get_db, None)
            s.rollback()
