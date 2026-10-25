"""/v1/me — профиль и риск; /v1/watchlist; /v1/journal (план 3.3, 3.7, 3.8, 3.12)."""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import auth
from app.models import Instrument, JournalEntry, RiskProfile, Signal, User, Watchlist, WatchlistItem
from app.routers.auth import UserOut, _user_out

router = APIRouter(prefix="/v1", tags=["user"])


# --- профиль ----------------------------------------------------------------------------------


class ProfileIn(BaseModel):
    name: str | None = Field(default=None, max_length=100)
    locale: str | None = Field(default=None, pattern="^(ru|en)$")
    timezone: str | None = Field(default=None, max_length=64)
    theme: str | None = Field(default=None, pattern="^(light|dark|system)$")
    country: str | None = Field(default=None, min_length=2, max_length=2)
    marketing_opt_in: bool | None = None


class RiskIn(BaseModel):
    deposit: Decimal | None = Field(default=None, ge=0)
    risk_pct: Decimal | None = Field(default=None, gt=0, le=10)
    exchange: str | None = Field(default=None, pattern="^(binance|bybit)$")
    market_type: str | None = Field(default=None, pattern="^(spot|futures)$")
    default_leverage: int | None = Field(default=None, ge=1, le=50)
    experience: str | None = Field(default=None, pattern="^(novice|experienced|systematic)$")


@router.patch("/me", response_model=UserOut)
def update_profile(
    body: ProfileIn, user: User = Depends(auth.current_user), db: Session = Depends(auth.get_db)
) -> UserOut:
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(user, k, v)
    db.commit()
    return _user_out(user, db.get(RiskProfile, user.id))


@router.patch("/me/risk", response_model=UserOut)
def update_risk(
    body: RiskIn, user: User = Depends(auth.current_user), db: Session = Depends(auth.get_db)
) -> UserOut:
    risk = db.get(RiskProfile, user.id)
    if risk is None:
        risk = RiskProfile(user_id=user.id)
        db.add(risk)
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(risk, k, v)
    db.commit()
    return _user_out(user, risk)


class PasswordIn(BaseModel):
    current_password: str | None = None
    new_password: str = Field(min_length=10, max_length=128)


@router.post("/me/password", status_code=204)
def change_password(
    body: PasswordIn, user: User = Depends(auth.current_user), db: Session = Depends(auth.get_db)
) -> Response:
    if user.password_hash and not auth.verify_password(
        body.current_password or "", user.password_hash
    ):
        raise HTTPException(400, "текущий пароль неверен")
    user.password_hash = auth.hash_password(body.new_password)
    db.commit()
    return Response(status_code=204)


@router.delete("/me", status_code=204)
def delete_account(
    user: User = Depends(auth.current_user), db: Session = Depends(auth.get_db)
) -> Response:
    """Мягкое удаление (GDPR): помечаем, анонимизируем email, сессии отзываются."""
    user.deleted_at = datetime.now(tz=UTC)
    user.email = f"deleted-{user.id}@users.platform.local"
    user.name = None
    user.password_hash = None
    db.commit()
    return Response(status_code=204)


# --- вотчлист ---------------------------------------------------------------------------------


def _watchlist(db: Session, user: User) -> Watchlist:
    wl = db.scalar(select(Watchlist).where(Watchlist.user_id == user.id).order_by(Watchlist.id))
    if wl is None:
        wl = Watchlist(user_id=user.id)
        db.add(wl)
        db.commit()
    return wl


@router.get("/watchlist")
def watchlist(
    user: User = Depends(auth.current_user), db: Session = Depends(auth.get_db)
) -> dict[str, Any]:
    wl = _watchlist(db, user)
    rows = db.execute(
        select(WatchlistItem, Instrument)
        .join(Instrument, Instrument.id == WatchlistItem.instrument_id)
        .where(WatchlistItem.watchlist_id == wl.id)
        .order_by(WatchlistItem.added_at)
    ).all()
    return {
        "id": wl.id,
        "name": wl.name,
        "items": [
            {"symbol": inst.symbol, "instrument_id": inst.id, "added_at": item.added_at.isoformat()}
            for item, inst in rows
        ],
    }


class WatchItemIn(BaseModel):
    symbol: str = Field(max_length=32)


@router.post("/watchlist/items", status_code=201)
def add_watch_item(
    body: WatchItemIn, user: User = Depends(auth.current_user), db: Session = Depends(auth.get_db)
) -> dict[str, Any]:
    inst = db.scalar(
        select(Instrument).where(Instrument.symbol == body.symbol.upper(), Instrument.is_active)
    )
    if inst is None:
        raise HTTPException(404, "инструмент не найден")
    wl = _watchlist(db, user)
    exists = db.scalar(
        select(WatchlistItem).where(
            WatchlistItem.watchlist_id == wl.id, WatchlistItem.instrument_id == inst.id
        )
    )
    if exists is None:
        db.add(WatchlistItem(watchlist_id=wl.id, instrument_id=inst.id))
        db.commit()
    return {"symbol": inst.symbol, "instrument_id": inst.id}


@router.delete("/watchlist/items/{symbol}", status_code=204)
def remove_watch_item(
    symbol: str, user: User = Depends(auth.current_user), db: Session = Depends(auth.get_db)
) -> Response:
    wl = _watchlist(db, user)
    item = db.scalar(
        select(WatchlistItem)
        .join(Instrument, Instrument.id == WatchlistItem.instrument_id)
        .where(WatchlistItem.watchlist_id == wl.id, Instrument.symbol == symbol.upper())
    )
    if item:
        db.delete(item)
        db.commit()
    return Response(status_code=204)


