"""/v1/chart — данные терминала (план 2A.3, 2B.4): свечи порциями, текущая свеча, слои."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import redis
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import auth
from app.chart_data import (
    LAYER_TFS,
    PAGE,
    _dec,
    candle_dict,
    current_candle,
    layers_cached,
    load_candles,
    load_derivatives,
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
        # фиксированная запись: str(Decimal) даёт '1.000E-7', и клиент считал 6 знаков вместо 7
        "tick_size": _dec(inst.tick_size),
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


@router.get("/patterns")
def patterns(
    symbol: str,
    tf: str = "4h",
    since: int | None = Query(None, description="unix-секунды, по закрытию свечи"),
    until: int | None = None,
    limit: int = Query(300, ge=1, le=1000),
    db: Session = Depends(auth.get_db),
) -> dict[str, Any]:
    """Свечные паттерны инструмента на таймфрейме (план 2A.10.1, 2B.12): отметки с контекстом
    и историческая отработка по типам. Доступно всем — это часть открытой статистики."""
    from app.patterns import chart_patterns

    timeframe = _tf(tf)
    inst = _instrument(db, symbol)
    s = datetime.fromtimestamp(since, tz=UTC) if since else None
    u = datetime.fromtimestamp(until, tz=UTC) if until else None
    return chart_patterns(db, inst, timeframe, s, u, limit)


@router.get("/figures")
def figures(
    symbol: str,
    tf: str = "4h",
    since: int | None = None,
    until: int | None = None,
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(auth.get_db),
) -> dict[str, Any]:
    """Графические фигуры инструмента (план 2A.10.2, 4B.6): формируется / подтверждена /
    отменена, с линиями, целью и исторической отработкой типа. Доступно всем."""
    from app.figures import chart_figures

    timeframe = _tf(tf)
    inst = _instrument(db, symbol)
    s = datetime.fromtimestamp(since, tz=UTC) if since else None
    u = datetime.fromtimestamp(until, tz=UTC) if until else None
    return chart_figures(db, inst, timeframe, s, u, limit)


class ExplainIn(BaseModel):
    symbol: str = Field(max_length=32)
    tf: str = Field(pattern="^(15m|1h|4h|1d|1w)$")
    pattern_id: int


class AskIn(BaseModel):
    symbol: str = Field(max_length=32)
    tf: str = Field(pattern="^(15m|1h|4h|1d|1w)$")
    question: str = Field(min_length=1, max_length=500)


@router.post("/ask")
def ask(
    body: AskIn,
    user: User = Depends(auth.current_user),
    db: Session = Depends(auth.get_db),
) -> dict[str, Any]:
    """Вопрос о текущем графике (план 2A.10.3; 4B.7): только Premium, текст пользователя ≤ 500
    символов передаётся как данные, ответ проходит постпроверку чисел, кэш 1 ч."""
    from app.llm import ask_chart

    timeframe = _tf(body.tf)
    inst = _instrument(db, body.symbol)
    r: Any | None
    try:
        r = redis.from_url(settings.redis_url, socket_timeout=2)
    except Exception:
        r = None
    return ask_chart(db, r, user, inst, timeframe, body.question)


@router.post("/explain")
def explain(
    body: ExplainIn,
    user: User = Depends(auth.current_user),
    db: Session = Depends(auth.get_db),
) -> dict[str, Any]:
    """Объяснение найденного паттерна по фактам (план 2A.10.3; 2B.14). Free — шаблонный текст;
    Pro/Premium — текст модели с постпроверкой чисел, кэш 24 ч, лимит запросов в сутки."""
    from app.llm import explain_pattern
    from app.models import Pattern

    timeframe = _tf(body.tf)
    inst = _instrument(db, body.symbol)
    p = db.get(Pattern, body.pattern_id)
    if p is None or p.instrument_id != inst.id or p.timeframe != timeframe.value:
        raise HTTPException(404, "паттерн не найден")
    r: Any | None
    try:
        r = redis.from_url(settings.redis_url, socket_timeout=2)
    except Exception:
        r = None
    return explain_pattern(db, r, user, inst, timeframe, p)


@router.get("/derivatives")
def derivatives(
    symbol: str,
    tf: str = "4h",
    before: int | None = Query(None),
    limit: int = Query(PAGE, ge=20, le=PAGE),
    user: User | None = Depends(optional_user),
    db: Session = Depends(auth.get_db),
) -> dict[str, Any]:
    """Панели funding / OI / ликвидаций, выровненные по корзинам tf, за окно ``limit`` свечей."""
    timeframe = _tf(tf)
    inst = _instrument(db, symbol)
    until = datetime.fromtimestamp(before, tz=UTC) if before else None
    end = until or datetime.now(tz=UTC)
    since = end - timeframe.delta * limit
    return {
        "symbol": inst.symbol,
        "tf": timeframe.value,
        **load_derivatives(db, inst.id, timeframe, since, until),
    }
