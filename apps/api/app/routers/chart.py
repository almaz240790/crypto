"""/v1/chart — данные терминала (план 2A.3, 2B.4): свечи порциями, текущая свеча, слои."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import redis
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import auth
from app.chart_data import (
    LAYER_TFS,
    PAGE,
    candle_dict,
    current_candle,
    layers_cached,
    load_candles,
    signal_layer,
)
from app.config import settings
from app.entitlements import entitlements_for
from app.models import Instrument, User
from app.routers.public import optional_user
from engine.candles import Timeframe

router = APIRouter(prefix="/v1/chart", tags=["chart"])
INTRADAY = {Timeframe.M1, Timeframe.M5, Timeframe.M15}


def _instrument(db: Session, symbol: str) -> Instrument:
    inst = db.scalar(select(Instrument).where(Instrument.symbol == symbol.upper()))
    if inst is None:
        raise HTTPException(404, "инструмент не найден")
    return inst


def _tf(tf: str) -> Timeframe:
    try:
        return Timeframe(tf)
    except ValueError as exc:
        raise HTTPException(400, "таймфрейм: 1m, 5m, 15m, 1h, 4h, 1d, 1w") from exc


@router.get("/candles")
def candles(
    symbol: str,
    tf: str = "4h",
    before: int | None = Query(None, description="unix-время: отдать свечи строго раньше"),
    limit: int = Query(PAGE, ge=20, le=PAGE),
    user: User | None = Depends(optional_user),
    db: Session = Depends(auth.get_db),
) -> dict[str, Any]:
    """Закрытые свечи порцией (по умолчанию последние 500) и текущая незакрытая свеча."""
    timeframe = _tf(tf)
    ent = entitlements_for(db, user)
    if timeframe in INTRADAY and not ent.intraday:
        raise HTTPException(403, "таймфреймы 1m–15m доступны на тарифе Pro")
    inst = _instrument(db, symbol)
    now = datetime.now(tz=UTC)
    b = datetime.fromtimestamp(before, tz=UTC) if before else None
    rows, has_older = load_candles(db, inst.id, timeframe, b, limit)
    # последняя хранимая свеча tf может быть ещё не закрыта — помечаем
    out = [candle_dict(c, open_=c.open_time + timeframe.delta > now) for c in rows]
    cur = None
    if b is None and timeframe is not Timeframe.M1:
        last_open = rows[-1].open_time if rows else None
        c = current_candle(db, inst.id, timeframe, now)
        if c is not None and (last_open is None or c.open_time > last_open):
            cur = candle_dict(c, open_=True)
    return {
        "symbol": inst.symbol,
        "tf": timeframe.value,
        "candles": out,
        "current": cur,
        "has_older": has_older,
        "tick_size": str(inst.tick_size) if inst.tick_size is not None else None,
        "server_time": now.isoformat(),
    }


@router.get("/layers")
def layers(
    symbol: str,
    tf: str = "4h",
    user: User | None = Depends(optional_user),
    db: Session = Depends(auth.get_db),
) -> dict[str, Any]:
    """Слои: структура (swing, BOS/CHoCH), зоны, уровни, равные уровни, снятия, bias — по tf ≥ 1h;
    сигналы инструмента (live; forward — по правам). Кэш 60 с."""
    timeframe = _tf(tf)
    inst = _instrument(db, symbol)
    now = datetime.now(tz=UTC)
    ent = entitlements_for(db, user)
    r: Any | None
    try:
        r = redis.from_url(settings.redis_url, socket_timeout=2)
    except Exception:
        r = None
    structure = layers_cached(db, r, inst, timeframe, now) if timeframe in LAYER_TFS else None
    scopes = ["live"]
    if user is not None and (user.role in ("admin", "owner") or ent.forward_scope):
        scopes.append("forward")
    signals = signal_layer(db, inst, scopes) if user is not None else []
    return {
        "symbol": inst.symbol,
        "tf": timeframe.value,
        "structure": structure,
        "signals": signals,
        "server_time": now.isoformat(),
    }
