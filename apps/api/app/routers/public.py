"""/v1/instruments, /v1/signals, /v1/stats — публичные данные (план 3.4, 3.5, 3.10).

Видны только сигналы версий стратегии в статусе ``live``. Задержка для Free и доступ к
активным сигналам — этап 3 (тарифы); сейчас все эндпоинты без ограничений для залогиненных,
а без логина — только закрытые сигналы и агрегированная статистика.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app import auth
from app.analysis import analyze_signal
from app.models import (
    BacktestRun,
    Instrument,
    Signal,
    SignalEvent,
    SignalResult,
    Strategy,
    StrategyVersion,
    User,
)
from app.stats import filter_trades, load_trades, stats_payload, trade_rows, trades_from_run
from engine.backtest import BacktestTrade
from engine.candles import Timeframe
from engine.strategies import STRATEGIES

router = APIRouter(prefix="/v1", tags=["public"])
OPEN_STATUSES = ("pending", "active", "tp1_hit", "tp2_hit")
SPARK_LEN = 24


def _scope(scope: str, user: User | None) -> str:
    """``live`` — всем; ``forward`` — только admin/owner (план 4: Premium — этап 3)."""
    if scope == "forward" and (user is None or user.role not in ("admin", "owner")):
        raise HTTPException(403, "форвард-сигналы не публикуются")
    return scope


def _sparklines(db: Session, instrument_ids: list[int]) -> dict[int, list[str]]:
    """Последние 24 закрытия H4 по инструменту — для мини-графика в ленте (план 3.4)."""
    if not instrument_ids:
        return {}
    rows = db.execute(
        text(
            "select instrument_id, close from ("
            "  select instrument_id, close, open_time,"
            "         row_number() over (partition by instrument_id order by open_time desc) rn"
            "  from candles where timeframe='4h' and instrument_id = any(:ids)"
            ") t where rn <= :n order by instrument_id, open_time"
        ),
        {"ids": instrument_ids, "n": SPARK_LEN},
    ).all()
    out: dict[int, list[str]] = {}
    for iid, close in rows:
        out.setdefault(int(iid), []).append(_dec(close) or "0")
    return out


def _last_prices(db: Session, instrument_ids: list[int]) -> dict[int, tuple[str, datetime]]:
    if not instrument_ids:
        return {}
    rows = db.execute(
        text(
            "select distinct on (instrument_id) instrument_id, close, open_time from candles "
            "where timeframe='1m' and instrument_id = any(:ids) "
            "order by instrument_id, open_time desc"
        ),
        {"ids": instrument_ids},
    ).all()
    return {int(r[0]): (_dec(r[1]) or "0", r[2]) for r in rows}


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
    s: Signal,
    symbol: str,
    version: str,
    result: SignalResult | None,
    last_event_at: datetime | None = None,
) -> dict[str, Any]:
    return {
        "id": s.public_id,
        "symbol": symbol,
        "instrument_id": s.instrument_id,
        "strategy_version": version,
        "last_event_at": last_event_at.isoformat() if last_event_at else None,
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


SORT_COLUMNS = {
    "time": Signal.candle_close_time,
    "symbol": Instrument.symbol,
    "grade": Signal.score,
    "score": Signal.score,
    "rr": Signal.rr_tp2,
    "status": Signal.status,
}


@router.get("/signals")
def signals(
    status: str | None = Query(None, description="open | closed | all"),
    symbol: str | None = None,
    grade: str | None = None,
    direction: str | None = None,
    scope: str = Query("live", pattern="^(live|forward)$"),
    days: int | None = Query(None, ge=1, le=3650),
    sort: str = Query("time", pattern="^(time|symbol|grade|score|rr|status)$"),
    order: str = Query("desc", pattern="^(asc|desc)$"),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    user: User | None = Depends(optional_user),
    db: Session = Depends(auth.get_db),
) -> dict[str, Any]:
    scope = _scope(scope, user)
    q = (
        select(Signal, Instrument.symbol, StrategyVersion.version)
        .join(Instrument, Instrument.id == Signal.instrument_id)
        .join(StrategyVersion, StrategyVersion.id == Signal.strategy_version_id)
        .where(StrategyVersion.status == scope)
    )
    if user is None:
        q = q.where(Signal.status.not_in(OPEN_STATUSES))  # без логина — только закрытые
    elif status == "open":
        q = q.where(Signal.status.in_(OPEN_STATUSES))
    elif status == "closed":
        q = q.where(Signal.status.not_in(OPEN_STATUSES))
    if symbol:
        q = q.where(Instrument.symbol.in_([s.strip().upper() for s in symbol.split(",")]))
    if grade:
        q = q.where(Signal.grade.in_([g.strip().upper() for g in grade.split(",")]))
    if direction:
        q = q.where(Signal.direction == direction)
    if days:
        q = q.where(Signal.candle_close_time >= datetime.now(tz=UTC) - timedelta(days=days))
    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    col = SORT_COLUMNS[sort]
    primary = col.asc() if order == "asc" else col.desc()
    rows = db.execute(
        q.order_by(primary, Signal.candle_close_time.desc()).limit(limit).offset(offset)
    ).all()
    ids = [r[0].id for r in rows]
    results = (
        {
            r.signal_id: r
            for r in db.scalars(select(SignalResult).where(SignalResult.signal_id.in_(ids))).all()
        }
        if ids
        else {}
    )
    last_events = (
        dict(
            db.execute(
                select(SignalEvent.signal_id, func.max(SignalEvent.occurred_at))
                .where(SignalEvent.signal_id.in_(ids))
                .group_by(SignalEvent.signal_id)
            ).all()
        )
        if ids
        else {}
    )
    inst_ids = sorted({r[0].instrument_id for r in rows})
    sparks = _sparklines(db, inst_ids)
    prices = _last_prices(db, inst_ids)
    return {
        "items": [
            _signal_dict(s, sym, ver, results.get(s.id), last_events.get(s.id))
            for s, sym, ver in rows
        ],
        "sparklines": {str(i): sparks.get(i, []) for i in inst_ids},
        "prices": {str(i): {"p": p, "at": at.isoformat()} for i, (p, at) in prices.items()},
        "total": int(total),
        "scope": scope,
        "limit": limit,
        "offset": offset,
    }


@router.get("/signals/summary")
def signals_summary(
    scope: str = Query("live", pattern="^(live|forward)$"),
    user: User | None = Depends(optional_user),
    db: Session = Depends(auth.get_db),
) -> dict[str, Any]:
    """Счётчики для шапки ленты: активных, новых сегодня, следующее закрытие H4 (план 3.4)."""
    scope = _scope(scope, user)
    now = datetime.now(tz=UTC)
    base = (
        select(func.count())
        .select_from(Signal)
        .join(StrategyVersion, StrategyVersion.id == Signal.strategy_version_id)
        .where(StrategyVersion.status == scope)
    )
    active = db.scalar(base.where(Signal.status.in_(OPEN_STATUSES))) or 0
    today = (
        db.scalar(
            base.where(
                Signal.candle_close_time >= now.replace(hour=0, minute=0, second=0, microsecond=0)
            )
        )
        or 0
    )
    floored = now.replace(minute=0, second=0, microsecond=0)
    next_close = floored - timedelta(hours=floored.hour % 4) + timedelta(hours=4)
    return {
        "active": int(active),
        "today_new": int(today),
        "next_h4_close": next_close.isoformat(),
        "now": now.isoformat(),
        "scope": scope,
    }


@router.get("/prices")
def prices(
    symbols: str = Query(..., description="через запятую"),
    db: Session = Depends(auth.get_db),
) -> dict[str, Any]:
    """Последняя цена (закрытие последней 1m-свечи) по инструментам."""
    syms = [s.strip().upper() for s in symbols.split(",") if s.strip()][:200]
    rows = db.execute(
        select(Instrument.id, Instrument.symbol).where(Instrument.symbol.in_(syms))
    ).all()
    by_id = {int(i): s for i, s in rows}
    last = _last_prices(db, list(by_id))
    return {by_id[i]: {"p": p, "at": at.isoformat()} for i, (p, at) in last.items()}


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
    if row is None or row[3] not in ("live", "forward"):
        raise HTTPException(404)
    if row[3] == "forward" and (user is None or user.role not in ("admin", "owner")):
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


@router.get("/signals/{public_id}/analysis")
def signal_analysis(
    public_id: str,
    user: User | None = Depends(optional_user),
    db: Session = Depends(auth.get_db),
) -> dict[str, Any]:
    """Структура, зоны и уровни на момент сигнала — для отрисовки на графике карточки."""
    row = db.execute(
        select(Signal, Instrument, StrategyVersion.status)
        .join(Instrument, Instrument.id == Signal.instrument_id)
        .join(StrategyVersion, StrategyVersion.id == Signal.strategy_version_id)
        .where(Signal.public_id == public_id)
    ).first()
    if row is None or row[2] not in ("live", "forward"):
        raise HTTPException(404)
    if row[2] == "forward" and (user is None or user.role not in ("admin", "owner")):
        raise HTTPException(404)
    s, inst, _ = row
    if user is None and s.status in OPEN_STATUSES:
        raise HTTPException(403)
    return analyze_signal(db, s, inst)


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


def _since_until(
    days: int | None, since: str | None, until: str | None
) -> tuple[datetime | None, datetime | None]:
    s = datetime.fromisoformat(since).astimezone(UTC) if since else None
    u = datetime.fromisoformat(until).astimezone(UTC) if until else None
    if days and not s:
        s = datetime.now(tz=UTC) - timedelta(days=days)
    return s, u


def _latest_run(db: Session, run_id: int | None, version: str | None) -> BacktestRun | None:
    """Прогон по id или версии; без них — последний прогон версии, которая сейчас live
    (или forward), чтобы бэктест по умолчанию соответствовал работающей стратегии."""
    q = select(BacktestRun).order_by(BacktestRun.id.desc())
    if run_id is not None:
        return db.scalars(q.where(BacktestRun.id == run_id)).first()
    if version:
        return db.scalars(q.where(BacktestRun.strategy_version == version)).first()
    for status in ("live", "forward"):
        versions = db.scalars(
            select(StrategyVersion.version).where(StrategyVersion.status == status)
        ).all()
        keys = [k for k in STRATEGIES if any(k.endswith("@" + v) for v in versions)]
        if keys:
            run = db.scalars(q.where(BacktestRun.strategy_version.in_(keys))).first()
            if run is not None:
                return run
    return db.scalars(q).first()


def _collect_trades(
    db: Session,
    scope: str,
    strategy_version_id: int | None,
    run_id: int | None,
    version: str | None,
    symbol: str | None,
    grade: str | None,
    entry_type: str | None,
    since: datetime | None,
    until: datetime | None,
) -> tuple[list[BacktestTrade], dict[str, Any]]:
    """Сделки по области: live/forward — из БД, backtest — из сохранённого прогона."""
    if scope == "backtest":
        run = _latest_run(db, run_id, version)
        if run is None:
            return [], {"run": None}
        trades = filter_trades(
            trades_from_run(run.trades, str((run.execution or {}).get("entry_type", "market"))),
            symbol,
            grade,
            since,
            until,
        )
        if entry_type and str((run.execution or {}).get("entry_type", "market")) != entry_type:
            trades = []
        meta = {
            "run": {
                "id": run.id,
                "strategy_version": run.strategy_version,
                "period": [run.period_start.date().isoformat(), run.period_end.date().isoformat()],
                "instruments": len(run.instruments or []),
                "entry_type": (run.execution or {}).get("entry_type", "market"),
                "fee_rate": (run.execution or {}).get("fee_rate"),
                "slippage": (run.execution or {}).get("slippage"),
                "note": run.note,
                "created_at": run.created_at.isoformat() if run.created_at else None,
            }
        }
        return trades, meta
    return load_trades(db, scope, strategy_version_id, symbol, since, until, grade, entry_type), {}


@router.get("/stats")
def stats(
    scope: str = Query("live", pattern="^(live|forward|backtest)$"),
    strategy_version_id: int | None = None,
    version: str | None = Query(None, max_length=32),
    run_id: int | None = None,
    symbol: str | None = None,
    grade: str | None = Query(None, pattern="^[ABCabc]$"),
    entry_type: str | None = Query(None, pattern="^(market|limit)$"),
    days: int | None = Query(None, ge=1, le=3650),
    since: str | None = None,
    until: str | None = None,
    db: Session = Depends(auth.get_db),
) -> dict[str, Any]:
    """Публичная статистика (план 2.11, 3.10). Три области помечены явно и не смешиваются:
    ``live`` — опубликованные сигналы, ``forward`` — форвард-тест на живых данных,
    ``backtest`` — сохранённый прогон бэктеста. Ручного ввода нет."""
    s, u = _since_until(days, since, until)
    if strategy_version_id is None and version and scope != "backtest":
        strategy_version_id = db.scalar(
            select(StrategyVersion.id).where(StrategyVersion.version == version)
        )
    trades, meta = _collect_trades(
        db, scope, strategy_version_id, run_id, version, symbol, grade, entry_type, s, u
    )
    payload = stats_payload(trades)
    payload.update(meta)
    payload["scope"] = scope
    payload["generated_at"] = datetime.now(tz=UTC).isoformat()
    return payload


@router.get("/stats/trades")
def stats_trades(
    scope: str = Query("live", pattern="^(live|forward|backtest)$"),
    strategy_version_id: int | None = None,
    version: str | None = Query(None, max_length=32),
    run_id: int | None = None,
    symbol: str | None = None,
    grade: str | None = Query(None, pattern="^[ABCabc]$"),
    entry_type: str | None = Query(None, pattern="^(market|limit)$"),
    days: int | None = Query(None, ge=1, le=3650),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    user: User | None = Depends(optional_user),
    db: Session = Depends(auth.get_db),
) -> dict[str, Any]:
    """Полная таблица сделок с пагинацией, новые сверху. Форвард построчно — admin/owner."""
    if scope == "forward" and (user is None or user.role not in ("admin", "owner")):
        raise HTTPException(403, "построчная история форварда не публикуется")
    s, u = _since_until(days, None, None)
    trades, meta = _collect_trades(
        db, scope, strategy_version_id, run_id, version, symbol, grade, entry_type, s, u
    )
    rows = trade_rows(sorted(trades, key=lambda t: t.signal_time, reverse=True))
    return {
        "items": rows[offset : offset + limit],
        "total": len(rows),
        "limit": limit,
        "offset": offset,
        "scope": scope,
        **meta,
    }


@router.get("/stats/export.csv")
def stats_export(
    scope: str = Query("live", pattern="^(live|forward|backtest)$"),
    version: str | None = Query(None, max_length=32),
    run_id: int | None = None,
    symbol: str | None = None,
    user: User = Depends(auth.current_user),
    db: Session = Depends(auth.get_db),
) -> StreamingResponse:
    """Экспорт полной истории в CSV — для зарегистрированных (правило честности 4)."""
    if scope == "forward" and user.role not in ("admin", "owner"):
        raise HTTPException(403, "форвард в CSV не публикуется")
    trades, _ = _collect_trades(db, scope, None, run_id, version, symbol, None, None, None, None)
    rows = trade_rows(sorted(trades, key=lambda t: t.signal_time))
    cols = [
        "id",
        "symbol",
        "direction",
        "signal_time",
        "grade",
        "score",
        "entry",
        "stop",
        "rr_tp2",
        "entry_type",
        "status",
        "tp_hits",
        "realized_r",
        "mfe_r",
        "mae_r",
        "exit_time",
    ]

    def gen() -> Iterator[str]:
        yield ",".join(cols) + "\n"
        for r in rows:
            yield ",".join("" if r[c] is None else str(r[c]) for c in cols) + "\n"

    name = f"platform-{scope}-signals.csv"
    return StreamingResponse(
        gen(),
        media_type="text/csv",
        headers={"content-disposition": f"attachment; filename={name}"},
    )


@router.get("/stats/runs")
def stats_runs(
    limit: int = Query(20, ge=1, le=100), db: Session = Depends(auth.get_db)
) -> list[dict[str, Any]]:
    """Сохранённые прогоны бэктеста — для переключателя на /stats."""
    runs = db.scalars(select(BacktestRun).order_by(BacktestRun.id.desc()).limit(limit)).all()
    return [
        {
            "id": r.id,
            "strategy_version": r.strategy_version,
            "period": [r.period_start.date().isoformat(), r.period_end.date().isoformat()],
            "instruments": len(r.instruments or []),
            "entry_type": (r.execution or {}).get("entry_type", "market"),
            "closed": ((r.result_summary or {}).get("metrics") or {}).get("closed"),
            "note": r.note,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in runs
    ]


@router.get("/strategies")
def strategies(db: Session = Depends(auth.get_db)) -> list[dict[str, Any]]:
    """Версии стратегии и их статус (backtest / forward / live / retired)."""
    rows = db.execute(
        select(StrategyVersion, Strategy.name, Strategy.slug)
        .join(Strategy, Strategy.id == StrategyVersion.strategy_id)
        .order_by(StrategyVersion.id)
    ).all()
    return [
        {
            "id": v.id,
            "strategy": slug,
            "name": name,
            "version": v.version,
            "status": v.status,
            "activated_at": v.activated_at.isoformat() if v.activated_at else None,
        }
        for v, name, slug in rows
    ]
