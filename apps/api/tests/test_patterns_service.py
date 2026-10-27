"""Сервис паттернов (2B.11): чистые функции; при доступной БД — запись, бэкфилл, отработка."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace

import pytest

from app.patterns import rules_json, snapshot_dict, snapshot_rows, wilson
from app.workers.pattern_detector import done_key, tfs_for_event
from engine.candles import Timeframe
from engine.patterns import DEFAULT_PATTERN_PARAMS

D = Decimal


def test_wilson() -> None:
    low, high = wilson(50, 100)
    assert D("0.40") < low < D("0.41") and D("0.59") < high < D("0.60")
    assert wilson(0, 0) == (D(0), D(0))
    assert wilson(30, 30)[1] == D(1)
    assert wilson(0, 30)[0] == D(0)


def test_rules_json_serialisable() -> None:
    r = rules_json(DEFAULT_PATTERN_PARAMS)
    assert r["rules_version"] == "candles@1.0.0"
    assert r["engulf_body"] == "1.2" and r["outcome_horizons"] == [3, 5, 10]


def test_snapshot_rows_and_dict() -> None:
    now = datetime(2026, 10, 27, tzinfo=UTC)
    rows = [
        SimpleNamespace(
            type="engulfing",
            timeframe="4h",
            source="backfill",
            horizon_bars=5,
            instrument_id=None,
            is_significant=None,
            year=None,
            n=40,
            k=22,
            fav=1.4,
            adv=0.8,
            ps=now - timedelta(days=30),
            pe=now,
        ),
        SimpleNamespace(
            type="doji",
            timeframe="4h",
            source="backfill",
            horizon_bars=5,
            instrument_id=None,
            is_significant=True,
            year=2025,
            n=5,
            k=3,
            fav=None,
            adv=None,
            ps=now,
            pe=now,
        ),
    ]
    out = snapshot_rows(rows, now)
    assert out[0]["success_rate"] == D("0.55") and out[0]["ci_low"] < D("0.55") < out[0]["ci_high"]
    assert (
        out[0]["with_context"] is None and out[1]["with_context"] is True and out[1]["year"] == 2025
    )
    big = SimpleNamespace(**out[0], id=1)
    small = SimpleNamespace(**out[1], id=2)
    d = snapshot_dict(big, "engulfing", 5)
    assert d["low_n"] is False and d["success_rate"] == "0.55" and d["n"] == 40
    assert d["title"] == "Бычье поглощение / Медвежье поглощение"
    s = snapshot_dict(small, "doji", 5)
    assert (
        s["low_n"] is True and s["success_rate"] is None and s["n"] == 5 and s["title"] == "Доджи"
    )
    none = snapshot_dict(None, "harami", 3)
    assert none["n"] == 0 and none["low_n"] is True


def test_tfs_for_event_and_key() -> None:
    t = datetime(2026, 10, 27, 12, 0, tzinfo=UTC)
    assert tfs_for_event("4h", t) == [Timeframe.H4]
    assert tfs_for_event("1w", t) == [Timeframe.W1]
    assert tfs_for_event("1m", t) == [Timeframe.M15, Timeframe.H1]
    assert tfs_for_event("1m", t.replace(minute=45)) == [Timeframe.M15]
    assert tfs_for_event("1m", t.replace(minute=7)) == []
    assert tfs_for_event("5m", t) == []
    assert done_key("BTCUSDT", Timeframe.M15, t) == "patt:done:BTCUSDT:15m:20261027T1200"


# --- на реальной БД (как в CI) --------------------------------------------------------------------


def _db_available() -> bool:
    from sqlalchemy import text as _t
    from sqlalchemy.exc import DBAPIError, OperationalError

    from app.db import engine

    try:
        with engine.connect() as conn:
            conn.execute(_t("select 1 from patterns limit 1"))
        return True
    except (OperationalError, DBAPIError):
        return False


db_only = pytest.mark.skipif(not _db_available(), reason="БД с миграциями недоступна")


@db_only
def test_backfill_outcomes_stats_and_live_idempotent() -> None:
    from sqlalchemy import select, text

    from app.db import SessionLocal
    from app.models import Instrument, Pattern, PatternEvent, PatternOutcome, PatternStatsSnapshot
    from app.models.market import Candle as CandleRow
    from app.patterns import (
        backfill,
        detect_and_store,
        evaluate_outcomes,
        recompute_stats,
        stats_payload,
    )

    with SessionLocal() as s:
        s.begin()
        try:
            inst = Instrument(
                exchange="binance",
                symbol="PATTTESTUSDT",
                base="PT",
                quote="USDT",
                market_type="futures",
                tick_size=Decimal("0.01"),
                lot_size=Decimal("0.001"),
            )
            s.add(inst)
            s.flush()
            start = datetime(2026, 1, 1, tzinfo=UTC)
            tf = Timeframe.H4
            # 80 свечей разогрева с дрейфом, затем бычье поглощение после снижения и рост
            rows: list[tuple[str, str, str, str, str]] = [
                (
                    f"{100 + i / 1000:.3f}",
                    f"{102 + i / 1000:.3f}",
                    f"{99 + i / 1000:.3f}",
                    f"{101 + i / 1000:.3f}",
                    "10",
                )
                for i in range(80)
            ]
            rows += [
                ("100", "100.5", "98.5", "99", "10"),
                ("99", "99.5", "97.5", "98", "10"),
                ("98", "98.5", "96.5", "97", "10"),
                ("97", "97.2", "96.3", "96.4", "10"),
                ("96.4", "98", "96.2", "97.8", "20"),
            ]
            rows += [
                (f"{97.8 + i}", f"{99 + 2 * i}", "97", f"{98.5 + 1.5 * i}", "10") for i in range(12)
            ]
            for i, (o, h, lo, c, v) in enumerate(rows):
                s.add(
                    CandleRow(
                        instrument_id=inst.id,
                        timeframe="4h",
                        open_time=start + tf.delta * i,
                        open=Decimal(o),
                        high=Decimal(h),
                        low=Decimal(lo),
                        close=Decimal(c),
                        volume=Decimal(v),
                        quote_volume=Decimal(0),
                        trades=1,
                        is_closed=True,
                    )
                )
            s.flush()
            now = start + tf.delta * len(rows)
            r = backfill(s, inst, tf, now=now)
            assert r["patterns"] >= 1
            eng = s.scalar(
                select(Pattern).where(Pattern.instrument_id == inst.id, Pattern.type == "engulfing")
            )
            assert (
                eng is not None
                and eng.direction == "up"
                and eng.is_significant
                and eng.source == "backfill"
            )
            assert eng.status == "outcome_recorded"
            outs = s.scalars(
                select(PatternOutcome).where(PatternOutcome.pattern_id == eng.id)
            ).all()
            assert sorted(o.horizon_bars for o in outs) == [3, 5, 10]
            assert all(o.moved_expected for o in outs)
            evs = s.scalars(
                select(PatternEvent.type).where(PatternEvent.pattern_id == eng.id)
            ).all()
            assert set(evs) == {"confirmed", "outcome_recorded"}
            # повторный бэкфилл — без дублей
            r2 = backfill(s, inst, tf, now=now)
            assert r2["patterns"] == 0
            # триггер: геометрию менять нельзя, статус — можно
            with pytest.raises(Exception, match="не меняется"):
                s.execute(text("update patterns set geometry = '{}' where id = :i"), {"i": eng.id})
                s.flush()
        finally:
            s.rollback()

    with SessionLocal() as s:
        s.begin()
        try:
            inst = Instrument(
                exchange="binance",
                symbol="PATTLIVEUSDT",
                base="PL",
                quote="USDT",
                market_type="futures",
                tick_size=Decimal("0.01"),
                lot_size=Decimal("0.001"),
            )
            s.add(inst)
            s.flush()
            start = datetime(2026, 1, 1, tzinfo=UTC)
            tf = Timeframe.H4
            rows = [
                (
                    f"{100 + i / 1000:.3f}",
                    f"{102 + i / 1000:.3f}",
                    f"{99 + i / 1000:.3f}",
                    f"{101 + i / 1000:.3f}",
                    "10",
                )
                for i in range(80)
            ] + [("100", "102.05", "99.95", "102", "10")]  # марубозу на последней свече
            for i, (o, h, lo, c, v) in enumerate(rows):
                s.add(
                    CandleRow(
                        instrument_id=inst.id,
                        timeframe="4h",
                        open_time=start + tf.delta * i,
                        open=Decimal(o),
                        high=Decimal(h),
                        low=Decimal(lo),
                        close=Decimal(c),
                        volume=Decimal(v),
                        quote_volume=Decimal(0),
                        trades=1,
                        is_closed=True,
                    )
                )
            s.flush()
            now = start + tf.delta * len(rows)
            live = detect_and_store(s, inst, tf, now)
            assert [p.type for p in live] == ["marubozu"] and live[0].source == "live"
            assert detect_and_store(s, inst, tf, now) == []  # идемпотентно
            # отработки ещё нет — мало свечей
            assert evaluate_outcomes(s, now=now) == 0
            for i in range(5):
                j = len(rows) + i
                s.add(
                    CandleRow(
                        instrument_id=inst.id,
                        timeframe="4h",
                        open_time=start + tf.delta * j,
                        open=Decimal("102"),
                        high=Decimal(str(104 + 2 * i)),
                        low=Decimal("101.5"),
                        close=Decimal(str(103 + 1.5 * i)),
                        volume=Decimal(10),
                        quote_volume=Decimal(0),
                        trades=1,
                        is_closed=True,
                    )
                )
            s.flush()
            later = start + tf.delta * (len(rows) + 5)
            n = evaluate_outcomes(s, now=later)
            assert n == 2  # горизонты 3 и 5; 10 — позже
            p = s.get(Pattern, live[0].id)
            assert p is not None and p.status == "confirmed"
            n_snap = recompute_stats(s, now=later)
            assert n_snap >= 1
            snap = s.scalars(
                select(PatternStatsSnapshot).where(
                    PatternStatsSnapshot.type == "marubozu",
                    PatternStatsSnapshot.scope == "live",
                    PatternStatsSnapshot.instrument_id.is_(None),
                    PatternStatsSnapshot.with_context.is_(None),
                    PatternStatsSnapshot.year.is_(None),
                    PatternStatsSnapshot.horizon_bars == 3,
                )
            ).all()
            assert len(snap) == 1 and snap[0].n >= 1
            payload = stats_payload(s, "4h", "live", 3, "marubozu", None, None)
            item = payload["items"][0]
            assert (
                item["type"] == "marubozu"
                and item["low_n"] is True
                and item["success_rate"] is None
            )
            assert "by_year" in payload and "by_context" in payload
        finally:
            s.rollback()
