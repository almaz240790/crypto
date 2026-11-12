"""/v1/drawings и /v1/chart/layout — синхронизация рисунков и раскладок (план 2A.5, 2B.7)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import auth
from app.drawings_sync import fib_levels, resolve
from app.entitlements import entitlements_for
from app.models import ChartLayout, Drawing, Instrument, User

router = APIRouter(prefix="/v1", tags=["drawings"])
TYPES = {
    "hline", "hray", "vline", "trend", "ray", "extended", "channel", "rect", "fib",
    "position-long", "position-short", "note", "ruler",
}  # fmt: skip
# Курсор чтения (GET ``cursor``) — время записи на сервере минус перекрытие: запись, начатая до
# чтения и закоммиченная после него, получает synced_at раньше момента чтения; перекрытие больше
# любой транзакции записи, повторно присланные рисунки клиент сливает без последствий.
CURSOR_OVERLAP_MS = 5 * 60 * 1000


class DrawingIn(BaseModel):
    client_id: str = Field(min_length=3, max_length=40, pattern="^[A-Za-z0-9_-]+$")
    symbol: str = Field(min_length=5, max_length=20)
    timeframe: str | None = Field(default=None, max_length=4)
    type: str
    points: list[dict[str, float]] = Field(max_length=5)
    style: dict[str, Any] = Field(default_factory=dict)
    text: str | None = Field(default=None, max_length=140)
    # уровни Фибоначчи: число значений, диапазон и приведение — fib_levels, в обработчике (ответ 422
    # с текстом: стандартный ответ 422 повторяет входные данные, а NaN в JSON не сериализуется)
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


def _ms(t: datetime) -> int:
    return int(t.timestamp() * 1000)


def _rejected(raw: dict[str, Any], status: int, code: str, detail: str) -> dict[str, Any]:
    """Отказ одному рисунку пакета: статус как у HTTP, код для клиента, текст без входных данных."""
    cid, symbol = raw.get("client_id"), raw.get("symbol")
    return {
        "client_id": cid if isinstance(cid, str) else None,
        "symbol": symbol.upper() if isinstance(symbol, str) else None,
        "status": status,
        "code": code,
        "detail": f"{cid}: {detail}",
    }


@router.get("/drawings")
def list_drawings(
    symbol: str,
    since: int = Query(0, ge=0, description="прежние клиенты: unix-мс updated_at, отдать новее"),
    cursor: int | None = Query(
        None, ge=0, description="курсор из прошлого ответа: отдать записанные на сервер после"
    ),
    user: User = Depends(auth.current_user),
    db: Session = Depends(auth.get_db),
) -> dict[str, Any]:
    """Рисунки инструмента. ``cursor`` — время записи на сервере (synced_at), а не updated_at
    клиента: рисунок, нарисованный офлайн раньше уже прочитанных, всё равно приходит (DTS-3).
    ``since`` оставлен для клиентов прежней сборки (веб и API выкладываются отдельно)."""
    inst = db.scalar(select(Instrument).where(Instrument.symbol == symbol.upper()))
    if inst is None:
        raise HTTPException(404, "инструмент не найден")
    ent = entitlements_for(db, user)
    now: datetime = db.execute(select(func.clock_timestamp())).scalar_one()
    changed = (
        Drawing.synced_at >= datetime.fromtimestamp(cursor / 1000, UTC)
        if cursor is not None
        else Drawing.updated_at > since
    )
    rows = db.scalars(
        select(Drawing).where(Drawing.user_id == user.id, Drawing.instrument_id == inst.id, changed)
    ).all()
    return {
        "symbol": inst.symbol,
        "items": [_out(d, inst.symbol) for d in rows],
        "limit": ent.drawings_limit,
        "sync": ent.drawings_sync,
        "cursor": _ms(now - timedelta(milliseconds=CURSOR_OVERLAP_MS)),
    }


@router.put("/drawings", status_code=200)
def upsert_drawings(
    body: list[dict[str, Any]],
    user: User = Depends(auth.current_user),
    db: Session = Depends(auth.get_db),
) -> dict[str, Any]:
    """Пакетная запись (офлайн-очередь клиента по всем инструментам). Каждый рисунок проверяется и
    пишется отдельно: негодный получает отказ в ``rejected`` (статус, код, текст), остальные
    записаны — один отказ не останавливает очередь (DTS-4). ``items`` — итоговые версии принятых
    после слияния. Рисунок не переходит на другой инструмент (DTS-1): запись того же client_id с
    другим инструментом — отказ ``other_symbol``."""
    ent = entitlements_for(db, user)
    if not ent.drawings_sync:
        raise HTTPException(403, "синхронизация рисунков доступна на тарифе Pro")
    if len(body) > 200:
        raise HTTPException(400, "не больше 200 рисунков за запрос")
    out: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    for raw in body:
        # модель — здесь, а не в сигнатуре: стандартный ответ 422 отклонил бы весь пакет и
        # повторил бы входные данные (NaN в JSON не сериализуется)
        try:
            item = DrawingIn.model_validate(raw)
        except ValidationError as e:
            err = e.errors(include_input=False)[0]
            where = ".".join(str(x) for x in err["loc"])
            rejected.append(_rejected(raw, 422, "invalid", f"{where}: {err['msg']}"))
            continue
        if item.type not in TYPES:
            rejected.append(_rejected(raw, 400, "invalid", f"неизвестный тип рисунка: {item.type}"))
            continue
        try:
            levels = fib_levels(item.type, item.levels)
        except ValueError as e:
            rejected.append(_rejected(raw, 422, "invalid", str(e)))
            continue
        inst = db.scalar(select(Instrument).where(Instrument.symbol == item.symbol.upper()))
        if inst is None:
            rejected.append(
                _rejected(raw, 404, "unknown_symbol", f"инструмент не найден: {item.symbol}")
            )
            continue
        row = db.scalar(
            select(Drawing).where(Drawing.user_id == user.id, Drawing.client_id == item.client_id)
        )
        if row is not None and row.instrument_id != inst.id:
            rejected.append(
                _rejected(raw, 409, "other_symbol", "рисунок принадлежит другому инструменту")
            )
            continue
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
                    rejected.append(
                        _rejected(
                            raw,
                            403,
                            "limit",
                            f"лимит рисунков на инструмент: {ent.drawings_limit} "
                            f"(тариф {ent.plan})",
                        )
                    )
                    continue
            row = Drawing(user_id=user.id, client_id=item.client_id, instrument_id=inst.id)
            db.add(row)
        # та же удалённая версия ещё раз (клиент при загрузке шлёт все свои рисунки) — без записи:
        # иначе synced_at сдвигался бы и курсор снова отдавал бы удаление всем устройствам
        resent = row.deleted_at is not None and row.updated_at == item.updated_at
        if winner is incoming and not resent:
            row.timeframe = item.timeframe
            row.type = item.type
            row.points = item.points
            row.style = item.style
            row.text = item.text
            row.levels = levels
            row.locked = item.locked
            row.updated_at = item.updated_at
            row.deleted_at = item.deleted_at
            # курсор чтения — по времени записи этой версии (время запроса, а не начала транзакции)
            row.synced_at = func.clock_timestamp()
        db.flush()
        out.append(_out(row, inst.symbol))
    db.commit()
    return {"items": out, "rejected": rejected}


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
