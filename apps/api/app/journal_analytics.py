"""Аналитика журнала сделок (план 3.8, v2): по дням недели, инструментам, градациям; кривая
капитала в R; типовые ошибки — ранний выход, вход без сигнала, превышение риска.
Чистые функции без БД: роутер собирает строки и профиль риска."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any

# допуск на превышение риска: комиссии и округление размера
RISK_TOLERANCE = Decimal("1.10")
# «ранний выход»: сделка по сигналу закрыта в плюс, но заметно хуже результата сигнала по трекеру
EARLY_EXIT_GAP_R = Decimal("0.5")


@dataclass(frozen=True)
class TradeRow:
    symbol: str
    direction: str
    entry_at: datetime
    exit_at: datetime | None
    entry_price: Decimal
    stop_loss: Decimal | None
    size: Decimal | None
    realized_r: Decimal | None
    signal_id: int | None
    grade: str | None  # градация связанного сигнала (A/B/C) или None
    system_r: Decimal | None  # результат того же сигнала по трекеру


def _fmt(x: Decimal | None) -> str | None:
    return None if x is None else format(x.normalize(), "f")


def _bucket(rows: list[TradeRow]) -> dict[str, Any]:
    rs = [r.realized_r for r in rows if r.realized_r is not None]
    total = sum(rs, Decimal(0))
    return {
        "trades": len(rows),
        "closed": len(rs),
        "sum_r": _fmt(total) if rs else "0",
        "avg_r": _fmt(total / len(rs)) if rs else None,
        "winrate": (sum(1 for r in rs if r > 0) / len(rs)) if rs else None,
    }


def _group(rows: list[TradeRow], key: Any) -> list[dict[str, Any]]:
    groups: dict[Any, list[TradeRow]] = {}
    for r in rows:
        groups.setdefault(key(r), []).append(r)
    return [{"key": k, **_bucket(v)} for k, v in groups.items()]


def risk_usd(r: TradeRow) -> Decimal | None:
    """Риск сделки в валюте котировки: |вход − стоп| × размер."""
    if r.stop_loss is None or r.size is None:
        return None
    return abs(r.entry_price - r.stop_loss) * r.size


def equity_curve(rows: list[TradeRow]) -> dict[str, Any]:
    """Накопленный R по закрытым сделкам (по времени выхода, иначе входа) и макс. просадка."""
    closed = sorted(
        (r for r in rows if r.realized_r is not None), key=lambda r: r.exit_at or r.entry_at
    )
    points: list[dict[str, Any]] = []
    cum = Decimal(0)
    peak = Decimal(0)
    dd = Decimal(0)
    for r in closed:
        cum += r.realized_r or Decimal(0)
        peak = max(peak, cum)
        dd = max(dd, peak - cum)
        points.append({"t": (r.exit_at or r.entry_at).isoformat(), "r": _fmt(cum)})
    return {"points": points, "max_drawdown_r": _fmt(dd) if closed else None}


def typical_errors(
    rows: list[TradeRow], deposit: Decimal | None, risk_pct: Decimal | None
) -> dict[str, Any]:
    linked_closed = [r for r in rows if r.signal_id is not None and r.realized_r is not None]
    early = [
        r
        for r in linked_closed
        if r.system_r is not None
        and r.system_r > 0
        and r.realized_r is not None
        and r.realized_r < r.system_r - EARLY_EXIT_GAP_R
    ]
    no_signal = [r for r in rows if r.signal_id is None]
    budget = (
        deposit * risk_pct / Decimal(100) if deposit is not None and risk_pct is not None else None
    )
    with_risk = [r for r in rows if risk_usd(r) is not None]
    exceeded = (
        [r for r in with_risk if (risk_usd(r) or Decimal(0)) > budget * RISK_TOLERANCE]
        if budget is not None and budget > 0
        else []
    )
    return {
        "early_exit": {"count": len(early), "of": len(linked_closed)},
        "no_signal": {"count": len(no_signal), "of": len(rows)},
        "risk_exceeded": {
            "count": len(exceeded),
            "of": len(with_risk) if budget is not None and budget > 0 else 0,
            "budget_usd": _fmt(budget) if budget is not None else None,
        },
    }


def analytics(
    rows: list[TradeRow], deposit: Decimal | None, risk_pct: Decimal | None
) -> dict[str, Any]:
    """Полный ответ /v1/journal/analytics."""
    by_weekday = _group(rows, lambda r: r.entry_at.weekday())
    by_weekday.sort(key=lambda b: b["key"])
    by_symbol = _group(rows, lambda r: r.symbol)
    by_symbol.sort(key=lambda b: (-b["trades"], b["key"]))
    by_grade = _group(rows, lambda r: r.grade or "none")
    by_grade.sort(key=lambda b: {"A": 0, "B": 1, "C": 2}.get(b["key"], 9))
    return {
        "total": _bucket(rows),
        "by_weekday": by_weekday,
        "by_symbol": by_symbol,
        "by_grade": by_grade,
        "equity": equity_curve(rows),
        "errors": typical_errors(rows, deposit, risk_pct),
    }
