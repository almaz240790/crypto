"""Сервис графических фигур (план 2A.10.2, 2A.10.4; задача 4B.6): синхронизация отметок,
бэкфилл, отработка, агрегаты. Фигуры не являются сигналами (2A.10.5)."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import delete, insert, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.chart_data import PAGE, STORED, load_candles
from app.models import FigureEvent, FigureOutcomeRow, FigureRow, FigureStatsSnapshot, Instrument
from app.patterns import LOW_N, wilson
from engine.candles import Candle, Timeframe, closed_only
from engine.figures import (
    DEFAULT_FIGURE_PARAMS,
    TITLES,
    Figure,
    FigureParams,
    FigureStatus,
    FigureType,
    detect_figures,
    figure_outcome,
)
from engine.indicators import atr

log = logging.getLogger("figures")

FIGURE_TFS = (Timeframe.H4, Timeframe.D1, Timeframe.W1)
"""Фигуры считаются на старших таймфреймах: поиск дорогой, а фигуры живут долго."""
WINDOW = 1500
"""Свечей для live-поиска (самая длинная фигура ≤ 200 свечей плюс история для swing-ов)."""


def _dec(x: Decimal | None) -> str | None:
    return None if x is None else format(x.normalize(), "f")


def _ts(c: Candle) -> int:
    return int(c.open_time.timestamp())


def geometry_json(f: Figure, candles: list[Candle]) -> dict[str, Any]:
    return {
        "points": [[_ts(candles[p.index]), _dec(p.price)] for p in f.points],
        "lines": [
            {
                "name": ln.name,
                "a": [_ts(candles[min(ln.a.index, len(candles) - 1)]), _dec(ln.a.price)],
                "b": [
                    _ts(candles[ln.b.index])
                    if ln.b.index < len(candles)
                    else _ts(candles[-1])
                    + (ln.b.index - len(candles) + 1)
                    * int((candles[-1].open_time - candles[-2].open_time).total_seconds()),
                    _dec(ln.b.price),
                ],
            }
            for ln in f.lines
        ],
        "known_t": _ts(candles[f.known_index]),
        "confirm_t": _ts(candles[f.confirm_index]) if f.confirm_index is not None else None,
        "atr": _dec(
            atr(candles, DEFAULT_FIGURE_PARAMS.atr_period)[f.confirm_index or f.known_index]
        ),
    }


def _row_values(f: Figure, candles: list[Candle], tf: Timeframe) -> dict[str, Any]:
    conf = candles[f.confirm_index].close_time(tf) if f.confirm_index is not None else None
    inv = candles[f.invalidated_index].close_time(tf) if f.invalidated_index is not None else None
    return {
        "type": f.type.value,
        "direction": f.direction.value if f.direction else None,
        "status": f.status.value,
        "scale": f.scale,
        "start_time": candles[f.start_index].open_time,
        "end_time": candles[f.end_index].open_time,
        "known_time": candles[f.known_index].close_time(tf),
        "confirm_time": conf,
        "invalidated_time": inv,
        "geometry": geometry_json(f, candles),
        "breakout_level": f.breakout_level,
        "target": f.target,
        "invalidation": f.invalidation,
        "quality": Decimal(str(f.quality)),
        "metrics": f.metrics,
        "rules_version": f.rules_version,
    }


def _insert_or_existing(
    db: Session, inst: Instrument, tf: Timeframe, vals: dict[str, Any], source: str
) -> tuple[FigureRow, bool]:
    """Вставка фигуры; если такую же (uq_figures_geometry) параллельно записал live-воркер —
    берём его строку (гонка бэкфилла и детектора на закрытии свечи)."""
    row = FigureRow(instrument_id=inst.id, timeframe=tf.value, source=source, **vals)
    try:
        with db.begin_nested():
            db.add(row)
            db.flush()
        return row, True
    except IntegrityError:
        db.expunge(row)
        found = db.scalars(
            select(FigureRow).where(
                FigureRow.instrument_id == inst.id,
                FigureRow.timeframe == tf.value,
                FigureRow.type == vals["type"],
                FigureRow.start_time == vals["start_time"],
                FigureRow.end_time == vals["end_time"],
                FigureRow.rules_version == vals["rules_version"],
            )
        ).one()
        return found, False


def sync_figures(
    db: Session,
    inst: Instrument,
    tf: Timeframe,
    candles: list[Candle],
    params: FigureParams = DEFAULT_FIGURE_PARAMS,
    source: str = "live",
) -> dict[str, int]:
    """Сверяет найденные фигуры с таблицей: forming обновляется, статусы фиксируются событиями."""
    figs = detect_figures(candles, params)
    if not figs:
        return {"new": 0, "updated": 0, "confirmed": 0, "invalidated": 0}
    existing = {
        (r.type, r.start_time, r.end_time): r
        for r in db.scalars(
            select(FigureRow).where(
                FigureRow.instrument_id == inst.id,
                FigureRow.timeframe == tf.value,
                FigureRow.rules_version == params.rules_version,
                FigureRow.end_time >= candles[0].open_time,
            )
        ).all()
    }
    stats = {"new": 0, "updated": 0, "confirmed": 0, "invalidated": 0}
    seen: set[tuple[str, datetime, datetime]] = set()
    for f in figs:
        vals = _row_values(f, candles, tf)
        key = (vals["type"], vals["start_time"], vals["end_time"])
        seen.add(key)
        row = existing.get(key)
        inserted = False
        if row is None:
            row, inserted = _insert_or_existing(db, inst, tf, vals, source)
            existing[key] = row
        if inserted:
            db.add(
                FigureEvent(
                    figure_id=row.id,
                    type="detected_forming" if f.status is FigureStatus.FORMING else f.status.value,
                    occurred_at=vals["known_time"]
                    if f.status is FigureStatus.FORMING
                    else (vals["confirm_time"] or vals["invalidated_time"] or vals["known_time"]),
                    details={"quality": f.quality, "source": source},
                )
            )
            stats["new"] += 1
            if f.status is FigureStatus.CONFIRMED:
                stats["confirmed"] += 1
            elif f.status is FigureStatus.INVALIDATED:
                stats["invalidated"] += 1
            continue
        if row.status != "forming":
            continue
        changed = row.status != vals["status"]
        for k, v in vals.items():
            setattr(row, k, v)
        if changed:
            db.add(
                FigureEvent(
                    figure_id=row.id,
                    type=vals["status"],
                    occurred_at=vals["confirm_time"]
                    or vals["invalidated_time"]
                    or vals["known_time"],
                    details={"quality": f.quality},
                )
            )
            stats["confirmed" if vals["status"] == "confirmed" else "invalidated"] += 1
        else:
            stats["updated"] += 1
    # формирующиеся, которых больше нет среди кандидатов (геометрия распалась) — отменяем
    for key, row in existing.items():
        if row.status == "forming" and key not in seen:
            row.status = "invalidated"
            row.invalidated_time = candles[-1].close_time(tf)
            db.add(
                FigureEvent(
                    figure_id=row.id,
                    type="invalidated",
                    occurred_at=row.invalidated_time,
                    details={"reason": "candidate_gone"},
                )
            )
            stats["invalidated"] += 1
    return stats


def sync_live(db: Session, inst: Instrument, tf: Timeframe, now: datetime) -> dict[str, int]:
    candles, _ = load_candles(db, inst.id, tf, None, PAGE)
    candles = closed_only(candles, tf, now)
    if len(candles) <= DEFAULT_FIGURE_PARAMS.warmup:
        return {"new": 0, "updated": 0, "confirmed": 0, "invalidated": 0}
    return sync_figures(db, inst, tf, candles)


def _load_all(
    db: Session, instrument_id: int, tf: Timeframe, since: datetime | None
) -> list[Candle]:
    if tf not in STORED:
        raise ValueError(f"бэкфилл только по хранимым таймфреймам: {tf.value}")
    rows = db.execute(
        text(
            "select open_time, open, high, low, close, volume, quote_volume, trades from candles "
            "where instrument_id=:i and timeframe=:tf "
            "and (CAST(:s AS timestamptz) is null or open_time >= CAST(:s AS timestamptz)) "
            "order by open_time"
        ),
        {"i": instrument_id, "tf": tf.value, "s": since},
    ).all()
    return [
        Candle(r[0].astimezone(UTC), r[1], r[2], r[3], r[4], r[5], r[6] or Decimal(0), r[7] or 0)
        for r in rows
    ]


def backfill(
    db: Session,
    inst: Instrument,
    tf: Timeframe,
    since: datetime | None = None,
    now: datetime | None = None,
    params: FigureParams = DEFAULT_FIGURE_PARAMS,
) -> dict[str, int]:
    """Прогон по всей истории: статусы по закрытиям, отработка для подтверждённых."""
    now = now or datetime.now(tz=UTC)
    candles = closed_only(_load_all(db, inst.id, tf, since), tf, now)
    if len(candles) <= params.warmup:
        return {"candles": len(candles), "new": 0, "outcomes": 0}
    st = sync_figures(db, inst, tf, candles, params, source="backfill")
    n_out = evaluate_outcomes(db, inst.id, tf, candles, params)
    return {"candles": len(candles), **st, "outcomes": n_out}


def evaluate_outcomes(
    db: Session,
    instrument_id: int,
    tf: Timeframe,
    candles: list[Candle],
    params: FigureParams = DEFAULT_FIGURE_PARAMS,
) -> int:
    """Дописывает отработку подтверждённым фигурам, у которых уже есть N свечей после пробоя."""
    rows = (
        db.execute(
            select(FigureRow)
            .outerjoin(FigureOutcomeRow, FigureOutcomeRow.figure_id == FigureRow.id)
            .where(
                FigureRow.instrument_id == instrument_id,
                FigureRow.timeframe == tf.value,
                FigureRow.status == "confirmed",
                FigureOutcomeRow.figure_id.is_(None),
            )
        )
        .scalars()
        .all()
    )
    if not rows:
        return 0
    idx = {c.open_time: i for i, c in enumerate(candles)}
    atr_values = atr(candles, params.atr_period)
    written = 0
    for r in rows:
        ci = idx.get(r.confirm_time - tf.delta) if r.confirm_time else None
        if ci is None or ci + params.outcome_horizon >= len(candles):
            continue
        a = atr_values[ci]
        if a is None:
            continue
        f = _figure_from_row(r, idx)
        if f is None:
            continue
        o = figure_outcome(candles, f, a, params.outcome_horizon)
        if o.target_hit is None:
            continue
        db.add(
            FigureOutcomeRow(
                figure_id=r.id,
                horizon_bars=o.horizon,
                target_hit=o.target_hit,
                invalidation_hit=o.invalidation_hit,
                move_atr_favorable=o.max_favorable_atr,
                move_atr_adverse=o.max_adverse_atr,
                bars_to_target=o.bars_to_target,
            )
        )
        db.add(
            FigureEvent(
                figure_id=r.id,
                type="outcome_recorded",
                occurred_at=candles[min(ci + params.outcome_horizon, len(candles) - 1)].close_time(
                    tf
                ),
                details={"target_hit": o.target_hit},
            )
        )
        written += 1
    return written


def _figure_from_row(r: FigureRow, idx: dict[datetime, int]) -> Figure | None:
    """Минимальная фигура для расчёта отработки: направление, индекс пробоя, цель, инвалидация."""
    from engine.figures import Line, Point
    from engine.structure import Direction

    if r.confirm_time is None:
        return None
    ci = idx.get(r.confirm_time - _tf_delta(r.timeframe))
    if ci is None:
        return None
    return Figure(
        type=FigureType(r.type),
        direction=Direction(r.direction) if r.direction else None,
        scale=r.scale,
        points=(Point(ci, r.breakout_level or Decimal(0)),),
        lines=(Line("x", Point(ci, Decimal(0)), Point(ci + 1, Decimal(0))),),
        start_index=ci,
        end_index=ci,
        known_index=ci,
        status=FigureStatus.CONFIRMED,
        confirm_index=ci,
        invalidated_index=None,
        breakout_level=r.breakout_level,
        target=r.target,
        invalidation=r.invalidation,
        quality=float(r.quality),
        rules_version=r.rules_version,
    )


def _tf_delta(tf: str) -> Any:
    return Timeframe(tf).delta


def evaluate_pending(db: Session, now: datetime | None = None, limit: int = 200) -> int:
    """Live: отработка подтверждённых фигур по мере закрытия свечей."""
    now = now or datetime.now(tz=UTC)
    pending = db.execute(
        select(FigureRow.instrument_id, FigureRow.timeframe)
        .outerjoin(FigureOutcomeRow, FigureOutcomeRow.figure_id == FigureRow.id)
        .where(FigureRow.status == "confirmed", FigureOutcomeRow.figure_id.is_(None))
        .distinct()
        .limit(limit)
    ).all()
    written = 0
    for instrument_id, tf_value in pending:
        tf = Timeframe(tf_value)
        candles, _ = load_candles(db, instrument_id, tf, None, PAGE)
        candles = closed_only(candles, tf, now)
        if candles:
            written += evaluate_outcomes(db, instrument_id, tf, candles)
    return written


STATS_SQL = text(
    """
    select f.type, f.timeframe, f.source, extract(year from f.confirm_time)::int as year,
           count(*) as n, count(*) filter (where o.target_hit) as k,
           avg(o.move_atr_favorable) as fav, avg(o.move_atr_adverse) as adv,
           avg(o.bars_to_target) filter (where o.target_hit) as bars
    from figure_outcomes o join figures f on f.id = o.figure_id
    where o.target_hit is not null
    group by grouping sets (
      (f.type, f.timeframe, f.source),
      (f.type, f.timeframe, f.source, extract(year from f.confirm_time)::int)
    )
    """
)


def recompute_stats(db: Session, now: datetime | None = None) -> int:
    now = now or datetime.now(tz=UTC)
    rows = []
    for r in db.execute(STATS_SQL).all():
        n, k = int(r.n), int(r.k)
        low, high = wilson(k, n)
        rows.append(
            {
                "type": r.type,
                "timeframe": r.timeframe,
                "scope": r.source,
                "year": r.year,
                "n": n,
                "success_rate": Decimal(f"{k / n:.4f}"),
                "ci_low": low,
                "ci_high": high,
                "avg_move_atr": None if r.fav is None else Decimal(str(r.fav)),
                "avg_adverse_atr": None if r.adv is None else Decimal(str(r.adv)),
                "avg_bars_to_target": None
                if r.bars is None
                else Decimal(str(round(float(r.bars), 2))),
                "computed_at": now,
            }
        )
    db.execute(delete(FigureStatsSnapshot))
    if rows:
        db.execute(insert(FigureStatsSnapshot), rows)
    return len(rows)


def snapshot_dict(s: FigureStatsSnapshot | None, type_: str) -> dict[str, Any]:
    base: dict[str, Any] = {
        "type": type_,
        "title": TITLES[FigureType(type_)],
        "n": 0 if s is None else s.n,
        "low_n": s is None or s.n < LOW_N,
        "success_rate": None,
        "ci_low": None,
        "ci_high": None,
        "avg_move_atr": None,
        "avg_adverse_atr": None,
        "avg_bars_to_target": None,
    }
    if s is not None and s.n >= LOW_N:
        base.update(
            success_rate=_dec(s.success_rate),
            ci_low=_dec(s.ci_low),
            ci_high=_dec(s.ci_high),
            avg_move_atr=_dec(s.avg_move_atr),
            avg_adverse_atr=_dec(s.avg_adverse_atr),
            avg_bars_to_target=_dec(s.avg_bars_to_target),
        )
    return base


def stats_payload(db: Session, tf: str, scope: str, type_: str | None) -> dict[str, Any]:
    rows = {
        s.type: s
        for s in db.scalars(
            select(FigureStatsSnapshot).where(
                FigureStatsSnapshot.timeframe == tf,
                FigureStatsSnapshot.scope == scope,
                FigureStatsSnapshot.year.is_(None),
            )
        ).all()
    }
    types = [type_] if type_ else [t.value for t in FigureType]
    payload: dict[str, Any] = {
        "scope": scope,
        "tf": tf,
        "horizon": DEFAULT_FIGURE_PARAMS.outcome_horizon,
        "items": [snapshot_dict(rows.get(t), t) for t in types],
        "note": (
            "Историческая отработка фигур: доля подтверждённых фигур, где цена дошла до цели "
            f"цели раньше инвалидации за {DEFAULT_FIGURE_PARAMS.outcome_horizon} свечей. "
            f"При n < {LOW_N} процент не показывается. Фигуры не являются сигналами."
        ),
        "computed_at": max((s.computed_at for s in rows.values()), default=None),
    }
    if type_:
        by_year = db.scalars(
            select(FigureStatsSnapshot)
            .where(
                FigureStatsSnapshot.timeframe == tf,
                FigureStatsSnapshot.scope == scope,
                FigureStatsSnapshot.type == type_,
                FigureStatsSnapshot.year.is_not(None),
            )
            .order_by(FigureStatsSnapshot.year)
        ).all()
        payload["by_year"] = [{"year": s.year, **snapshot_dict(s, type_)} for s in by_year]
    if payload["computed_at"] is not None:
        payload["computed_at"] = payload["computed_at"].isoformat()
    return payload


def figure_dict(r: FigureRow) -> dict[str, Any]:
    return {
        "id": r.id,
        "type": r.type,
        "title": TITLES[FigureType(r.type)],
        "direction": r.direction,
        "status": r.status,
        "scale": r.scale,
        "start_t": int(r.start_time.timestamp()),
        "end_t": int(r.end_time.timestamp()),
        "known_t": int(r.known_time.timestamp()),
        "confirm_t": int(r.confirm_time.timestamp()) if r.confirm_time else None,
        "invalidated_t": int(r.invalidated_time.timestamp()) if r.invalidated_time else None,
        "points": r.geometry.get("points", []),
        "lines": r.geometry.get("lines", []),
        "breakout_level": _dec(r.breakout_level),
        "target": _dec(r.target),
        "invalidation": _dec(r.invalidation),
        "quality": float(r.quality),
        "metrics": r.metrics,
        "source": r.source,
        "tf": r.timeframe,
    }


def chart_figures(
    db: Session,
    inst: Instrument,
    tf: Timeframe,
    since: datetime | None,
    until: datetime | None,
    limit: int = 100,
) -> dict[str, Any]:
    q = select(FigureRow).where(FigureRow.instrument_id == inst.id, FigureRow.timeframe == tf.value)
    if since is not None:
        q = q.where(FigureRow.end_time >= since)
    if until is not None:
        q = q.where(FigureRow.start_time <= until)
    rows = db.scalars(q.order_by(FigureRow.end_time.desc()).limit(limit)).all()
    types = sorted({r.type for r in rows})
    snaps = {
        s.type: s
        for s in db.scalars(
            select(FigureStatsSnapshot).where(
                FigureStatsSnapshot.timeframe == tf.value,
                FigureStatsSnapshot.scope == "backfill",
                FigureStatsSnapshot.year.is_(None),
                FigureStatsSnapshot.type.in_(types),
            )
        ).all()
    }
    return {
        "symbol": inst.symbol,
        "tf": tf.value,
        "items": [figure_dict(r) for r in reversed(rows)],
        "stats": {t: snapshot_dict(snaps.get(t), t) for t in types},
        "note": (
            "Фигуры считаются по закрытым свечам; «формируется» — геометрия без подтверждения. "
            "Не являются сигналами."
        ),
    }
