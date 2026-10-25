"""Снимки статистики (план 2.4): метрики снимка совпадают с бэктестером на том же наборе."""

from __future__ import annotations

from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from app.snapshots import Key, build
from app.stats import stats_payload
from engine.backtest import BacktestTrade, TradeResult, TradeStatus, summarize
from engine.scoring import Grade
from engine.structure import Direction


def _trade(sym: str, grade: Grade, r: str, day: int) -> BacktestTrade:
    t = datetime(2026, 3, 1, tzinfo=UTC) + timedelta(days=day)
    status = TradeStatus.CLOSED_TP3 if Decimal(r) > 0 else TradeStatus.CLOSED_SL
    res = TradeResult(status, Decimal(r), None, None, 0, 0, 0, Decimal(0), Decimal(0), Decimal(0))
    return BacktestTrade(
        sym, Direction.UP, t, grade, 70, Decimal(2), Decimal(1), Decimal(0), Decimal(2),
        Decimal(3), Decimal(4), res, t + timedelta(hours=4), ("sig", "market"),
    )  # fmt: skip


TRADES = [
    _trade("BTCUSDT", Grade.A, "2", 0),
    _trade("ETHUSDT", Grade.B, "-1", 1),
    _trade("BTCUSDT", Grade.A, "-1", 2),
    _trade("ETHUSDT", Grade.A, "2.5", 3),
    _trade("SOLUSDT", Grade.C, "-1", 4),
]


def _metrics(trades: list[BacktestTrade]) -> dict[str, object]:
    return {
        k: (float(round(v, 4)) if isinstance(v, Decimal) else v)
        for k, v in asdict(summarize(trades)).items()
    }


def test_build_matches_backtester() -> None:
    snaps = build("forward", 7, TRADES)
    assert snaps[Key("forward", 7, None, None)]["metrics"] == _metrics(TRADES)
    assert snaps[Key("forward", 7, None, "A")]["metrics"] == _metrics(
        [t for t in TRADES if t.grade is Grade.A]
    )
    assert snaps[Key("forward", 7, "ETHUSDT", None)]["metrics"] == _metrics(
        [t for t in TRADES if t.symbol == "ETHUSDT"]
    )
    # ключи: все + 3 градации + 3 инструмента
    assert len(snaps) == 7
    # снимок = ровно тот JSON, что отдаёт API на лету
    assert snaps[Key("forward", 7, None, None)] == stats_payload(TRADES)


def test_build_empty() -> None:
    snaps = build("live", None, [])
    assert list(snaps) == [Key("live", None, None, None)]
    assert snaps[Key("live", None, None, None)]["metrics"]["closed"] == 0
