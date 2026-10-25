"""/v1/instruments, /v1/signals, /v1/stats — публичные данные (план 3.4, 3.5, 3.10).

Видны только сигналы версий стратегии в статусе ``live``. Задержка для Free и доступ к
активным сигналам — этап 3 (тарифы); сейчас все эндпоинты без ограничений для залогиненных,
а без логина — только закрытые сигналы и агрегированная статистика.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app import auth
from app.models import Instrument, Signal, SignalEvent, SignalResult, StrategyVersion, User
from app.stats import load_trades, stats_payload
from engine.candles import Timeframe

router = APIRouter(prefix="/v1", tags=["public"])
OPEN_STATUSES = ("pending", "active", "tp1_hit", "tp2_hit")


def optional_user(request: Request, db: Session = Depends(auth.get_db)) -> User | None:
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("bearer "):
        return None
    try:
        payload = auth.decode_access_token(header[7:])
    except HTTPException:
        return None
    return db.get(User, int(payload["sub"]))


def _dec(x: Decimal | None) -> str | None:
    return None if x is None else format(x.normalize(), "f")


@router.get("/instruments")
def instruments(db: Session = Depends(auth.get_db)) -> list[dict[str, Any]]:
    rows = db.scalars(
        select(Instrument).where(Instrument.is_active).order_by(Instrument.symbol)
    ).all()
    return [
        {
            "id": i.id,
            "symbol": i.symbol,
            "base": i.base,
            "quote": i.quote,
            "exchange": i.exchange,
            "market_type": i.market_type,
            "tick_size": _dec(i.tick_size),
            "lot_size": _dec(i.lot_size),
        }
        for i in rows
    ]


def _signal_dict(
    s: Signal, symbol: str, version: str, result: SignalResult | None
) -> dict[str, Any]:
    return {
        "id": s.public_id,
        "symbol": symbol,
        "strategy_version": version,
        "direction": s.direction,
        "candle_close_time": s.candle_close_time.isoformat(),
        "created_at": s.created_at.isoformat(),
        "entry_market": _dec(s.entry_market),
        "entry_limit": _dec(s.entry_limit),
        "stop_loss": _dec(s.stop_loss),
        "tp1": _dec(s.tp1),
        "tp2": _dec(s.tp2),
        "tp3": _dec(s.tp3),
        "rr_tp2": _dec(s.rr_tp2),
        "score": s.score,
        "grade": s.grade,
        "status": s.status,
        "flags": (s.rationale_facts or {}).get("flags", []),
        "result": None
        if result is None
        else {
            "realized_r": _dec(result.realized_r),
            "closed_at": result.closed_at.isoformat(),
            "duration_hours": _dec(result.duration_hours),
            "max_favorable_r": _dec(result.max_favorable_r),
            "max_adverse_r": _dec(result.max_adverse_r),
        },
    }


@router.get("/signals")
def signals(
    status: str | None = Query(None, description="open | closed | all"),
    symbol: str | None = None,
    grade: str | None = None,
    direction: str | None = None,
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    user: User | None = Depends(optional_user),
    db: Session = Depends(auth.get_db),
) -> dict[str, Any]:
    q = (
        select(Signal, Instrument.symbol, StrategyVersion.version)
        .join(Instrument, Instrument.id == Signal.instrument_id)
        .join(StrategyVersion, StrategyVersion.id == Signal.strategy_version_id)
        .where(StrategyVersion.status == "live")
    )
    if user is None:
        q = q.where(Signal.status.not_in(OPEN_STATUSES))  # без логина — только закрытые
    elif status == "open":
        q = q.where(Signal.status.in_(OPEN_STATUSES))
    elif status == "closed":
        q = q.where(Signal.status.not_in(OPEN_STATUSES))
    if symbol:
        q = q.where(Instrument.symbol == symbol.upper())
    if grade:
        q = q.where(Signal.grade == grade.upper())
    if direction:
        q = q.where(Signal.direction == direction)
    rows = db.execute(q.order_by(Signal.candle_close_time.desc()).limit(limit).offset(offset)).all()
    ids = [r[0].id for r in rows]
    results = (
        {
            r.signal_id: r
            for r in db.scalars(select(SignalResult).where(SignalResult.signal_id.in_(ids))).all()
        }
        if ids
        else {}
    )
    return {
        "items": [_signal_dict(s, sym, ver, results.get(s.id)) for s, sym, ver in rows],
        "limit": limit,
        "offset": offset,
    }


@router.get("/signals/{public_id}")
def signal_detail(
    public_id: str,
    user: User | None = Depends(optional_user),
    db: Session = Depends(auth.get_db),
) -> dict[str, Any]:
    row = db.execute(
        select(Signal, Instrument.symbol, StrategyVersion.version, StrategyVersion.status)
        .join(Instrument, Instrument.id == Signal.instrument_id)
        .join(StrategyVersion, StrategyVersion.id == Signal.strategy_version_id)
        .where(Signal.public_id == public_id)
    ).first()
    if row is None or row[3] != "live":
        raise HTTPException(404)
    s, symbol, version, _ = row
    if user is None and s.status in OPEN_STATUSES:
        raise HTTPException(403, "активные сигналы доступны после входа")
    out = _signal_dict(s, symbol, version, db.get(SignalResult, s.id))
    out["facts"] = (s.rationale_facts or {}).get("facts", [])
    out["zone"] = (s.rationale_facts or {}).get("zone")
    out["score_breakdown"] = s.score_breakdown
    out["events"] = [
        {
            "type": e.type,
            "price": _dec(e.price),
            "at": e.occurred_at.isoformat(),
            "source": e.source,
        }
        for e in db.scalars(
            select(SignalEvent)
            .where(SignalEvent.signal_id == s.id)
            .order_by(SignalEvent.occurred_at)
        ).all()
    ]
    return out


@router.get("/signals/{public_id}/candles")
def signal_candles(
    public_id: str,
    tf: str = "4h",
    before: int = Query(150, ge=20, le=400),
    after: int = Query(60, ge=0, le=400),
    user: User | None = Depends(optional_user),
    db: Session = Depends(auth.get_db),
) -> dict[str, Any]:
    """Свечи вокруг сигнальной — для графика в карточке."""
    s = db.scalar(select(Signal).where(Signal.public_id == public_id))
    if s is None:
        raise HTTPException(404)
    if user is None and s.status in OPEN_STATUSES:
        raise HTTPException(403)
    timeframe = Timeframe(tf)
    start = s.candle_close_time - timeframe.delta * (before + 1)
    end = s.candle_close_time + timeframe.delta * after
    rows = db.execute(
        text(
            "select open_time, open, high, low, close, volume from candles "
            "where instrument_id=:i and timeframe=:tf and open_time>=:a and open_time<:b "
            "order by open_time"
        ),
        {"i": s.instrument_id, "tf": timeframe.value, "a": start, "b": end},
    ).all()
    return {
        "tf": tf,
        "candles": [
            {
                "t": int(r[0].timestamp()),
                "o": _dec(r[1]),
                "h": _dec(r[2]),
                "l": _dec(r[3]),
                "c": _dec(r[4]),
                "v": _dec(r[5]),
            }
            for r in rows
        ],
    }


@router.get("/stats")
def stats(
    scope: str = Query("live", pattern="^(live|forward)$"),
    strategy_version_id: int | None = None,
    symbol: str | None = None,
    days: int | None = Query(None, ge=1, le=3650),
    user: User | None = Depends(optional_user),
    db: Session = Depends(auth.get_db),
) -> dict[str, Any]:
    """Публичная статистика. ``forward`` — только admin/owner (форвард не публикуется)."""
    if scope == "forward" and (user is None or user.role not in ("admin", "owner")):
        raise HTTPException(403, "статистика форварда не публикуется")
    since = datetime.now(tz=UTC) - timedelta(days=days) if days else None
    trades = load_trades(db, scope, strategy_version_id, symbol, since)
    payload = stats_payload(trades)
    payload["scope"] = scope
    payload["generated_at"] = datetime.now(tz=UTC).isoformat()
    return payload
