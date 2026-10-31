"""/v1/chart — данные терминала (план 2A.3, 2B.4): свечи порциями, текущая свеча, слои.

Кэширование ответов — :mod:`app.http_cache` (Cache-Control по варианту, слабый ETag, 304).
Все новые параметры (``view``, ``ids``, ``series``) необязательны: без них ответы прежние.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal

import redis
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import auth
from app.chart_data import (
    DERIV_SERIES,
    LAYER_TFS,
    PAGE,
    _dec,
    bucket_start,
    candle_dict,
    chart_view,
    current_bar,
    layers_cached,
    load_candles,
    load_derivatives,
    signal_layer,
)
from app.config import settings
from app.entitlements import (
    Entitlements,
    allowed_instrument_ids,
    entitlements_for,
    visible_since,
)
from app.http_cache import (
    CANDLES_HISTORY,
    CANDLES_LATEST,
    DERIVATIVES,
    LAYERS_CHART,
    OBJECTS,
    PRIVATE_NO_CACHE,
    PRIVATE_NO_STORE,
    Policy,
    json_response,
)
from app.models import Instrument, User
from app.routers.public import optional_user
from engine.candles import Timeframe

router = APIRouter(prefix="/v1/chart", tags=["chart"])
INTRADAY = {Timeframe.M1, Timeframe.M5, Timeframe.M15}
View = Literal["chart"]
VIEW_DOC = "chart — только то, что рисует график (меньше ответ, общий кэш)"


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


def _ts(x: int | None) -> datetime | None:
    return datetime.fromtimestamp(x, tz=UTC) if x else None


def _now() -> datetime:
    """Время запроса — одно на обработчик (тесты подменяют, чтобы не зависеть от часов)."""
    return datetime.now(tz=UTC)


def _redis() -> Any | None:
    try:
        return redis.from_url(settings.redis_url, socket_timeout=2)
    except Exception:
        return None


def _signal_scopes(user: User, ent: Entitlements) -> list[str]:
    """live — всем вошедшим; forward — по правам тарифа и админам."""
    scopes = ["live"]
    if user.role in ("admin", "owner") or ent.forward_scope:
        scopes.append("forward")
    return scopes


def _visible_signals(
    db: Session, user: User, inst: Instrument, now: datetime
) -> list[dict[str, Any]]:
    """Сигналы инструмента по правам тарифа — те же ограничения, что у ``/v1/signals``: версии
    (live; forward — Premium и админам), градации, задержка после закрытия свечи и инструменты
    (Free — BTC, ETH и вотчлист; чужой инструмент — пустой список)."""
    ent = entitlements_for(db, user, now)
    allowed = allowed_instrument_ids(db, user, ent)
    if allowed is not None and inst.id not in allowed:
        return []
    return signal_layer(
        db, inst, _signal_scopes(user, ent), ent.signal_grades, visible_since(ent, now)
    )


@router.get("/candles")
def candles(
    request: Request,
    symbol: str,
    tf: str = "4h",
    before: int | None = Query(None, description="unix-время: отдать свечи строго раньше"),
    limit: int = Query(PAGE, ge=20, le=PAGE),
    user: User | None = Depends(optional_user),
    db: Session = Depends(auth.get_db),
) -> Response:
    """Закрытые свечи порцией (по умолчанию последние 500) и текущая незакрытая свеча.

    Незакрытая свеча (``current`` или последняя в ``candles`` с ``open: true``) для tf ≥ 5m —
    свёртка закрытых минут текущего интервала, ``current_through`` — open time самой новой из них
    (одним запросом со свёрткой): клиент досворачивает минуты новее неё. ``null`` — свёртки нет
    (история, 1m, в интервале ещё нет закрытых минут: тогда открытая 4h/1d/1w — снимок биржи)."""
    timeframe = _tf(tf)
    ent = entitlements_for(db, user)
    if timeframe in INTRADAY and not ent.intraday:
        raise HTTPException(403, "таймфреймы 1m–15m доступны на тарифе Pro")
    inst = _instrument(db, symbol)
    now = _now()
    b = _ts(before)
    rows, has_older = load_candles(db, inst.id, timeframe, b, limit)
    # последняя хранимая свеча tf может быть ещё не закрыта — помечаем
    out = [candle_dict(c, open_=c.open_time + timeframe.delta > now) for c in rows]
    cur = None
    through: datetime | None = None
    if b is None and timeframe is not Timeframe.M1:
        bar = current_bar(db, inst.id, timeframe, now)
        if bar is not None:
            c, through = bar
            if rows and rows[-1].open_time == c.open_time:
                # та же корзина: открытая свеча порции (снимок биржи 4h/1d/1w или корзина
                # 5m/15m/1h другого запроса) заменяется свёрткой, согласованной с through
                out[-1] = candle_dict(c, open_=True)
            elif not rows or c.open_time > rows[-1].open_time:
                cur = candle_dict(c, open_=True)
            else:
                through = None  # порция новее интервала now — свёртка к ней не относится
    payload = {
        "symbol": inst.symbol,
        "tf": timeframe.value,
        "candles": out,
        "current": cur,
        "current_through": int(through.timestamp()) if through is not None else None,
        "has_older": has_older,
        # фиксированная запись: str(Decimal) даёт '1.000E-7', и клиент считал 6 знаков вместо 7
        "tick_size": _dec(inst.tick_size),
        "server_time": now.isoformat(),
    }
    cache: Policy
    if timeframe in INTRADAY:
        cache = PRIVATE_NO_STORE  # права тарифа
    elif b is not None and b <= bucket_start(timeframe, now):
        cache = CANDLES_HISTORY  # только закрытые свечи — порция не меняется
    else:
        cache = CANDLES_LATEST
    return json_response(request, payload, cache)


@router.get("/layers")
def layers(
    request: Request,
    symbol: str,
    tf: str = "4h",
    view: View | None = Query(None, description=VIEW_DOC),
    user: User | None = Depends(optional_user),
    db: Session = Depends(auth.get_db),
) -> Response:
    """Слои: структура (swing, BOS/CHoCH), зоны, уровни, равные уровни, снятия, bias — по tf ≥ 1h;
    сигналы инструмента (live; forward — по правам). Кэш 60 с.

    ``view=chart`` — только структура в объёме графика (без swing-ов, активные зоны, последние
    12 событий и снятий, не снятые равные уровни) и без ``signals``: ответ не зависит от
    пользователя и кэшируется публично. Сигналы для графика — ``/v1/chart/signals``."""
    timeframe = _tf(tf)
    inst = _instrument(db, symbol)
    now = _now()
    structure = None
    if timeframe in LAYER_TFS:
        structure = layers_cached(db, _redis(), inst, timeframe, now)
    payload: dict[str, Any]
    if view == "chart":
        payload = {
            "symbol": inst.symbol,
            "tf": timeframe.value,
            "structure": chart_view(structure),
            "server_time": now.isoformat(),
        }
        return json_response(request, payload, LAYERS_CHART)
    signals = _visible_signals(db, user, inst, now) if user is not None else []
    payload = {
        "symbol": inst.symbol,
        "tf": timeframe.value,
        "structure": structure,
        "signals": signals,
        "server_time": now.isoformat(),
    }
    return json_response(request, payload, PRIVATE_NO_CACHE)


@router.get("/signals")
def chart_signals(
    request: Request,
    symbol: str,
    user: User = Depends(auth.current_user),
    db: Session = Depends(auth.get_db),
) -> Response:
    """Сигналы инструмента для слоя графика (нужен вход) по правам тарифа, как ``/v1/signals``:
    live (forward — Premium), градации, задержка, инструменты. Те же элементы, что ``signals``
    в ``/layers`` без ``view``."""
    inst = _instrument(db, symbol)
    now = _now()
    payload = {
        "symbol": inst.symbol,
        "signals": _visible_signals(db, user, inst, now),
        "server_time": now.isoformat(),
    }
    return json_response(request, payload, PRIVATE_NO_STORE)


def _parse_ids(raw: str) -> list[int]:
    try:
        ids = sorted({int(x) for x in raw.split(",") if x.strip()})
    except ValueError as exc:
        raise HTTPException(400, "ids: номера через запятую") from exc
    from app.patterns import IDS_MAX

    if not ids or len(ids) > IDS_MAX:
        raise HTTPException(400, f"ids: от 1 до {IDS_MAX} номеров")
    return ids


@router.get("/patterns")
def patterns(
    request: Request,
    symbol: str,
    tf: str = "4h",
    since: int | None = Query(None, description="unix-секунды, по закрытию свечи"),
    until: int | None = None,
    limit: int = Query(300, ge=1, le=1000),
    view: View | None = Query(None, description=VIEW_DOC + "; есть total"),
    ids: str | None = Query(None, description="id через запятую (≤ 20): полные элементы"),
    db: Session = Depends(auth.get_db),
) -> Response:
    """Свечные паттерны инструмента на таймфрейме (план 2A.10.1, 2B.12): отметки с контекстом
    и историческая отработка по типам. Доступно всем — это часть открытой статистики.

    ``view=chart`` — без ``source``/``tf``, ``context`` только у значимых, плюс ``total``;
    ``ids=`` — только эти отметки полными элементами (с контекстом)."""
    from app.patterns import chart_patterns

    timeframe = _tf(tf)
    id_list = _parse_ids(ids) if ids is not None else None
    inst = _instrument(db, symbol)
    payload = chart_patterns(
        db, inst, timeframe, _ts(since), _ts(until), limit, view=view, ids=id_list
    )
    return json_response(request, payload, OBJECTS)


@router.get("/figures")
def figures(
    request: Request,
    symbol: str,
    tf: str = "4h",
    since: int | None = None,
    until: int | None = None,
    limit: int = Query(100, ge=1, le=500),
    view: View | None = Query(None, description=VIEW_DOC),
    db: Session = Depends(auth.get_db),
) -> Response:
    """Графические фигуры инструмента (план 2A.10.2, 4B.6): формируется / подтверждена /
    отменена, с линиями, целью и исторической отработкой типа. Доступно всем.

    ``view=chart`` — без ``metrics``, ``source`` и ``tf``."""
    from app.figures import chart_figures

    timeframe = _tf(tf)
    inst = _instrument(db, symbol)
    payload = chart_figures(db, inst, timeframe, _ts(since), _ts(until), limit, view=view)
    return json_response(request, payload, OBJECTS)


@router.get("/found")
def found(
    request: Request,
    symbol: str,
    tf: str = "4h",
    since: int = Query(description="unix-секунды: начало диапазона, как since у patterns"),
    until: int | None = Query(None, description="unix-секунды: конец диапазона"),
    db: Session = Depends(auth.get_db),
) -> Response:
    """Счётчики «Найдено» за диапазон до загрузки элементов: сколько паттернов (``total``) и
    время свечи значимых (``significant_t``), конец неотменённых фигур (``active_end_t``; ``null``
    на таймфреймах без фигур). Отбор тот же, что у ``/patterns`` и ``/figures``."""
    from app.figures import FIGURE_TFS, figure_active_ends
    from app.patterns import pattern_counts

    timeframe = _tf(tf)
    inst = _instrument(db, symbol)
    s, u = _ts(since), _ts(until)
    payload = {
        "symbol": inst.symbol,
        "tf": timeframe.value,
        "since": since,
        "until": until,
        "patterns": pattern_counts(db, inst, timeframe, s, u),
        "figures": figure_active_ends(db, inst, timeframe, s, u)
        if timeframe in FIGURE_TFS
        else None,
    }
    return json_response(request, payload, OBJECTS)


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
    return ask_chart(db, _redis(), user, inst, timeframe, body.question)


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
    return explain_pattern(db, _redis(), user, inst, timeframe, p)


def _parse_series(raw: str) -> list[str]:
    names = [x.strip() for x in raw.split(",") if x.strip()]
    if names == ["none"]:
        return []
    bad = [n for n in names if n not in DERIV_SERIES]
    if not names or bad:
        raise HTTPException(400, f"series: {', '.join(DERIV_SERIES)} через запятую или none")
    return names


@router.get("/derivatives")
def derivatives(
    request: Request,
    symbol: str,
    tf: str = "4h",
    before: int | None = Query(None),
    limit: int = Query(PAGE, ge=20, le=PAGE),
    series: str | None = Query(
        None,
        description="ряды через запятую: funding, oi, liquidations, ls_ratio, ls_top; "
        "none — только funding_current, next_funding_t, liquidations_note; без параметра — все",
    ),
    user: User | None = Depends(optional_user),
    db: Session = Depends(auth.get_db),
) -> Response:
    """Панели funding / OI / ликвидаций, выровненные по корзинам tf, за окно ``limit`` свечей."""
    timeframe = _tf(tf)
    wanted = _parse_series(series) if series is not None else None
    inst = _instrument(db, symbol)
    until = _ts(before)
    end = until or _now()
    since = end - timeframe.delta * limit
    payload = {
        "symbol": inst.symbol,
        "tf": timeframe.value,
        **load_derivatives(db, inst.id, timeframe, since, until, wanted),
    }
    return json_response(request, payload, DERIVATIVES)
