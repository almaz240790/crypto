"""/v1/me — профиль и риск; /v1/watchlist; /v1/journal (план 3.3, 3.7, 3.8, 3.12)."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import auth, twofactor
from app.config import settings
from app.entitlements import entitlements_for
from app.journal_analytics import TradeRow, analytics
from app.models import (
    AuthIdentity,
    Instrument,
    JournalEntry,
    PushSubscription,
    RiskProfile,
    SavedScreen,
    Signal,
    SignalResult,
    StrategyVersion,
    TwoFactor,
    User,
    Watchlist,
    WatchlistItem,
)
from app.notify import send_test, settings_dict, settings_for, unsubscribe
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


@router.get("/me/identities")
def identities(
    user: User = Depends(auth.current_user), db: Session = Depends(auth.get_db)
) -> list[dict[str, Any]]:
    """Подключённые способы входа (план 3.12)."""
    rows = db.scalars(select(AuthIdentity).where(AuthIdentity.user_id == user.id)).all()
    out = [
        {
            "provider": r.provider,
            "label": r.data.get("username") or r.data.get("email") or r.provider_user_id,
            "connected_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]
    if user.password_hash:
        out.insert(0, {"provider": "password", "label": user.email, "connected_at": None})
    return out


@router.get("/me/export.json")
def export_data(
    user: User = Depends(auth.current_user), db: Session = Depends(auth.get_db)
) -> dict[str, Any]:
    """Выгрузка данных пользователя перед удалением (GDPR, план 3.12)."""
    risk = db.get(RiskProfile, user.id)
    journal = db.execute(
        select(JournalEntry, Instrument.symbol)
        .join(Instrument, Instrument.id == JournalEntry.instrument_id)
        .where(JournalEntry.user_id == user.id)
        .order_by(JournalEntry.entry_at)
    ).all()
    wl = _watchlist(db, user)
    symbols = db.scalars(
        select(Instrument.symbol)
        .join(WatchlistItem, WatchlistItem.instrument_id == Instrument.id)
        .where(WatchlistItem.watchlist_id == wl.id)
    ).all()
    return {
        "exported_at": datetime.now(tz=UTC).isoformat(),
        "profile": _user_out(user, risk).model_dump(),
        "watchlist": list(symbols),
        "journal": [_journal_dict(e, sym) for e, sym in journal],
    }


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
        ent = entitlements_for(db, user)
        count = (
            db.scalar(
                select(func.count())
                .select_from(WatchlistItem)
                .where(WatchlistItem.watchlist_id == wl.id)
            )
            or 0
        )
        if ent.watchlist_limit is not None and count >= ent.watchlist_limit:
            raise HTTPException(
                403, f"на тарифе {ent.plan} в вотчлисте до {ent.watchlist_limit} инструментов"
            )
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


# --- сохранённые скрины скринера (план 3.6 v2) --------------------------------------------------

SCREENS_LIMIT = 20
SCREEN_FILTER_KEYS = {
    "bias",
    "near",
    "d1",
    "w1",
    "event",
    "atrp",
    "funding",
    "change",
    "zone_kind",
}


class ScreenIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    filters: dict[str, str] = Field(default_factory=dict)


def _screen_dict(s: SavedScreen) -> dict[str, Any]:
    return {"name": s.name, "filters": s.filters, "created_at": s.created_at.isoformat()}


@router.get("/screener/screens")
def screens_list(
    user: User = Depends(auth.current_user), db: Session = Depends(auth.get_db)
) -> list[dict[str, Any]]:
    rows = db.scalars(
        select(SavedScreen).where(SavedScreen.user_id == user.id).order_by(SavedScreen.name)
    ).all()
    return [_screen_dict(s) for s in rows]


@router.put("/screener/screens")
def screens_put(
    body: ScreenIn, user: User = Depends(auth.current_user), db: Session = Depends(auth.get_db)
) -> dict[str, Any]:
    """Создать или заменить скрин по имени; неизвестные ключи фильтров отбрасываются."""
    filters = {k: v for k, v in body.filters.items() if k in SCREEN_FILTER_KEYS and v}
    row = db.scalar(
        select(SavedScreen).where(SavedScreen.user_id == user.id, SavedScreen.name == body.name)
    )
    if row is None:
        n = db.scalar(
            select(func.count()).select_from(SavedScreen).where(SavedScreen.user_id == user.id)
        )
        if (n or 0) >= SCREENS_LIMIT:
            raise HTTPException(409, f"не больше {SCREENS_LIMIT} сохранённых скринов")
        row = SavedScreen(user_id=user.id, name=body.name, filters=filters)
        db.add(row)
    else:
        row.filters = filters
    db.commit()
    db.refresh(row)
    return _screen_dict(row)


@router.delete("/screener/screens", status_code=204)
def screens_delete(
    name: str = Query(max_length=60),
    user: User = Depends(auth.current_user),
    db: Session = Depends(auth.get_db),
) -> Response:
    row = db.scalar(
        select(SavedScreen).where(SavedScreen.user_id == user.id, SavedScreen.name == name)
    )
    if row is not None:
        db.delete(row)
        db.commit()
    return Response(status_code=204)


# --- 2FA (TOTP), план 3.12 v2 -------------------------------------------------------------------


class TwoFactorCodeIn(BaseModel):
    code: str = Field(min_length=6, max_length=16)


@router.get("/me/2fa")
def two_factor_status(
    user: User = Depends(auth.current_user), db: Session = Depends(auth.get_db)
) -> dict[str, Any]:
    row = db.get(TwoFactor, user.id)
    return {
        "enabled": twofactor.is_enabled(row),
        "backup_codes_left": len(row.backup_codes) if row is not None and row.enabled_at else 0,
    }


@router.post("/me/2fa/setup")
def two_factor_setup(
    user: User = Depends(auth.current_user), db: Session = Depends(auth.get_db)
) -> dict[str, Any]:
    """Новый секрет (пока не включён); повторный вызов заменяет невключённый секрет."""
    row = db.get(TwoFactor, user.id)
    if twofactor.is_enabled(row):
        raise HTTPException(409, "2FA уже включена — сначала отключите")
    secret = twofactor.new_secret()
    if row is None:
        db.add(TwoFactor(user_id=user.id, secret=secret, backup_codes=[]))
    else:
        row.secret = secret
    db.commit()
    return {"secret": secret, "otpauth_url": twofactor.otpauth_url(secret, user.email)}


@router.post("/me/2fa/enable")
def two_factor_enable(
    body: TwoFactorCodeIn,
    user: User = Depends(auth.current_user),
    db: Session = Depends(auth.get_db),
) -> dict[str, Any]:
    """Первый верный код включает 2FA и выдаёт резервные коды (показываются один раз)."""
    row = db.get(TwoFactor, user.id)
    if row is None:
        raise HTTPException(400, "сначала вызовите настройку")
    if row.enabled_at is not None:
        raise HTTPException(409, "2FA уже включена")
    if not twofactor.verify_totp(row.secret, body.code):
        raise HTTPException(400, "неверный код")
    plain, hashes = twofactor.make_backup_codes()
    row.enabled_at = datetime.now(tz=UTC)
    row.backup_codes = hashes
    db.commit()
    return {"enabled": True, "backup_codes": plain}


@router.post("/me/2fa/disable", status_code=204)
def two_factor_disable(
    body: TwoFactorCodeIn,
    user: User = Depends(auth.current_user),
    db: Session = Depends(auth.get_db),
) -> Response:
    row = db.get(TwoFactor, user.id)
    if not twofactor.is_enabled(row) or row is None:
        raise HTTPException(400, "2FA не включена")
    if not twofactor.verify_code(row, body.code):
        db.commit()
        raise HTTPException(400, "неверный код")
    db.delete(row)
    db.commit()
    return Response(status_code=204)


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
    summary: dict[str, Any] = {
        "trades": len(rows),
        "closed": len(closed),
        "sum_r": format(sum(rs, Decimal(0)), "f") if rs else "0",
        "avg_r": format(sum(rs, Decimal(0)) / len(rs), "f") if rs else None,
        "winrate": (sum(1 for r in rs if r > 0) / len(rs)) if rs else None,
    }
    summary.update(_vs_system(db, user, [e for e, _ in rows]))
    return {"items": items, "summary": summary, "limit": limit, "offset": offset}


@router.get("/journal/analytics")
def journal_analytics(
    user: User = Depends(auth.current_user), db: Session = Depends(auth.get_db)
) -> dict[str, Any]:
    """Аналитика журнала (план 3.8 v2): дни недели, инструменты, градации, капитал, ошибки."""
    rows = db.execute(
        select(JournalEntry, Instrument.symbol, Signal.grade, SignalResult.realized_r)
        .join(Instrument, Instrument.id == JournalEntry.instrument_id)
        .outerjoin(Signal, Signal.id == JournalEntry.signal_id)
        .outerjoin(SignalResult, SignalResult.signal_id == JournalEntry.signal_id)
        .where(JournalEntry.user_id == user.id)
    ).all()
    trades = [
        TradeRow(
            symbol=sym,
            direction=e.direction,
            entry_at=e.entry_at,
            exit_at=e.exit_at,
            entry_price=e.entry_price,
            stop_loss=e.stop_loss,
            size=e.size,
            realized_r=e.realized_r,
            signal_id=e.signal_id,
            grade=grade,
            system_r=sys_r,
        )
        for e, sym, grade, sys_r in rows
    ]
    risk = db.get(RiskProfile, user.id)
    return analytics(trades, risk.deposit if risk else None, risk.risk_pct if risk else None)


def _vs_system(db: Session, user: User, entries: list[JournalEntry]) -> dict[str, Any]:
    """Сравнение с сигналами (план 3.8): доля исполненных live-сигналов за период журнала
    и средний R пользователя против среднего R тех же сигналов по трекеру."""
    linked = [e for e in entries if e.signal_id is not None]
    if not entries:
        return {"executed_share": None, "system_avg_r": None, "linked": 0}
    since = min(e.entry_at for e in entries)
    live_total = (
        db.scalar(
            select(func.count())
            .select_from(Signal)
            .join(StrategyVersion, StrategyVersion.id == Signal.strategy_version_id)
            .where(StrategyVersion.status == "live", Signal.candle_close_time >= since)
        )
        or 0
    )
    sys_rs = (
        db.scalars(
            select(SignalResult.realized_r).where(
                SignalResult.signal_id.in_([e.signal_id for e in linked])
            )
        ).all()
        if linked
        else []
    )
    return {
        "linked": len(linked),
        "executed_share": (len(linked) / live_total) if live_total else None,
        "system_avg_r": format(sum(sys_rs, Decimal(0)) / len(sys_rs), "f") if sys_rs else None,
    }


@router.get("/journal/export.csv")
def journal_export(
    user: User = Depends(auth.current_user), db: Session = Depends(auth.get_db)
) -> StreamingResponse:
    rows = db.execute(
        select(JournalEntry, Instrument.symbol)
        .join(Instrument, Instrument.id == JournalEntry.instrument_id)
        .where(JournalEntry.user_id == user.id)
        .order_by(JournalEntry.entry_at)
    ).all()
    cols = [
        "id",
        "symbol",
        "direction",
        "entry_at",
        "entry_price",
        "stop_loss",
        "take_profits",
        "size",
        "exit_at",
        "exit_price",
        "realized_r",
        "realized_quote",
        "fees",
        "tags",
        "note",
        "source",
        "signal_id",
    ]

    def gen() -> Iterator[str]:
        yield ",".join(cols) + "\n"
        for e, sym in rows:
            d = _journal_dict(e, sym)
            vals = []
            for c in cols:
                v = d[c]
                if isinstance(v, list):
                    v = " ".join(str(x) for x in v)
                s = "" if v is None else str(v).replace('"', "'")
                vals.append(f'"{s}"' if ("," in s or "\n" in s) else s)
            yield ",".join(vals) + "\n"

    return StreamingResponse(
        gen(),
        media_type="text/csv",
        headers={"content-disposition": "attachment; filename=platform-journal.csv"},
    )


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
    ent = entitlements_for(db, user)
    if ent.journal_limit is not None:
        count = (
            db.scalar(
                select(func.count())
                .select_from(JournalEntry)
                .where(JournalEntry.user_id == user.id)
            )
            or 0
        )
        if count >= ent.journal_limit:
            raise HTTPException(403, f"на тарифе {ent.plan} журнал до {ent.journal_limit} записей")
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


# --- уведомления (план 3.11) --------------------------------------------------------------------


class NotificationsIn(BaseModel):
    email_digest: str | None = Field(default=None, pattern="^(daily|weekly|off)$")
    email_signals: bool | None = None
    email_events: bool | None = None
    grades: list[str] | None = Field(default=None, max_length=3)
    scope: str | None = Field(default=None, pattern="^(all|watchlist)$")
    quiet_from: int | None = Field(default=None, ge=0, le=23)
    quiet_to: int | None = Field(default=None, ge=0, le=23)
    daily_limit: int | None = Field(default=None, ge=1, le=200)
    push_signals: bool | None = None
    push_events: bool | None = None
    email_alerts: bool | None = None
    push_alerts: bool | None = None
    clear_quiet: bool = False


@router.get("/me/notifications")
def get_notifications(
    user: User = Depends(auth.current_user), db: Session = Depends(auth.get_db)
) -> dict[str, Any]:
    ns = settings_for(db, user)
    db.commit()
    return settings_dict(ns)


@router.patch("/me/notifications")
def update_notifications(
    body: NotificationsIn,
    user: User = Depends(auth.current_user),
    db: Session = Depends(auth.get_db),
) -> dict[str, Any]:
    ns = settings_for(db, user)
    data = body.model_dump(exclude_none=True)
    data.pop("clear_quiet", None)
    if "grades" in data:
        data["grades"] = sorted({g.upper() for g in data["grades"] if g.upper() in ("A", "B", "C")})
    for k, v in data.items():
        setattr(ns, k, v)
    if body.clear_quiet:
        ns.quiet_from = None
        ns.quiet_to = None
    db.commit()
    return settings_dict(ns)


@router.post("/me/notifications/test")
def test_notification(
    user: User = Depends(auth.current_user), db: Session = Depends(auth.get_db)
) -> dict[str, str]:
    """Тестовое письмо себе (приёмка 2.13). Требует подтверждённый email."""
    if user.email_verified_at is None:
        raise HTTPException(400, "сначала подтвердите email")
    return {"status": send_test(db, user)}


class UnsubscribeIn(BaseModel):
    token: str = Field(min_length=10, max_length=128)


@router.post("/notifications/unsubscribe")
def unsubscribe_all(body: UnsubscribeIn, db: Session = Depends(auth.get_db)) -> dict[str, str]:
    """Отписка по ссылке из письма — без входа (приёмка 2.13: «отписка работает»)."""
    if not unsubscribe(db, body.token):
        raise HTTPException(404, "ссылка отписки недействительна")
    return {"status": "ok"}


# --- web push (план 3.11, задача 2.15) ---------------------------------------------------------


class PushIn(BaseModel):
    endpoint: str = Field(min_length=20, max_length=2000)
    keys: dict[str, str]


@router.get("/push/public-key")
def push_public_key() -> dict[str, str | None]:
    from app.push import enabled

    return {"key": settings.vapid_public_key if enabled() else None}


@router.post("/me/push", status_code=201)
def push_subscribe(
    body: PushIn,
    request: Request,
    user: User = Depends(auth.current_user),
    db: Session = Depends(auth.get_db),
) -> dict[str, Any]:
    p256dh, auth_key = body.keys.get("p256dh"), body.keys.get("auth")
    if not p256dh or not auth_key:
        raise HTTPException(400, "в подписке нет ключей")
    sub = db.scalar(select(PushSubscription).where(PushSubscription.endpoint == body.endpoint))
    if sub is None:
        sub = PushSubscription(
            user_id=user.id, endpoint=body.endpoint, p256dh=p256dh, auth_key=auth_key
        )
        db.add(sub)
    sub.user_id = user.id
    sub.p256dh = p256dh
    sub.auth_key = auth_key
    sub.user_agent = (request.headers.get("user-agent") or "")[:255]
    sub.failures = 0
    db.commit()
    count = db.scalar(
        select(func.count())
        .select_from(PushSubscription)
        .where(PushSubscription.user_id == user.id)
    )
    return {"subscriptions": int(count or 0)}


class PushDeleteIn(BaseModel):
    endpoint: str


@router.delete("/me/push", status_code=204)
def push_unsubscribe(
    body: PushDeleteIn, user: User = Depends(auth.current_user), db: Session = Depends(auth.get_db)
) -> Response:
    sub = db.scalar(
        select(PushSubscription).where(
            PushSubscription.endpoint == body.endpoint, PushSubscription.user_id == user.id
        )
    )
    if sub:
        db.delete(sub)
        db.commit()
    return Response(status_code=204)


@router.post("/me/push/test")
def push_test(
    user: User = Depends(auth.current_user), db: Session = Depends(auth.get_db)
) -> dict[str, Any]:
    from app.push import enabled, send_to_user

    if not enabled():
        return {"sent": 0, "status": "ключи push не заданы"}
    n = send_to_user(
        db,
        user.id,
        {"title": "Platform", "body": "Push работает.", "url": "/signals", "tag": "test"},
    )
    db.commit()
    return {"sent": n, "status": "отправлено" if n else "нет активных подписок"}
