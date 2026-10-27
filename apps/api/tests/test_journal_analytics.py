"""Аналитика журнала (план 3.8 v2): группировки, кривая капитала, типовые ошибки."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from app.journal_analytics import TradeRow, analytics, equity_curve, risk_usd, typical_errors

T0 = datetime(2026, 1, 5, 12, tzinfo=UTC)  # понедельник


def row(
    i: int,
    r: str | None,
    *,
    symbol: str = "BTCUSDT",
    signal_id: int | None = None,
    grade: str | None = None,
    system_r: str | None = None,
    size: str | None = None,
    stop: str | None = "98",
) -> TradeRow:
    return TradeRow(
        symbol=symbol,
        direction="long",
        entry_at=T0 + timedelta(days=i),
        exit_at=(T0 + timedelta(days=i, hours=8)) if r is not None else None,
        entry_price=Decimal(100),
        stop_loss=Decimal(stop) if stop else None,
        size=Decimal(size) if size else None,
        realized_r=Decimal(r) if r is not None else None,
        signal_id=signal_id,
        grade=grade,
        system_r=Decimal(system_r) if system_r else None,
    )


def test_groups_equity_and_drawdown() -> None:
    rows = [
        row(0, "2", signal_id=1, grade="A", system_r="2.5"),
        row(1, "-1", symbol="ETHUSDT"),
        row(2, "-1", symbol="ETHUSDT"),
        row(3, None),
    ]
    a = analytics(rows, None, None)
    assert a["total"] == {
        "trades": 4,
        "closed": 3,
        "sum_r": "0",
        "avg_r": "0",
        "winrate": 1 / 3,
    }
    wd = {b["key"]: b for b in a["by_weekday"]}
    assert wd[0]["sum_r"] == "2" and wd[1]["winrate"] == 0 and wd[3]["closed"] == 0
    sym = {b["key"]: b for b in a["by_symbol"]}
    assert (
        sym["ETHUSDT"]["sum_r"] == "-2" and a["by_symbol"][0]["key"] == "BTCUSDT"
    )  # 2:2, по имени
    grades = [b["key"] for b in a["by_grade"]]
    assert grades == ["A", "none"]
    eq = a["equity"]
    assert [p["r"] for p in eq["points"]] == ["2", "1", "0"]
    assert eq["max_drawdown_r"] == "2"
    assert equity_curve([]) == {"points": [], "max_drawdown_r": None}


def test_typical_errors() -> None:
    rows = [
        # по сигналу, вышел с 1R при 2.5R у системы — ранний выход
        row(0, "1", signal_id=1, grade="A", system_r="2.5", size="10"),
        # по сигналу, разница меньше 0.5R — не ошибка
        row(1, "2.2", signal_id=2, grade="B", system_r="2.5", size="1"),
        # без сигнала, риск 2 × 60 = 120 USDT > бюджет 100 × 1.1
        row(2, "-1", size="60"),
        # без стопа — риск не считается
        row(3, None, stop=None, size="5"),
    ]
    e = typical_errors(rows, Decimal(10000), Decimal("1.00"))
    assert e["early_exit"] == {"count": 1, "of": 2}
    assert e["no_signal"] == {"count": 2, "of": 4}
    assert e["risk_exceeded"] == {"count": 1, "of": 3, "budget_usd": "100"}
    assert risk_usd(rows[0]) == Decimal(20) and risk_usd(rows[3]) is None
    # без депозита превышение риска не оценивается
    e2 = typical_errors(rows, None, Decimal("1.00"))
    assert e2["risk_exceeded"] == {"count": 0, "of": 0, "budget_usd": None}
