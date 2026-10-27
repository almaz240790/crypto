"""/v1/admin/labels — инструмент разметки кандидатов фигур (план 2A.10.2; задача 4B.2)."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import auth
from app.labeling import LABELS, next_candidate, stats
from app.models import FigureRow, Instrument, MlLabel, User
from app.routers.admin import ADMIN
from engine.candles import Timeframe
from engine.figures import TITLES, FigureType

router = APIRouter(prefix="/v1/admin/labels", tags=["admin"])
CONTEXT_BEFORE, CONTEXT_AFTER = 25, 15


class LabelIn(BaseModel):
    figure_id: int
    label: str = Field(pattern="^(figure|not_figure|unsure)$")
    figure_type: str | None = Field(default=None, max_length=24)
    time_spent_s: int = Field(default=0, ge=0, le=3600)


def _candidate_dict(f: FigureRow, symbol: str) -> dict[str, Any]:
    """Кандидат без подсказок: тип и геометрию не показываем, только окно свечей."""
    tf = Timeframe(f.timeframe)
    return {
        "figure_id": f.id,
        "symbol": symbol,
        "tf": f.timeframe,
        "window_from": int((f.start_time - tf.delta * CONTEXT_BEFORE).timestamp()),
        "window_to": int((f.end_time + tf.delta * CONTEXT_AFTER).timestamp()),
        "span_from": int(f.start_time.timestamp()),
        "span_to": int(f.end_time.timestamp()),
        "types": [{"id": t.value, "title": TITLES[t]} for t in FigureType],
    }


@router.get("/next")
def next_label(user: User = Depends(ADMIN), db: Session = Depends(auth.get_db)) -> dict[str, Any]:
    f = next_candidate(db, user)
    if f is None:
        return {"candidate": None, "message": "очередь пуста"}
    symbol = db.scalar(select(Instrument.symbol).where(Instrument.id == f.instrument_id)) or "?"
    return {"candidate": _candidate_dict(f, symbol)}


@router.get("/{figure_id}/image.png")
def label_image(
    figure_id: int, user: User = Depends(ADMIN), db: Session = Depends(auth.get_db)
) -> Response:
    """PNG окна свечей без линий фигуры (без подсказок); участок кандидата подсвечен рамкой."""
    from decimal import Decimal

    from app.debug import load_candles, render_png
    from engine.structure import MarketStructure

    f = db.get(FigureRow, figure_id)
    if f is None:
        raise HTTPException(404, "нет кандидата")
    symbol = db.scalar(select(Instrument.symbol).where(Instrument.id == f.instrument_id)) or "?"
    tf = Timeframe(f.timeframe)
    end = f.end_time + tf.delta * (CONTEXT_AFTER + 1)
    n_before = int((f.end_time - f.start_time) / tf.delta) + CONTEXT_BEFORE + CONTEXT_AFTER + 1
    candles = load_candles(symbol, tf, end, n_before)
    if len(candles) < 10:
        raise HTTPException(404, "нет свечей")
    idx = {c.open_time: i for i, c in enumerate(candles)}
    s_i, e_i = idx.get(f.start_time, 0), idx.get(f.end_time, len(candles) - 1)
    lo = min(float(c.low) for c in candles[s_i : e_i + 1])
    hi = max(float(c.high) for c in candles[s_i : e_i + 1])
    marks = [(s_i, e_i, Decimal(str(lo)), "", None)]
    png = render_png(
        candles,
        MarketStructure(),
        [],
        len(candles),
        f"{symbol} {f.timeframe} · участок {s_i}–{e_i}",
        marks=marks,
    )
    _ = hi
    return Response(png, media_type="image/png")


@router.post("", status_code=201)
def submit_label(
    body: LabelIn, user: User = Depends(ADMIN), db: Session = Depends(auth.get_db)
) -> dict[str, Any]:
    if body.label not in LABELS:
        raise HTTPException(422, "метка: figure, not_figure или unsure")
    if body.figure_type is not None:
        try:
            FigureType(body.figure_type)
        except ValueError as e:
            raise HTTPException(422, "неизвестный тип фигуры") from e
    if db.get(FigureRow, body.figure_id) is None:
        raise HTTPException(404, "нет кандидата")
    row = MlLabel(
        candidate_figure_id=body.figure_id,
        labeler_id=user.id,
        label=body.label,
        figure_type=body.figure_type if body.label == "figure" else None,
        time_spent_s=body.time_spent_s,
        labeled_at=datetime.now(tz=UTC),
    )
    db.add(row)
    try:
        db.commit()
    except IntegrityError as e:
        db.rollback()
        raise HTTPException(409, "этот кандидат уже размечен вами") from e
    return {"id": row.id, "figure_id": body.figure_id, "label": body.label}


@router.get("/stats")
def label_stats(user: User = Depends(ADMIN), db: Session = Depends(auth.get_db)) -> dict[str, Any]:
    return stats(db)
