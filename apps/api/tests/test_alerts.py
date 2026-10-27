"""Алерты (2B.13): условия, частота, тексты; на БД — лимит, срабатывание, идемпотентность."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from app.alerts import (
    condition_text,
    indicator_hit,
    may_trigger,
    pattern_matches,
    price_hit,
    structure_hit,
    validate_condition,
    zone_hit,
)
from app.models import Alert, Pattern
from app.workers.alerts import done_key
from engine.candles import Candle, Timeframe

D = Decimal
T0 = datetime(2026, 1, 1, tzinfo=UTC)


def mk(o: str, h: str, lo: str, c: str, i: int = 0, tf: Timeframe = Timeframe.M1) -> Candle:
    return Candle(T0 + tf.delta * i, D(o), D(h), D(lo), D(c), D(10))


def test_validate_condition() -> None:
    assert validate_condition("price", {"op": "cross_up", "price": 100}, None) == {
        "op": "cross_up",
        "price": "100",
    }
    r = validate_condition("price", {"op": "enter_range", "price": "90", "price2": "95"}, None)
    assert r["price2"] == "95"
    with pytest.raises(ValueError, match="совпадают"):
        validate_condition("price", {"op": "enter_range", "price": "90", "price2": "90"}, None)
    with pytest.raises(ValueError, match="не число"):
        validate_condition("price", {"op": "cross_up", "price": "abc"}, None)
    with pytest.raises(ValueError, match="cross_up"):
        validate_condition("price", {"op": "touch", "price": "1"}, None)
    ind = validate_condition("indicator", {"indicator": "rsi", "op": "above", "value": 70}, "4h")
    assert ind == {"indicator": "rsi", "op": "above", "period": 14, "value": "70"}
    assert validate_condition(
        "indicator", {"indicator": "ema", "op": "price_cross_up", "period": 20}, "1h"
    ) == {"indicator": "ema", "op": "price_cross_up", "period": 20}
    with pytest.raises(ValueError, match="таймфрейм"):
        validate_condition("indicator", {"indicator": "rsi", "op": "above", "value": 70}, "1m")
    with pytest.raises(ValueError, match="не поддерживается"):
        validate_condition("indicator", {"indicator": "rsi", "op": "price_cross_up"}, "4h")
    assert validate_condition("zone", {}, "4h") == {"kind": "any", "dir": "any"}
    with pytest.raises(ValueError, match="4h или 1d"):
        validate_condition("zone", {}, "1h")
    assert validate_condition("structure", {"event": "bos", "dir": "up"}, "1d") == {
        "event": "bos",
        "dir": "up",
    }
    p = validate_condition("pattern", {"types": ["engulfing"], "significant_only": 1}, None)
    assert p == {"types": ["engulfing"], "dir": "any", "significant_only": True}
    with pytest.raises(ValueError, match="неизвестный паттерн"):
        validate_condition("pattern", {"types": ["foo"]}, None)
    with pytest.raises(ValueError, match="неизвестный тип"):
        validate_condition("drawing", {}, None)


def test_price_hit() -> None:
    up = {"op": "cross_up", "price": "100"}
    assert price_hit(up, D("99"), mk("99", "100.5", "98", "100.2")) == D(100)
    assert price_hit(up, D("99"), mk("99", "99.9", "98", "99.5")) is None
    assert price_hit(up, D("101"), mk("101", "102", "100", "101.5")) is None  # уже выше
    down = {"op": "cross_down", "price": "100"}
    assert price_hit(down, D("101"), mk("101", "101.5", "99.5", "99.8")) == D(100)
    assert price_hit(down, D("99"), mk("99", "99.5", "98", "98.5")) is None
    rng = {"op": "enter_range", "price": "95", "price2": "90"}
    assert price_hit(rng, D("97"), mk("97", "97.5", "94", "94.5")) == D("94.5")
    assert price_hit(rng, D("93"), mk("93", "94", "92", "93.5")) is None  # уже внутри
    assert price_hit(rng, D("97"), mk("97", "98", "96", "96.5")) is None


def rising(n: int, tf: Timeframe = Timeframe.H4) -> list[Candle]:
    return [mk(str(100 + i), str(101.5 + i), str(99.5 + i), str(101 + i), i, tf) for i in range(n)]


def test_indicator_hit() -> None:
    cs = rising(60)
    price, details = indicator_hit(
        {"indicator": "rsi", "op": "above", "period": 14, "value": "70"}, cs
    )
    assert price == cs[-1].close and D(details["value"]) > 70
    assert indicator_hit({"indicator": "rsi", "op": "below", "period": 14, "value": "70"}, cs) == (
        None,
        {},
    )
    assert indicator_hit(
        {"indicator": "rsi", "op": "above", "period": 14, "value": "70"}, cs[:5]
    ) == (None, {})
    # EMA(5) растёт медленнее цены: цена выше EMA, пересечения вверх на последней свече нет
    assert indicator_hit({"indicator": "ema", "op": "price_cross_up", "period": 5}, cs)[0] is None
    # падение после роста: close уходит под EMA
    drop = [*cs, mk("160", "160", "140", "141", 60, Timeframe.H4)]
    p, d = indicator_hit({"indicator": "ema", "op": "price_cross_down", "period": 5}, drop)
    assert p == D(141) and "value" in d
    # пересечение порога ATR
    big = [*cs, mk("160", "175", "150", "170", 60, Timeframe.H4)]
    p2, _ = indicator_hit({"indicator": "atr", "op": "cross_up", "period": 14, "value": "2.5"}, big)
    assert p2 == D(170)
    assert indicator_hit(
        {"indicator": "atr", "op": "cross_down", "period": 14, "value": "2.5"}, big
    ) == (None, {})


def test_zone_and_structure_need_history() -> None:
    assert zone_hit({"kind": "any", "dir": "any"}, rising(10)) is None
    assert structure_hit({"event": "any", "dir": "any"}, rising(10)) is None
    # ровный рост без свингов — событий и зон нет
    assert structure_hit({"event": "any", "dir": "any"}, rising(80)) is None
    assert zone_hit({"kind": "any", "dir": "any"}, rising(80)) is None


def test_structure_hit_on_bos() -> None:
    # волна: рост, откат, пробой максимума на последней свече → BOS вверх
    cs: list[Candle] = []
    seq = [100, 101, 102, 103, 104, 105, 104, 103, 102, 101, 102, 103, 104, 105, 106.5]
    base = [100 + (i % 3) * 0.1 for i in range(60)]
    for i, v in enumerate(base + seq):
        cs.append(mk(str(v - 0.3), str(v + 0.4), str(v - 0.6), str(v), i, Timeframe.H4))
    hit = structure_hit({"event": "any", "dir": "any"}, cs)
    assert hit is not None and hit["dir"] == "up" and hit["event"] in ("bos", "choch")
    assert structure_hit({"event": "any", "dir": "down"}, cs) is None
    assert (
        structure_hit({"event": "any", "dir": "any"}, cs[:-1]) is None
        or cs[-2].close < cs[-1].close
    )


def test_pattern_matches_and_frequency() -> None:
    p = Pattern(timeframe="4h", type="engulfing", direction="up", is_significant=False)
    assert pattern_matches({"types": [], "dir": "any", "significant_only": False}, None, p)
    assert pattern_matches(
        {"types": ["engulfing"], "dir": "up", "significant_only": False}, "4h", p
    )
    assert not pattern_matches(
        {"types": ["doji"], "dir": "any", "significant_only": False}, None, p
    )
    assert not pattern_matches({"types": [], "dir": "down", "significant_only": False}, None, p)
    assert not pattern_matches({"types": [], "dir": "any", "significant_only": True}, None, p)
    assert not pattern_matches({"types": [], "dir": "any", "significant_only": False}, "1d", p)
    now = datetime(2026, 1, 1, 12, 30, tzinfo=UTC)
    a = Alert(
        status="active", frequency="once", triggers_count=0, expires_at=now + timedelta(days=1)
    )
    assert may_trigger(a, now)
    a.triggers_count = 1
    assert not may_trigger(a, now)
    a.frequency = "every"
    assert may_trigger(a, now)
    a.status = "paused"
    assert not may_trigger(a, now)
    a.status = "active"
    a.expires_at = now - timedelta(seconds=1)
    assert not may_trigger(a, now)
    a.expires_at = None
    a.frequency = "once_per_bar"
    a.timeframe = "4h"
    a.last_triggered_at = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
    assert not may_trigger(a, now)  # та же свеча H4 (12:00–16:00)
    assert may_trigger(a, datetime(2026, 1, 1, 16, 0, tzinfo=UTC))
    a.timeframe = None
    assert may_trigger(a, datetime(2026, 1, 1, 12, 31, tzinfo=UTC))  # новая минута


def test_condition_text() -> None:
    a = Alert(type="price", condition={"op": "cross_up", "price": "65000.0"})
    assert condition_text(a, "BTCUSDT") == "BTCUSDT: цена пересекла 65000 вверх"
    a = Alert(type="price", condition={"op": "enter_range", "price": "95", "price2": "90"})
    assert condition_text(a, "X") == "X: цена вошла в диапазон 90–95"
    a = Alert(
        type="indicator",
        timeframe="4h",
        condition={"indicator": "rsi", "op": "above", "period": 14, "value": "70"},
    )
    assert condition_text(a, "BTCUSDT") == "BTCUSDT H4: RSI(14) выше 70"
    a = Alert(
        type="indicator",
        timeframe="1h",
        condition={"indicator": "ema", "op": "price_cross_down", "period": 50},
    )
    assert condition_text(a, "ETHUSDT") == "ETHUSDT 1H: цена пересекла EMA(50) вниз"
    a = Alert(type="zone", timeframe="1d", condition={"kind": "ob", "dir": "up"})
    assert condition_text(a, "X") == "X 1D: цена вошла в активную зону OB спроса"
    a = Alert(type="structure", timeframe="4h", condition={"event": "choch", "dir": "down"})
    assert condition_text(a, "X") == "X H4: CHOCH вниз"
    a = Alert(
        type="pattern",
        timeframe=None,
        condition={"types": ["engulfing", "doji"], "dir": "any", "significant_only": True},
    )
    t = condition_text(a, None)
    assert (
        t.startswith("вотчлист любой TF: подтверждён")
        and "поглощение" in t
        and "Доджи" in t
        and "(значимый)" in t
    )
    for word in ("рекоменд", "покуп", "прода", "предсказ"):
        assert word not in t.lower()
    assert (
        done_key("BTCUSDT", "1m", datetime(2026, 1, 1, 12, 5, tzinfo=UTC))
        == "alerts:done:BTCUSDT:1m:20260101T1205"
    )


# --- на реальной БД (как в CI) --------------------------------------------------------------------


def _db_available() -> bool:
    from sqlalchemy import text as _t
    from sqlalchemy.exc import DBAPIError, OperationalError

    from app.db import engine

    try:
        with engine.connect() as conn:
            conn.execute(_t("select 1 from alerts limit 1"))
        return True
    except (OperationalError, DBAPIError):
        return False


db_only = pytest.mark.skipif(not _db_available(), reason="БД с миграциями недоступна")


@db_only
def test_price_alert_trigger_idempotent_and_limit() -> None:
    from sqlalchemy import select

    from app.alerts import active_count, evaluate_price, expire, trigger
    from app.db import SessionLocal
    from app.entitlements import ENTITLEMENTS
    from app.models import AlertTrigger, Instrument, User
    from app.models.market import Candle as CandleRow

    with SessionLocal() as s:
        s.begin()
        try:
            user = User(email="alerts-test@example.com", password_hash="x", role="user")
            s.add(user)
            inst = Instrument(
                exchange="binance",
                symbol="ALRTTESTUSDT",
                base="AT",
                quote="USDT",
                market_type="futures",
                tick_size=Decimal("0.01"),
                lot_size=Decimal("0.001"),
            )
            s.add(inst)
            s.flush()
            t0 = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
            for i, (o, h, lo, c) in enumerate(
                [("99", "99.5", "98.5", "99.2"), ("99.2", "100.6", "99", "100.4")]
            ):
                s.add(
                    CandleRow(
                        instrument_id=inst.id,
                        timeframe="1m",
                        open_time=t0 + timedelta(minutes=i),
                        open=Decimal(o),
                        high=Decimal(h),
                        low=Decimal(lo),
                        close=Decimal(c),
                        volume=Decimal(1),
                        quote_volume=Decimal(0),
                        trades=1,
                        is_closed=True,
                    )
                )
            a = Alert(
                user_id=user.id,
                instrument_id=inst.id,
                type="price",
                condition={"op": "cross_up", "price": "100"},
                frequency="once",
                expires_at=t0 + timedelta(days=30),
                status="active",
            )
            s.add(a)
            s.flush()
            close_time = t0 + timedelta(minutes=2)
            assert evaluate_price(s, inst, close_time) == 1
            assert a.status == "triggered" and a.triggers_count == 1
            trig = s.scalar(select(AlertTrigger).where(AlertTrigger.alert_id == a.id))
            assert trig is not None and trig.price == Decimal(100)
            # повтор — идемпотентно
            a.status = "active"
            a.triggers_count = 0
            assert trigger(s, a, close_time, Decimal(100), {}) is None
            assert evaluate_price(s, inst, close_time) == 0
            # лимит Free = 3 активных, истечение
            assert (
                ENTITLEMENTS["free"].alerts_limit == 3
                and ENTITLEMENTS["premium"].alerts_limit is None
            )
            old = Alert(
                user_id=user.id,
                instrument_id=inst.id,
                type="price",
                condition={"op": "cross_up", "price": "1"},
                frequency="once",
                expires_at=t0 - timedelta(days=1),
                status="active",
            )
            s.add(old)
            s.flush()
            assert active_count(s, user.id) == 2
            assert expire(s, t0) == 1 and old.status == "expired"
        finally:
            s.rollback()
