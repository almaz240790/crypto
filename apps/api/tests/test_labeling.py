"""Разметка фигур (4B.2): каппа Коэна, согласие; на БД — очередь, метка, статистика."""

from __future__ import annotations

import pytest

from app.labeling import cohen_kappa, consensus


def test_cohen_kappa() -> None:
    assert cohen_kappa(["a", "b", "a", "b"], ["a", "b", "a", "b"]) == 1.0
    assert cohen_kappa(["a", "a", "b", "b"], ["a", "b", "a", "b"]) == 0.0
    k = cohen_kappa(["f", "f", "n", "n", "u", "f"], ["f", "f", "n", "u", "u", "n"])
    assert k is not None and 0.3 < k < 0.7
    assert cohen_kappa(["a"], ["a"]) is None and cohen_kappa(["a", "b"], ["a"]) is None
    assert cohen_kappa(["a", "a"], ["a", "a"]) == 1.0  # pe == 1


def test_consensus() -> None:
    assert consensus(["figure", "figure", "unsure"]) == "figure"
    assert consensus(["figure", "not_figure", "unsure"]) is None
    assert consensus(["figure"]) is None
    assert consensus([]) is None
    assert consensus(["not_figure", "not_figure"]) == "not_figure"


def _db_available() -> bool:
    from sqlalchemy import text as _t
    from sqlalchemy.exc import DBAPIError, OperationalError

    from app.db import engine

    try:
        with engine.connect() as conn:
            conn.execute(_t("select 1 from ml_labels limit 1"))
        return True
    except (OperationalError, DBAPIError):
        return False


db_only = pytest.mark.skipif(not _db_available(), reason="БД с миграциями недоступна")


@db_only
def test_queue_label_and_stats() -> None:
    import random
    from datetime import UTC, datetime
    from decimal import Decimal

    from app.db import SessionLocal
    from app.labeling import next_candidate, stats
    from app.models import FigureRow, Instrument, MlLabel, User

    with SessionLocal() as s:
        s.begin()
        try:
            u1 = User(email="label1@example.com", password_hash="x", role="admin")
            u2 = User(email="label2@example.com", password_hash="x", role="admin")
            inst = Instrument(
                exchange="binance",
                symbol="LBLTESTUSDT",
                base="LT",
                quote="USDT",
                market_type="futures",
                tick_size=Decimal("0.01"),
                lot_size=Decimal("0.001"),
            )
            s.add_all([u1, u2, inst])
            s.flush()
            t0 = datetime(2026, 1, 1, tzinfo=UTC)
            figs = []
            for typ in ("double_top", "flag", "flag"):
                f = FigureRow(
                    instrument_id=inst.id,
                    timeframe="4h",
                    type=typ,
                    direction="down",
                    status="confirmed",
                    scale=2,
                    start_time=t0,
                    end_time=t0,
                    known_time=t0,
                    geometry={},
                    quality=Decimal("0.7"),
                    metrics={},
                    rules_version="figures@1.0.0",
                    source="backfill",
                )
                s.add(f)
                figs.append(f)
            s.flush()
            # очередь: оба размечают все три; второй разметчик расходится на одном
            for u, labels in (
                (u1, ["figure", "not_figure", "unsure"]),
                (u2, ["figure", "not_figure", "figure"]),
            ):
                seen: set[int] = set()
                for _ in range(3):
                    c = next_candidate(s, u, random.Random(1))
                    assert c is not None and c.id not in seen
                    seen.add(c.id)
                    s.add(
                        MlLabel(
                            candidate_figure_id=c.id,
                            labeler_id=u.id,
                            label=labels[len(seen) - 1],
                            time_spent_s=10,
                        )
                    )
                    s.flush()
                assert next_candidate(s, u) is None or next_candidate(s, u).instrument_id != inst.id  # type: ignore[union-attr]
            st = stats(s)
            ours = [x for x in st["labelers"] if x["id"] in (u1.id, u2.id)]
            assert len(ours) == 2 and all(x["n"] == 3 and x["avg_time_s"] == 10 for x in ours)
            pair = next(k for k in st["kappa"] if {k["a"], k["b"]} == {u1.id, u2.id})
            assert pair["n"] == 3 and pair["kappa"] is not None
            assert st["candidates_labeled"] >= 3 and st["target_per_type"] == 600
        finally:
            s.rollback()
