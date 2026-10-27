"""/v1/drawings и /v1/chart/layout — синхронизация рисунков и раскладок (план 2A.5, 2B.7)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import auth
from app.drawings_sync import resolve
from app.entitlements import entitlements_for
from app.models import ChartLayout, Drawing, Instrument, User

router = APIRouter(prefix="/v1", tags=["drawings"])
TYPES = {
    "hline", "hray", "vline", "trend", "ray", "extended", "channel", "rect", "fib",
    "position-long", "position-short", "note", "ruler",
}  # fmt: skip


class DrawingIn(BaseModel):
    client_id: str = Field(min_length=3, max_length=40, pattern="^[A-Za-z0-9_-]+$")
    symbol: str = Field(min_length=5, max_length=20)
    timeframe: str | None = Field(default=None, max_length=4)
    type: str
    points: list[dict[str, float]] = Field(max_length=5)
    style: dict[str, Any] = Field(default_factory=dict)
    text: str | None = Field(default=None, max_length=140)
    levels: list[float] | None = None
    locked: bool = False
    updated_at: int = Field(ge=0)
    deleted_at: int | None = None


def _out(d: Drawing, symbol: str) -> dict[str, Any]:
    return {
        "client_id": d.client_id,
        "symbol": symbol,
        "timeframe": d.timeframe,
        "type": d.type,
        "points": d.points,
        "style": d.style,
        "text": d.text,
        "levels": d.levels,
        "locked": d.locked,
        "updated_at": d.updated_at,
        "deleted_at": d.deleted_at,
    }


def _as_dict(d: Drawing) -> dict[str, Any]:
    return {"client_id": d.client_id, "updated_at": d.updated_at, "deleted_at": d.deleted_at}


@router.get("/drawings")
def list_drawings(
    symbol: str,
    since: int = Query(0, ge=0, description="unix-мс: отдать изменённые после"),
    user: User = Depends(auth.current_user),
    db: Session = Depends(auth.get_db),
) -> dict[str, Any]:
    inst = db.scalar(select(Instrument).where(Instrument.symbol == symbol.upper()))
    if inst is None:
        raise HTTPException(404, "инструмент не найден")
    ent = entitlements_for(db, user)
    rows = db.scalars(
        select(Drawing).where(
            Drawing.user_id == user.id,
            Drawing.instrument_id == inst.id,
            Drawing.updated_at > since,
        )
    ).all()
    return {
        "symbol": inst.symbol,
        "items": [_out(d, inst.symbol) for d in rows],
        "limit": ent.drawings_limit,
        "sync": ent.drawings_sync,
    }


@router.put("/drawings", status_code=200)
def upsert_drawings(
    body: list[DrawingIn],
    user: User = Depends(auth.current_user),
    db: Session = Depends(auth.get_db),
) -> dict[str, Any]:
    """Пакетная запись (офлайн-очередь клиента). Ответ — итоговые версии после слияния."""
    ent = entitlements_for(db, user)
    if not ent.drawings_sync:
        raise HTTPException(403, "синхронизация рисунков доступна на тарифе Pro")
    if len(body) > 200:
        raise HTTPException(400, "не больше 200 рисунков за запрос")
    out: list[dict[str, Any]] = []
    for item in body:
        if item.type not in TYPES:
            raise HTTPException(400, f"неизвестный тип рисунка: {item.type}")
        inst = db.scalar(select(Instrument).where(Instrument.symbol == item.symbol.upper()))
        if inst is None:
            raise HTTPException(404, f"инструмент не найден: {item.symbol}")
        row = db.scalar(
            select(Drawing).where(Drawing.user_id == user.id, Drawing.client_id == item.client_id)
        )
        incoming = item.model_dump()
        winner = resolve(_as_dict(row) if row else None, incoming)
        if row is None:
            if ent.drawings_limit is not None and not item.deleted_at:
                active = (
                    db.query(Drawing)
                    .filter(
                        Drawing.user_id == user.id,
                        Drawing.instrument_id == inst.id,
                        Drawing.deleted_at.is_(None),
                    )
                    .count()
                )
                if active >= ent.drawings_limit:
                    raise HTTPException(
                        403,
                        f"лимит рисунков на инструмент: {ent.drawings_limit} (тариф {ent.plan})",
                    )
            row = Drawing(user_id=user.id, client_id=item.client_id, instrument_id=inst.id)
            db.add(row)
        if winner is incoming:
            row.instrument_id = inst.id
            row.timeframe = item.timeframe
            row.type = item.type
            row.points = item.points
            row.style = item.style
            row.text = item.text
            row.levels = item.levels
            row.locked = item.locked
            row.updated_at = item.updated_at
            row.deleted_at = item.deleted_at
        db.flush()
        out.append(_out(row, inst.symbol))
    db.commit()
    return {"items": out}


class LayoutIn(BaseModel):
    name: str | None = Field(default=None, max_length=60)
    data: dict[str, Any]
    updated_at: int = Field(ge=0)


@router.get("/chart/layout")
def get_layout(
    name: str | None = None,
    user: User = Depends(auth.current_user),
    db: Session = Depends(auth.get_db),
) -> dict[str, Any]:
    row = db.scalar(
        select(ChartLayout).where(
            ChartLayout.user_id == user.id,
            ChartLayout.name.is_(None) if name is None else ChartLayout.name == name,
        )
    )
    return {
        "name": name,
        "data": row.data if row else None,
        "updated_at": row.updated_at if row else 0,
    }


@router.get("/chart/layouts")
def list_layouts(
    user: User = Depends(auth.current_user), db: Session = Depends(auth.get_db)
) -> list[dict[str, Any]]:
    rows = db.scalars(
        select(ChartLayout).where(ChartLayout.user_id == user.id, ChartLayout.name.is_not(None))
    ).all()
    return [{"name": r.name, "updated_at": r.updated_at} for r in rows]


@router.put("/chart/layout")
def put_layout(
    body: LayoutIn, user: User = Depends(auth.current_user), db: Session = Depends(auth.get_db)
) -> dict[str, Any]:
    ent = entitlements_for(db, user)
    row = db.scalar(
        select(ChartLayout).where(
            ChartLayout.user_id == user.id,
            ChartLayout.name.is_(None) if body.name is None else ChartLayout.name == body.name,
        )
    )
    if row is None:
        if body.name is not None and ent.layouts_limit is not None:
            n = (
                db.query(ChartLayout)
                .filter(ChartLayout.user_id == user.id, ChartLayout.name.is_not(None))
                .count()
            )
            if n >= ent.layouts_limit:
                raise HTTPException(403, f"лимит раскладок: {ent.layouts_limit} (тариф {ent.plan})")
        row = ChartLayout(
            user_id=user.id, name=body.name, data=body.data, updated_at=body.updated_at
        )
        db.add(row)
    elif body.updated_at >= row.updated_at:
        row.data = body.data
        row.updated_at = body.updated_at
    db.commit()
    return {"name": row.name, "data": row.data, "updated_at": row.updated_at}


@router.delete("/chart/layout", status_code=204)
def delete_layout(
    name: str, user: User = Depends(auth.current_user), db: Session = Depends(auth.get_db)
) -> None:
    row = db.scalar(
        select(ChartLayout).where(ChartLayout.user_id == user.id, ChartLayout.name == name)
    )
    if row is not None:
        db.delete(row)
        db.commit()
