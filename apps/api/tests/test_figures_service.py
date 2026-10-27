"""Сервис фигур (4B.6): условия алертов, тексты; на БД — синхронизация, статусы, отработка."""

from __future__ import annotations

import math
from datetime import UTC, datetime
from decimal import Decimal

import pytest

from app.alerts import condition_text, figure_matches, validate_condition
from app.models import Alert, FigureRow
from engine.candles import Timeframe


def test_figure_alert_condition_and_text() -> None:
    c = validate_condition("figure", {"types": ["double_top"], "dir": "down"}, "4h")
    assert c == {"types": ["double_top"], "dir": "down", "min_quality": 0.6}
    assert validate_condition("figure", {}, None)["types"] == []
    with pytest.raises(ValueError, match="неизвестная фигура"):
        validate_condition("figure", {"types": ["foo"]}, None)
    with pytest.raises(ValueError, match="таймфрейм"):
        validate_condition("figure", {}, "1h")
    a = Alert(type="figure", timeframe="4h", condition=c)
    assert condition_text(a, "BTCUSDT") == "BTCUSDT H4: подтверждена двойная вершина вниз"
    a2 = Alert(
        type="figure", timeframe=None, condition={"types": [], "dir": "any", "min_quality": 0.6}
    )
    assert condition_text(a2, None) == "вотчлист любой TF: подтверждена фигура"
    r = FigureRow(timeframe="4h", type="double_top", direction="down", quality=Decimal("0.7"))
    assert figure_matches(c, "4h", r) and not figure_matches(c, "1d", r)
    assert not figure_matches({**c, "min_quality": 0.9}, None, r)
    assert not figure_matches({**c, "types": ["flag"]}, None, r)
    assert not figure_matches({**c, "dir": "up"}, None, r)


def _db_available() -> bool:
    from sqlalchemy import text as _t
    from sqlalchemy.exc import DBAPIError, OperationalError

    from app.db import engine

    try:
        with engine.connect() as conn:
            conn.execute(_t("select 1 from figures limit 1"))
        return True
    except (OperationalError, DBAPIError):
        return False


db_only = pytest.mark.skipif(not _db_available(), reason="БД с миграциями недоступна")


def _path() -> list[float]:
    warm = [100 + 0.3 * math.sin(i / 2) for i in range(40)]

    def seg(a: float, b: float, n: int) -> list[float]:
        return [a + (b - a) * i / n for i in range(1, n + 1)]

    return (
        warm
        + seg(100, 110, 8)
        + seg(110, 104, 6)
        + seg(104, 110, 6)
        + seg(110, 103, 8)
        + seg(103, 96, 6)
        + seg(96, 99, 20)
    )


