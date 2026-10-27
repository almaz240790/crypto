"""/v1/alerts — алерты пользователя и журнал срабатываний (план 2A.6; задача 2B.13)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import auth
from app.alerts import (
    DEFAULT_EXPIRES_DAYS,
    FREQUENCIES,
    TYPES,
    active_count,
    alert_dict,
    trigger_dict,
    validate_condition,
)
from app.entitlements import entitlements_for
from app.models import Alert, AlertTrigger, Instrument, User

router = APIRouter(prefix="/v1/alerts", tags=["alerts"])


class AlertIn(BaseModel):
    symbol: str | None = Field(default=None, max_length=32)
    timeframe: str | None = Field(default=None, pattern="^(15m|1h|4h|1d|1w)$")
    type: str = Field(pattern="^(price|indicator|zone|structure|pattern)$")
    condition: dict[str, Any] = Field(default_factory=dict)
    frequency: str = Field(default="once", pattern="^(once|every|once_per_bar)$")
    expires_in_days: int = Field(default=DEFAULT_EXPIRES_DAYS, ge=1, le=365)
    note: str | None = Field(default=None, max_length=140)
    drawing_client_id: str | None = Field(default=None, max_length=40)


class AlertPatch(BaseModel):
    status: str | None = Field(default=None, pattern="^(active|paused)$")
    note: str | None = Field(default=None, max_length=140)
    expires_in_days: int | None = Field(default=None, ge=1, le=365)


def _instrument(db: Session, symbol: str) -> Instrument:
    inst = db.scalar(
        select(Instrument).where(
            Instrument.symbol == symbol.upper(), Instrument.market_type == "futures"
        )
    )
    if inst is None:
        raise HTTPException(404, "инструмент не найден")
    return inst


def _own(db: Session, user: User, alert_id: int) -> Alert:
    a = db.get(Alert, alert_id)
    if a is None or a.user_id != user.id:
        raise HTTPException(404, "алерт не найден")
    return a


def _symbols(db: Session, alerts: list[Alert]) -> dict[int, str]:
    ids = {a.instrument_id for a in alerts if a.instrument_id is not None}
    if not ids:
        return {}
    return dict(
        db.execute(select(Instrument.id, Instrument.symbol).where(Instrument.id.in_(ids))).all()
    )


@router.get("")
def list_alerts(
    symbol: str | None = None,
    status: str | None = Query(None, pattern="^(active|triggered|expired|paused)$"),
    user: User = Depends(auth.current_user),
    db: Session = Depends(auth.get_db),
) -> dict[str, Any]:
    q = select(Alert).where(Alert.user_id == user.id)
    if symbol:
        q = q.where(Alert.instrument_id == _instrument(db, symbol).id)
    if status:
        q = q.where(Alert.status == status)
    alerts = list(db.scalars(q.order_by(Alert.created_at.desc()).limit(500)).all())
    syms = _symbols(db, alerts)
    ent = entitlements_for(db, user)
    return {
        "items": [alert_dict(a, syms.get(a.instrument_id or -1)) for a in alerts],
        "active": active_count(db, user.id),
        "limit": ent.alerts_limit,
        "types": list(TYPES),
        "frequencies": list(FREQUENCIES),
    }


@router.post("", status_code=201)
def create_alert(
    body: AlertIn, user: User = Depends(auth.current_user), db: Session = Depends(auth.get_db)
) -> dict[str, Any]:
    ent = entitlements_for(db, user)
    n = active_count(db, user.id)
    if ent.alerts_limit is not None and n >= ent.alerts_limit:
        raise HTTPException(403, f"лимит активных алертов: {ent.alerts_limit} (тариф {ent.plan})")
    if body.symbol is None and body.type != "pattern":
        raise HTTPException(422, "укажите инструмент")
    try:
        cond = validate_condition(body.type, body.condition, body.timeframe)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    inst = _instrument(db, body.symbol) if body.symbol else None
    now = datetime.now(tz=UTC)
    a = Alert(
        user_id=user.id,
        instrument_id=inst.id if inst else None,
        timeframe=body.timeframe,
        type=body.type,
        condition=cond,
        frequency=body.frequency,
        expires_at=now + timedelta(days=body.expires_in_days),
        status="active",
        drawing_client_id=body.drawing_client_id,
        note=body.note,
    )
    db.add(a)
    db.commit()
    db.refresh(a)
    return alert_dict(a, inst.symbol if inst else None)


@router.patch("/{alert_id}")
def patch_alert(
    alert_id: int,
    body: AlertPatch,
    user: User = Depends(auth.current_user),
    db: Session = Depends(auth.get_db),
) -> dict[str, Any]:
    a = _own(db, user, alert_id)
    if body.status is not None:
        if body.status == "active":
            ent = entitlements_for(db, user)
            if (
                a.status != "active"
                and ent.alerts_limit is not None
                and active_count(db, user.id) >= ent.alerts_limit
            ):
                raise HTTPException(
                    403, f"лимит активных алертов: {ent.alerts_limit} (тариф {ent.plan})"
                )
            if a.frequency == "once" and a.triggers_count > 0:
                a.triggers_count = 0
        a.status = body.status
    if body.note is not None:
        a.note = body.note
    if body.expires_in_days is not None:
        a.expires_at = datetime.now(tz=UTC) + timedelta(days=body.expires_in_days)
        if a.status == "expired":
            a.status = "active"
    db.commit()
    db.refresh(a)
    syms = _symbols(db, [a])
    return alert_dict(a, syms.get(a.instrument_id or -1))


@router.delete("/{alert_id}", status_code=204)
def delete_alert(
    alert_id: int, user: User = Depends(auth.current_user), db: Session = Depends(auth.get_db)
) -> None:
    a = _own(db, user, alert_id)
    db.delete(a)
    db.commit()


@router.get("/triggers")
def list_triggers(
    limit: int = Query(100, ge=1, le=500),
    user: User = Depends(auth.current_user),
    db: Session = Depends(auth.get_db),
) -> dict[str, Any]:
    """Журнал срабатываний пользователя (план 2A.6)."""
    rows = db.execute(
        select(AlertTrigger, Alert)
        .join(Alert, Alert.id == AlertTrigger.alert_id)
        .where(Alert.user_id == user.id)
        .order_by(AlertTrigger.triggered_at.desc())
        .limit(limit)
    ).all()
    alerts = [a for _, a in rows]
    syms = _symbols(db, alerts)
    return {
        "items": [
            {**trigger_dict(t), "alert": alert_dict(a, syms.get(a.instrument_id or -1))}
            for t, a in rows
        ]
    }