# --- журнал -----------------------------------------------------------------------------------


class JournalIn(BaseModel):
    symbol: str = Field(max_length=32)
    direction: str = Field(pattern="^(long|short)$")
    entry_price: Decimal = Field(gt=0)
    entry_at: datetime
    stop_loss: Decimal | None = Field(default=None, gt=0)
    take_profits: list[Decimal] = Field(default_factory=list, max_length=5)
    size: Decimal | None = Field(default=None, gt=0)
    exit_price: Decimal | None = Field(default=None, gt=0)
    exit_at: datetime | None = None
    fees: Decimal | None = Field(default=None, ge=0)
    tags: list[str] = Field(default_factory=list, max_length=10)
    note: str | None = Field(default=None, max_length=2000)
    signal_id: str | None = Field(default=None, description="public_id сигнала, если «Я вошёл»")


def _realized_r(e: JournalEntry) -> Decimal | None:
    if e.exit_price is None or e.stop_loss is None:
        return None
    sign = 1 if e.direction == "long" else -1
    risk = (e.entry_price - e.stop_loss) * sign
    if risk <= 0:
        return None
    return (e.exit_price - e.entry_price) * sign / risk


def _journal_dict(e: JournalEntry, symbol: str) -> dict[str, Any]:
    def dec(x: Decimal | None) -> str | None:
        return None if x is None else format(x.normalize(), "f")

    return {
        "id": e.id,
        "symbol": symbol,
        "direction": e.direction,
        "entry_price": dec(e.entry_price),
        "entry_at": e.entry_at.isoformat(),
        "stop_loss": dec(e.stop_loss),
        "take_profits": e.take_profits,
        "size": dec(e.size),
        "exit_price": dec(e.exit_price),
        "exit_at": e.exit_at.isoformat() if e.exit_at else None,
        "realized_r": dec(e.realized_r),
        "realized_quote": dec(e.realized_quote),
        "fees": dec(e.fees),
        "tags": e.tags,
        "note": e.note,
        "source": e.source,
        "signal_id": e.signal_id,
        "created_at": e.created_at.isoformat() if e.created_at else None,
    }


@router.get("/journal")
def journal_list(
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    user: User = Depends(auth.current_user),
    db: Session = Depends(auth.get_db),
) -> dict[str, Any]:
    rows = db.execute(
        select(JournalEntry, Instrument.symbol)
        .join(Instrument, Instrument.id == JournalEntry.instrument_id)
        .where(JournalEntry.user_id == user.id)
        .order_by(JournalEntry.entry_at.desc())
        .limit(limit)
        .offset(offset)
    ).all()
    items = [_journal_dict(e, sym) for e, sym in rows]
    closed = [e for e, _ in rows if e.realized_r is not None]
    rs = [e.realized_r for e in closed if e.realized_r is not None]
    summary = {
        "trades": len(rows),
        "closed": len(closed),
        "sum_r": format(sum(rs, Decimal(0)), "f") if rs else "0",
        "winrate": (sum(1 for r in rs if r > 0) / len(rs)) if rs else None,
    }
    return {"items": items, "summary": summary, "limit": limit, "offset": offset}


def _apply_journal(e: JournalEntry, body: JournalIn, db: Session) -> None:
    inst = db.scalar(select(Instrument).where(Instrument.symbol == body.symbol.upper()))
    if inst is None:
        raise HTTPException(404, "инструмент не найден")
    e.instrument_id = inst.id
    e.direction = body.direction
    e.entry_price = body.entry_price
    e.entry_at = body.entry_at
    e.stop_loss = body.stop_loss
    e.take_profits = [format(x, "f") for x in body.take_profits]
    e.size = body.size
    e.exit_price = body.exit_price
    e.exit_at = body.exit_at
    e.fees = body.fees
    e.tags = body.tags
    e.note = body.note
    if body.signal_id:
        sig = db.scalar(select(Signal).where(Signal.public_id == body.signal_id))
        e.signal_id = sig.id if sig else None
        e.source = "signal" if sig else "manual"
    e.realized_r = _realized_r(e)
    if e.exit_price is not None and e.size is not None:
        sign = 1 if e.direction == "long" else -1
        e.realized_quote = (e.exit_price - e.entry_price) * sign * e.size - (e.fees or Decimal(0))


@router.post("/journal", status_code=201)
def journal_create(
    body: JournalIn, user: User = Depends(auth.current_user), db: Session = Depends(auth.get_db)
) -> dict[str, Any]:
    e = JournalEntry(user_id=user.id)
    _apply_journal(e, body, db)
    db.add(e)
    db.commit()
    inst = db.get(Instrument, e.instrument_id)
    return _journal_dict(e, inst.symbol if inst else body.symbol.upper())


@router.put("/journal/{entry_id}")
def journal_update(
    entry_id: int,
    body: JournalIn,
    user: User = Depends(auth.current_user),
    db: Session = Depends(auth.get_db),
) -> dict[str, Any]:
    e = db.get(JournalEntry, entry_id)
    if e is None or e.user_id != user.id:
        raise HTTPException(404)
    _apply_journal(e, body, db)
    db.commit()
    inst = db.get(Instrument, e.instrument_id)
    return _journal_dict(e, inst.symbol if inst else body.symbol.upper())


@router.delete("/journal/{entry_id}", status_code=204)
def journal_delete(
    entry_id: int, user: User = Depends(auth.current_user), db: Session = Depends(auth.get_db)
) -> Response:
    e = db.get(JournalEntry, entry_id)
    if e is None or e.user_id != user.id:
        raise HTTPException(404)
    db.delete(e)
    db.commit()
    return Response(status_code=204)