@db_only
def test_sync_backfill_outcomes_stats_and_immutability() -> None:
    from sqlalchemy import select, text

    from app.db import SessionLocal
    from app.figures import (
        backfill,
        chart_figures,
        evaluate_pending,
        recompute_stats,
        stats_payload,
        sync_live,
    )
    from app.models import FigureEvent, FigureOutcomeRow, FigureStatsSnapshot, Instrument
    from app.models.market import Candle as CandleRow

    path = _path()
    with SessionLocal() as s:
        s.begin()
        try:
            inst = Instrument(
                exchange="binance",
                symbol="FIGTESTUSDT",
                base="FT",
                quote="USDT",
                market_type="futures",
                tick_size=Decimal("0.01"),
                lot_size=Decimal("0.001"),
            )
            s.add(inst)
            s.flush()
            start = datetime(2026, 1, 1, tzinfo=UTC)
            tf = Timeframe.H4
            for i, v in enumerate(path):
                o = path[i - 1] if i else v
                hi = v + 0.4 if v >= o else max(o, v) + 0.05
                lo = min(o, v) - 0.05 if v >= o else v - 0.4
                s.add(
                    CandleRow(
                        instrument_id=inst.id,
                        timeframe="4h",
                        open_time=start + tf.delta * i,
                        open=Decimal(f"{o:.3f}"),
                        high=Decimal(f"{hi:.3f}"),
                        low=Decimal(f"{lo:.3f}"),
                        close=Decimal(f"{v:.3f}"),
                        volume=Decimal(10),
                        quote_volume=Decimal(0),
                        trades=1,
                        is_closed=True,
                    )
                )
            s.flush()
            # live до пробоя: двойная вершина «формируется»
            before = start + tf.delta * 66
            st = sync_live(s, inst, tf, before)
            row = s.scalar(
                select(FigureRow).where(
                    FigureRow.instrument_id == inst.id,
                    FigureRow.type == "double_top",
                    FigureRow.status == "forming",
                )
            )
            assert st["new"] >= 1 and row is not None and row.source == "live"
            ev = s.scalars(select(FigureEvent.type).where(FigureEvent.figure_id == row.id)).all()
            assert ev == ["detected_forming"]
            # после пробоя: та же строка становится confirmed, событие записано
            now = start + tf.delta * len(path)
            st2 = sync_live(s, inst, tf, now)
            s.refresh(row)
            assert (
                st2["confirmed"] >= 1 and row.status == "confirmed" and row.confirm_time is not None
            )
            assert row.target is not None and row.target == Decimal("96.8")
            assert (
                "confirmed"
                in s.scalars(select(FigureEvent.type).where(FigureEvent.figure_id == row.id)).all()
            )
            # триггер: подтверждённую геометрию менять нельзя
            with pytest.raises(Exception, match="не меняется"):
                s.execute(text("update figures set target = 1 where id = :i"), {"i": row.id})
                s.flush()
            s.rollback()
        finally:
            s.rollback()

    with SessionLocal() as s:
        s.begin()
        try:
            inst = Instrument(
                exchange="binance",
                symbol="FIGBACKUSDT",
                base="FB",
                quote="USDT",
                market_type="futures",
                tick_size=Decimal("0.01"),
                lot_size=Decimal("0.001"),
            )
            s.add(inst)
            s.flush()
            start = datetime(2026, 1, 1, tzinfo=UTC)
            tf = Timeframe.H4
            for i, v in enumerate(path):
                o = path[i - 1] if i else v
                hi = v + 0.4 if v >= o else max(o, v) + 0.05
                lo = min(o, v) - 0.05 if v >= o else v - 0.4
                s.add(
                    CandleRow(
                        instrument_id=inst.id,
                        timeframe="4h",
                        open_time=start + tf.delta * i,
                        open=Decimal(f"{o:.3f}"),
                        high=Decimal(f"{hi:.3f}"),
                        low=Decimal(f"{lo:.3f}"),
                        close=Decimal(f"{v:.3f}"),
                        volume=Decimal(10),
                        quote_volume=Decimal(0),
                        trades=1,
                        is_closed=True,
                    )
                )
            s.flush()
            now = start + tf.delta * len(path)
            r = backfill(s, inst, tf, now=now)
            assert r["new"] >= 1 and r["outcomes"] >= 1
            fig = s.scalar(
                select(FigureRow).where(
                    FigureRow.instrument_id == inst.id,
                    FigureRow.type == "double_top",
                    FigureRow.status == "confirmed",
                )
            )
            assert fig is not None and fig.source == "backfill"
            out = s.get(FigureOutcomeRow, fig.id)
            assert out is not None and out.target_hit is True and out.bars_to_target is not None
            assert backfill(s, inst, tf, now=now)["new"] == 0  # без дублей
            assert evaluate_pending(s, now) == 0
            n = recompute_stats(s, now)
            assert n >= 1
            snap = s.scalars(
                select(FigureStatsSnapshot).where(
                    FigureStatsSnapshot.type == "double_top", FigureStatsSnapshot.year.is_(None)
                )
            ).all()
            assert snap and snap[0].n >= 1
            payload = stats_payload(s, "4h", "backfill", "double_top")
            assert payload["items"][0]["low_n"] is True and "by_year" in payload
            cf = chart_figures(s, inst, tf, None, None)
            assert any(
                x["type"] == "double_top" and x["status"] == "confirmed" and x["lines"]
                for x in cf["items"]
            )
            assert cf["stats"]["double_top"]["title"] == "Двойная вершина"
        finally:
            s.rollback()


@db_only
def test_insert_or_existing_survives_concurrent_insert() -> None:
    """Гонка бэкфилла и live-детектора: такая же фигура уже записана — берём её, не падаем."""
    from app.db import SessionLocal
    from app.figures import _insert_or_existing
    from app.models import Instrument

    with SessionLocal() as s:
        s.begin()
        try:
            inst = Instrument(
                exchange="binance",
                symbol="FIGRACEUSDT",
                base="FR",
                quote="USDT",
                market_type="futures",
                tick_size=Decimal("0.01"),
                lot_size=Decimal("0.001"),
            )
            s.add(inst)
            s.flush()
            t0 = datetime(2026, 1, 1, tzinfo=UTC)
            vals = {
                "type": "double_bottom",
                "direction": "up",
                "status": "forming",
                "scale": 2,
                "start_time": t0,
                "end_time": datetime(2026, 1, 3, tzinfo=UTC),
                "known_time": datetime(2026, 1, 3, 4, tzinfo=UTC),
                "confirm_time": None,
                "invalidated_time": None,
                "geometry": {},
                "breakout_level": None,
                "target": None,
                "invalidation": None,
                "quality": Decimal("0.6"),
                "metrics": {},
                "rules_version": "figures@1.0.0",
            }
            first, ins1 = _insert_or_existing(s, inst, Timeframe.H4, dict(vals), "live")
            second, ins2 = _insert_or_existing(s, inst, Timeframe.H4, dict(vals), "backfill")
            assert ins1 and not ins2
            assert second.id == first.id and second.source == "live"
            # транзакция жива: можно продолжать писать
            s.flush()
        finally:
            s.rollback()
