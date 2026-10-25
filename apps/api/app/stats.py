"""Публичная статистика сигналов (план 2.11, 3.10): считается из signals + signal_results
тем же кодом, что бэктест (``engine.backtest.summarize``). Ручного ввода нет."""

from __future__ import annotations

from dataclasses import asdict
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from engine.backtest import (
    BacktestTrade,
    Metrics,
    TradeResult,
    TradeStatus,
    breakdown,
    equity_curve,
    summarize,
)
from engine.scoring import Grade
from engine.structure import Direction

STATUS_TO_RESULT = {
    "closed_sl": TradeStatus.CLOSED_SL,
    "closed_be": TradeStatus.CLOSED_BE,
    "closed_tp3": TradeStatus.CLOSED_TP3,
    "closed_time": TradeStatus.CLOSED_TIME,
    "expired": TradeStatus.EXPIRED,
    "cancelled": TradeStatus.CLOSED_TIME,  # 0 R, учитывается как закрытая (план 2.10)
}
HITS = {"closed_tp3": 3, "tp2_hit": 2, "tp1_hit": 1}


def load_trades(
    session: Session,
    scope: str = "live",
    strategy_version_id: int | None = None,
    instrument: str | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
) -> list[BacktestTrade]:
    """Сигналы версий стратегии в статусе ``scope`` (live/forward) как сделки бэктеста."""
    where = ["sv.status = :scope"]
    params: dict[str, Any] = {"scope": scope}
    if strategy_version_id is not None:
        where.append("sv.id = :svid")
        params["svid"] = strategy_version_id
    if instrument:
        where.append("i.symbol = :sym")
        params["sym"] = instrument.upper()
    if since:
        where.append("s.candle_close_time >= :since")
        params["since"] = since
    if until:
        where.append("s.candle_close_time < :until")
        params["until"] = until
    rows = session.execute(
        text(
            "select i.symbol, s.direction, s.candle_close_time, s.grade, s.score, s.rr_tp2, "
            "s.entry_market, s.stop_loss, s.tp1, s.tp2, s.tp3, s.status, "
            "r.realized_r, r.realized_r_tp1_only, r.realized_r_full_tp2, r.max_favorable_r, "
            "r.max_adverse_r, r.closed_at, s.public_id "
            "from signals s join instruments i on i.id = s.instrument_id "
            "join strategy_versions sv on sv.id = s.strategy_version_id "
            "left join signal_results r on r.signal_id = s.id "
            f"where {' and '.join(where)} order by s.candle_close_time"
        ),
        params,
    ).all()
    out: list[BacktestTrade] = []
    for r in rows:
        status = r[11]
        tstatus = STATUS_TO_RESULT.get(status, TradeStatus.OPEN)
        result = TradeResult(
            status=tstatus,
            realized_r=r[12] if r[12] is not None else Decimal(0),
            r_if_tp1_only=r[13],
            r_if_full_tp2=r[14],
            tp_hits=HITS.get(status, 0),
            entry_index=0,
            exit_index=0 if tstatus not in (TradeStatus.OPEN, TradeStatus.EXPIRED) else None,
            max_favorable_r=r[15] or Decimal(0),
            max_adverse_r=r[16] or Decimal(0),
            cost_r=Decimal(0),
        )
        out.append(
            BacktestTrade(
                symbol=r[0],
                direction=Direction.UP if r[1] == "long" else Direction.DOWN,
                signal_time=r[2],
                grade=Grade(r[3]),
                score=r[4],
                rr_tp2=r[5],
                entry=r[6],
                stop=r[7],
                tp1=r[8],
                tp2=r[9],
                tp3=r[10],
                result=result,
                exit_time=r[17],
                facts=(r[18],),  # public_id — для ссылок из таблицы
            )
        )
    return out


def _m(m: Metrics) -> dict[str, Any]:
    d = asdict(m)
    return {k: (float(round(v, 4)) if isinstance(v, Decimal) else v) for k, v in d.items()}


def stats_payload(trades: list[BacktestTrade]) -> dict[str, Any]:
    return {
        "metrics": _m(summarize(trades)),
        "by_grade": {k: _m(v) for k, v in breakdown(trades, lambda t: t.grade.value).items()},
        "by_symbol": {k: _m(v) for k, v in breakdown(trades, lambda t: t.symbol).items()},
        "by_month": {
            k: _m(v)
            for k, v in breakdown(trades, lambda t: t.signal_time.strftime("%Y-%m")).items()
        },
        "by_direction": {
            k: _m(v) for k, v in breakdown(trades, lambda t: t.direction.value).items()
        },
        "equity": [{"t": t.isoformat(), "r": float(round(v, 3))} for t, v in equity_curve(trades)],
        "worst_drawdowns": worst_drawdowns(trades),
    }


def worst_drawdowns(trades: list[BacktestTrade], n: int = 3) -> list[dict[str, Any]]:
    """Три самые глубокие просадки с датами (план 3.10 «Худшие периоды»)."""
    closed = sorted((t for t in trades if t.result.closed), key=lambda t: t.signal_time)
    eq = peak = Decimal(0)
    peak_t: datetime | None = None
    cur: dict[str, Any] | None = None
    out: list[dict[str, Any]] = []
    for t in closed:
        eq += t.realized_r
        when = t.exit_time or t.signal_time
        if eq >= peak:
            if cur is not None:
                out.append(cur)
                cur = None
            peak, peak_t = eq, when
        else:
            depth = peak - eq
            if cur is None or depth > cur["depth_r"]:
                cur = {
                    "start": (peak_t or when).isoformat(),
                    "trough": when.isoformat(),
                    "depth_r": float(round(depth, 2)),
                }
    if cur is not None:
        out.append(cur)
    return sorted(out, key=lambda d: -d["depth_r"])[:n]
