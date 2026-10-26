"""/v1/admin/* — базовая админка (план 3.15, задача 2.14): стратегии и версии с четырёхглазым
подтверждением статусов, инструменты, сигналы (отмена с публичной причиной), пользователи,
системный статус. Каждое действие — строка в admin_audit."""

from __future__ import annotations

import json
import time
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import redis as redis_sync
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app import auth, billing
from app.admin_rules import can_decide, transition_allowed
from app.config import settings
from app.models import (
    AdminAudit,
    BacktestRun,
    Instrument,
    NotificationLog,
    PromoCode,
    Signal,
    SignalEvent,
    StatusChangeRequest,
    Strategy,
    StrategyVersion,
    Subscription,
    SupportTicket,
    User,
)
from app.support import reply_ticket, ticket_dict

router = APIRouter(prefix="/v1/admin", tags=["admin"])
ADMIN = auth.require_role("admin", "owner")
OPEN = ("pending", "active", "tp1_hit", "tp2_hit")


def _audit(
    db: Session, actor: User, action: str, target: str, payload: dict[str, Any] | None = None
) -> None:
    db.add(AdminAudit(actor_id=actor.id, action=action, target=target, payload=payload or {}))


def _dec(x: Decimal | None) -> str | None:
    return None if x is None else format(x.normalize(), "f")


# --- стратегии ----------------------------------------------------------------------------------


@router.get("/strategies")
def strategies(user: User = Depends(ADMIN), db: Session = Depends(auth.get_db)) -> dict[str, Any]:
    versions = db.execute(
        select(StrategyVersion, Strategy.name, Strategy.slug)
        .join(Strategy, Strategy.id == StrategyVersion.strategy_id)
        .order_by(StrategyVersion.id)
    ).all()
    counts = dict(
        db.execute(
            select(Signal.strategy_version_id, func.count()).group_by(Signal.strategy_version_id)
        ).all()
    )
    runs = db.scalars(select(BacktestRun).order_by(BacktestRun.id.desc()).limit(20)).all()
    reqs = db.execute(
        select(StatusChangeRequest, User.email)
        .join(User, User.id == StatusChangeRequest.requested_by)
        .order_by(StatusChangeRequest.id.desc())
        .limit(50)
    ).all()
    return {
        "versions": [
            {
                "id": v.id,
                "strategy": slug,
                "name": name,
                "version": v.version,
                "status": v.status,
                "params": v.params,
                "created_by": v.created_by,
                "approved_by": v.approved_by,
                "activated_at": v.activated_at.isoformat() if v.activated_at else None,
                "signals": int(counts.get(v.id, 0)),
            }
            for v, name, slug in versions
        ],
        "runs": [
            {
                "id": r.id,
                "strategy_version": r.strategy_version,
                "period": [r.period_start.date().isoformat(), r.period_end.date().isoformat()],
                "instruments": len(r.instruments or []),
                "note": r.note,
                "metrics": (r.result_summary or {}).get("metrics", {}),
            }
            for r in runs
        ],
        "requests": [
            {
                "id": r.id,
                "strategy_version_id": r.strategy_version_id,
                "from_status": r.from_status,
                "to_status": r.to_status,
                "reason": r.reason,
                "requested_by": email,
                "requested_by_id": r.requested_by,
                "decision": r.decision,
                "decision_note": r.decision_note,
                "created_at": r.created_at.isoformat() if r.created_at else None,
                "decided_at": r.decided_at.isoformat() if r.decided_at else None,
            }
            for r, email in reqs
        ],
        "me": {"id": user.id, "role": user.role},
    }


class StatusRequestIn(BaseModel):
    strategy_version_id: int
    to_status: str = Field(pattern="^(backtest|forward|live|archived)$")
    reason: str = Field(min_length=10, max_length=2000)


@router.post("/strategies/status-requests", status_code=201)
def create_status_request(
    body: StatusRequestIn, user: User = Depends(ADMIN), db: Session = Depends(auth.get_db)
) -> dict[str, Any]:
    v = db.get(StrategyVersion, body.strategy_version_id)
    if v is None:
        raise HTTPException(404, "версия не найдена")
    if not transition_allowed(v.status, body.to_status):
        raise HTTPException(400, f"переход {v.status} → {body.to_status} не разрешён")
    pending = db.scalar(
        select(StatusChangeRequest.id).where(
            StatusChangeRequest.strategy_version_id == v.id,
            StatusChangeRequest.decision == "pending",
        )
    )
    if pending:
        raise HTTPException(409, "по этой версии уже есть открытая заявка")
    r = StatusChangeRequest(
        strategy_version_id=v.id,
        from_status=v.status,
        to_status=body.to_status,
        reason=body.reason,
        requested_by=user.id,
    )
    db.add(r)
    db.flush()
    _audit(
        db,
        user,
        "status_request.create",
        f"strategy_version:{v.id}",
        {"to": body.to_status, "request": r.id},
    )
    db.commit()
    return {"id": r.id, "decision": r.decision}


class DecisionIn(BaseModel):
    approve: bool
    note: str | None = Field(default=None, max_length=2000)


@router.post("/strategies/status-requests/{req_id}/decide")
def decide_status_request(
    req_id: int, body: DecisionIn, user: User = Depends(ADMIN), db: Session = Depends(auth.get_db)
) -> dict[str, Any]:
    """Второй админ подтверждает или отклоняет. При подтверждении статус применяется;
    при переводе в live — у других версий live снимается (одна live-версия стратегии)."""
    r = db.get(StatusChangeRequest, req_id)
    if r is None or r.decision != "pending":
        raise HTTPException(404, "заявка не найдена или уже решена")
    ok, mode = can_decide(r.requested_by, user.id, user.role, body.note)
    if not ok:
        raise HTTPException(403, mode)
    v = db.get(StrategyVersion, r.strategy_version_id)
    if v is None:
        raise HTTPException(404, "версия не найдена")
    now = datetime.now(tz=UTC)
    r.decided_by = user.id
    r.decided_at = now
    r.decision_note = body.note
    if not body.approve:
        r.decision = "rejected"
        _audit(db, user, "status_request.reject", f"strategy_version:{v.id}", {"request": r.id})
        db.commit()
        return {"id": r.id, "decision": r.decision}
    if v.status != r.from_status:
        raise HTTPException(409, "статус версии изменился, создайте новую заявку")
    if r.to_status == "live":
        for other in db.scalars(
            select(StrategyVersion).where(
                StrategyVersion.strategy_id == v.strategy_id,
                StrategyVersion.status == "live",
                StrategyVersion.id != v.id,
            )
        ).all():
            other.status = "forward"
            _audit(
                db,
                user,
                "version.status",
                f"strategy_version:{other.id}",
                {"from": "live", "to": "forward", "reason": "replaced"},
            )
        v.activated_at = now
    v.status = r.to_status
    v.approved_by = user.email
    r.decision = "applied"
    _audit(
        db,
        user,
        "version.status",
        f"strategy_version:{v.id}",
        {"from": r.from_status, "to": r.to_status, "request": r.id, "mode": mode or "four-eyes"},
    )
    db.commit()
    return {"id": r.id, "decision": r.decision, "status": v.status}


# --- инструменты --------------------------------------------------------------------------------


@router.get("/instruments")
def instruments(
    user: User = Depends(ADMIN), db: Session = Depends(auth.get_db)
) -> list[dict[str, Any]]:
    rows = db.scalars(select(Instrument).order_by(Instrument.symbol)).all()
    last: dict[int, datetime] = dict(
        db.execute(
            text(
                "select instrument_id, max(open_time) from candles "
                "where timeframe='4h' group by instrument_id"
            )
        ).all()
    )
    return [
        {
            "id": i.id,
            "symbol": i.symbol,
            "exchange": i.exchange,
            "market_type": i.market_type,
            "is_active": i.is_active,
            "tick_size": _dec(i.tick_size),
            "lot_size": _dec(i.lot_size),
            "min_notional": _dec(i.min_notional),
            "last_h4": last[i.id].isoformat() if i.id in last else None,
        }
        for i in rows
    ]


class InstrumentIn(BaseModel):
    is_active: bool | None = None
    lot_size: Decimal | None = Field(default=None, gt=0)
    tick_size: Decimal | None = Field(default=None, gt=0)
    min_notional: Decimal | None = Field(default=None, ge=0)


@router.patch("/instruments/{inst_id}")
def update_instrument(
    inst_id: int,
    body: InstrumentIn,
    user: User = Depends(ADMIN),
    db: Session = Depends(auth.get_db),
) -> dict[str, Any]:
    i = db.get(Instrument, inst_id)
    if i is None:
        raise HTTPException(404)
    data = body.model_dump(exclude_none=True)
    for k, v in data.items():
        setattr(i, k, v)
    _audit(
        db,
        user,
        "instrument.update",
        f"instrument:{i.symbol}",
        json.loads(json.dumps(data, default=str)),
    )
    db.commit()
    return {"id": i.id, "symbol": i.symbol, "is_active": i.is_active}


# --- сигналы ------------------------------------------------------------------------------------


@router.get("/signals")
def admin_signals(
    status: str | None = None,
    limit: int = Query(100, ge=1, le=500),
    user: User = Depends(ADMIN),
    db: Session = Depends(auth.get_db),
) -> list[dict[str, Any]]:
    q = (
        select(Signal, Instrument.symbol, StrategyVersion.version, StrategyVersion.status)
        .join(Instrument, Instrument.id == Signal.instrument_id)
        .join(StrategyVersion, StrategyVersion.id == Signal.strategy_version_id)
        .order_by(Signal.id.desc())
        .limit(limit)
    )
    if status == "open":
        q = q.where(Signal.status.in_(OPEN))
    elif status:
        q = q.where(Signal.status == status)
    return [
        {
            "id": s.public_id,
            "symbol": sym,
            "version": ver,
            "scope": vstatus,
            "direction": s.direction,
            "grade": s.grade,
            "score": s.score,
            "status": s.status,
            "candle_close_time": s.candle_close_time.isoformat(),
            "entry": _dec(s.entry_limit or s.entry_market),
            "stop": _dec(s.stop_loss),
            "flags": (s.rationale_facts or {}).get("flags", []),
            "facts": (s.rationale_facts or {}).get("facts", []),
            "input_hash": s.input_hash,
        }
        for s, sym, ver, vstatus in db.execute(q).all()
    ]


class CancelIn(BaseModel):
    reason: str = Field(min_length=10, max_length=500, description="публичная причина")


@router.post("/signals/{public_id}/cancel")
def cancel_signal(
    public_id: str, body: CancelIn, user: User = Depends(ADMIN), db: Session = Depends(auth.get_db)
) -> dict[str, Any]:
    """Отмена без удаления: статус cancelled и событие с публичной причиной (правило 1)."""
    s = db.scalar(select(Signal).where(Signal.public_id == public_id))
    if s is None:
        raise HTTPException(404)
    if s.status not in OPEN:
        raise HTTPException(409, "отменить можно только открытый сигнал")
    s.status = "cancelled"
    db.add(
        SignalEvent(
            signal_id=s.id,
            type="cancelled",
            occurred_at=datetime.now(tz=UTC),
            source="admin",
            note=body.reason,
        )
    )
    _audit(db, user, "signal.cancel", f"signal:{public_id}", {"reason": body.reason})
    db.commit()
    return {"id": public_id, "status": s.status}


# --- пользователи -------------------------------------------------------------------------------


@router.get("/users")
def users(
    q: str | None = None,
    limit: int = Query(50, ge=1, le=200),
    user: User = Depends(ADMIN),
    db: Session = Depends(auth.get_db),
) -> list[dict[str, Any]]:
    stmt = select(User).order_by(User.id.desc()).limit(limit)
    if q:
        stmt = stmt.where(User.email.ilike(f"%{q.strip()}%"))
    subs = {s.user_id: s for s in db.scalars(select(Subscription)).all()}
    return [
        {
            "id": u.id,
            "email": u.email,
            "plan": subs[u.id].plan if u.id in subs else "free",
            "plan_until": subs[u.id].current_period_end.isoformat() if u.id in subs else None,
            "plan_status": subs[u.id].status if u.id in subs else None,
            "name": u.name,
            "role": u.role,
            "country": u.country,
            "verified": u.email_verified_at is not None,
            "created_at": u.created_at.isoformat() if u.created_at else None,
            "blocked_at": u.blocked_at.isoformat() if u.blocked_at else None,
            "blocked_reason": u.blocked_reason,
            "deleted": u.deleted_at is not None,
        }
        for u in db.scalars(stmt).all()
    ]


class UserUpdateIn(BaseModel):
    role: str | None = Field(default=None, pattern="^(user|support|admin|owner)$")
    block: bool | None = None
    reason: str | None = Field(default=None, max_length=255)


@router.patch("/users/{user_id}")
def update_user(
    user_id: int,
    body: UserUpdateIn,
    user: User = Depends(ADMIN),
    db: Session = Depends(auth.get_db),
) -> dict[str, Any]:
    u = db.get(User, user_id)
    if u is None:
        raise HTTPException(404)
    if body.role is not None:
        if user.role != "owner":
            raise HTTPException(403, "роли меняет только владелец")
        if u.id == user.id:
            raise HTTPException(400, "свою роль менять нельзя")
        _audit(db, user, "user.role", f"user:{u.id}", {"from": u.role, "to": body.role})
        u.role = body.role
    if body.block is not None:
        if u.id == user.id:
            raise HTTPException(400, "себя заблокировать нельзя")
        if u.role == "owner":
            raise HTTPException(403, "владельца заблокировать нельзя")
        u.blocked_at = datetime.now(tz=UTC) if body.block else None
        u.blocked_reason = body.reason if body.block else None
        _audit(
            db,
            user,
            "user.block" if body.block else "user.unblock",
            f"user:{u.id}",
            {"reason": body.reason},
        )
    db.commit()
    return {"id": u.id, "role": u.role, "blocked": u.blocked_at is not None}


# --- системный статус и аудит -------------------------------------------------------------------


@router.get("/system")
def system(user: User = Depends(ADMIN), db: Session = Depends(auth.get_db)) -> dict[str, Any]:
    now = int(time.time())
    workers: dict[str, Any] = {}
    try:
        r = redis_sync.Redis.from_url(settings.redis_url, decode_responses=True)
        try:
            for name, key in (
                ("market_data", "market_data:heartbeat"),
                ("tracker", "tracker:heartbeat"),
                ("notifier", "notifier:heartbeat"),
                ("scheduler", "scheduler:heartbeat"),
            ):
                v = r.get(key)
                workers[name] = {"heartbeat_age_sec": (now - int(v)) if v else None}
            st = r.get("market_data:status")
            workers["market_data"]["status"] = json.loads(st) if st else None
        finally:
            r.close()
    except Exception as exc:
        workers["error"] = f"{type(exc).__name__}: {exc}"[:200]
    lag = db.execute(
        text(
            "select count(*) filter (where m < now() - interval '5 hours') as stale, "
            "count(*) as total from (select instrument_id, max(open_time) m from candles "
            "where timeframe='4h' group by 1) t"
        )
    ).first()
    last_signal = db.scalar(select(func.max(Signal.created_at)))
    last_event = db.scalar(select(func.max(SignalEvent.occurred_at)))
    sent_today = db.scalar(
        select(func.count())
        .select_from(NotificationLog)
        .where(
            NotificationLog.sent_at
            >= datetime.now(tz=UTC).replace(hour=0, minute=0, second=0, microsecond=0)
        )
    )
    return {
        "now": datetime.now(tz=UTC).isoformat(),
        "workers": workers,
        "candles_h4": {
            "instruments": int(lag[1]) if lag else 0,
            "stale_over_5h": int(lag[0]) if lag else 0,
        },
        "last_signal_at": last_signal.isoformat() if last_signal else None,
        "last_event_at": last_event.isoformat() if last_event else None,
        "notifications_sent_today": int(sent_today or 0),
        "mail": "resend" if settings.resend_api_key else "лог (ключ не задан)",
    }


@router.get("/audit")
def audit(
    limit: int = Query(100, ge=1, le=500),
    user: User = Depends(ADMIN),
    db: Session = Depends(auth.get_db),
) -> list[dict[str, Any]]:
    rows = db.execute(
        select(AdminAudit, User.email)
        .join(User, User.id == AdminAudit.actor_id)
        .order_by(AdminAudit.id.desc())
        .limit(limit)
    ).all()
    return [
        {
            "id": a.id,
            "actor": email,
            "action": a.action,
            "target": a.target,
            "payload": a.payload,
            "at": a.created_at.isoformat() if a.created_at else None,
        }
        for a, email in rows
    ]


# --- биллинг: промокоды и ручная выдача подписки (план 3.13) ------------------------------------


class PromoIn(BaseModel):
    code: str = Field(min_length=3, max_length=32, pattern="^[A-Za-z0-9_-]+$")
    percent: int = Field(0, ge=0, le=100)
    fixed_usd: Decimal = Field(Decimal(0), ge=0)
    plan: str | None = Field(default=None, pattern="^(pro|premium)$")
    max_uses: int | None = Field(default=None, ge=1)
    expires_at: datetime | None = None


def _promo_out(p: PromoCode) -> dict[str, Any]:
    return {
        "id": p.id,
        "code": p.code,
        "percent": p.percent,
        "fixed_usd": str(p.fixed_usd),
        "plan": p.plan,
        "max_uses": p.max_uses,
        "used": p.used,
        "expires_at": p.expires_at.isoformat() if p.expires_at else None,
        "active": p.active,
        "created_at": p.created_at.isoformat() if p.created_at else None,
    }


@router.get("/promo")
def promo_list(
    user: User = Depends(ADMIN), db: Session = Depends(auth.get_db)
) -> list[dict[str, Any]]:
    return [
        _promo_out(p) for p in db.scalars(select(PromoCode).order_by(PromoCode.id.desc())).all()
    ]


@router.post("/promo", status_code=201)
def promo_create(
    body: PromoIn, user: User = Depends(ADMIN), db: Session = Depends(auth.get_db)
) -> dict[str, Any]:
    code = body.code.upper()
    if db.scalar(select(PromoCode).where(PromoCode.code == code)):
        raise HTTPException(409, "такой промокод уже есть")
    if body.percent == 0 and body.fixed_usd == 0:
        raise HTTPException(400, "укажите процент или сумму скидки")
    p = PromoCode(
        code=code,
        percent=body.percent,
        fixed_usd=body.fixed_usd,
        plan=body.plan,
        max_uses=body.max_uses,
        expires_at=body.expires_at,
    )
    db.add(p)
    _audit(db, user, "promo.create", f"promo:{code}", body.model_dump(mode="json"))
    db.commit()
    return _promo_out(p)


@router.patch("/promo/{promo_id}")
def promo_toggle(
    promo_id: int, active: bool, user: User = Depends(ADMIN), db: Session = Depends(auth.get_db)
) -> dict[str, Any]:
    p = db.get(PromoCode, promo_id)
    if p is None:
        raise HTTPException(404)
    p.active = active
    _audit(db, user, "promo.toggle", f"promo:{p.code}", {"active": active})
    db.commit()
    return _promo_out(p)


class GrantIn(BaseModel):
    plan: str = Field(pattern="^(pro|premium)$")
    months: int = Field(ge=1, le=12)
    reason: str = Field(min_length=5, max_length=255)


@router.post("/users/{user_id}/subscription", status_code=201)
def grant_subscription(
    user_id: int, body: GrantIn, user: User = Depends(ADMIN), db: Session = Depends(auth.get_db)
) -> dict[str, Any]:
    """Ручная выдача/продление тарифа (бета-тестеры, компенсации). Платёж с provider=manual."""
    u = db.get(User, user_id)
    if u is None:
        raise HTTPException(404)
    now = datetime.now(tz=UTC)
    q = billing.Quote(body.plan, body.months, Decimal(0), Decimal(0), Decimal(0), Decimal(0), None)
    p = billing.create_payment(db, u, q, "manual", now)
    p.raw = {"reason": body.reason, "by": user.email}
    sub = billing.activate(db, p, now)
    _audit(
        db,
        user,
        "subscription.grant",
        f"user:{u.id}",
        {"plan": body.plan, "months": body.months, "reason": body.reason},
    )
    db.commit()
    return {"plan": sub.plan, "current_period_end": sub.current_period_end.isoformat()}


# --- поддержка: тикеты (план 3.16) ---------------------------------------------------------------


@router.get("/tickets")
def tickets(
    status: str | None = Query(None, pattern="^(open|answered|closed)$"),
    user: User = Depends(ADMIN),
    db: Session = Depends(auth.get_db),
) -> list[dict[str, Any]]:
    stmt = select(SupportTicket).order_by(SupportTicket.id.desc()).limit(200)
    if status:
        stmt = stmt.where(SupportTicket.status == status)
    return [ticket_dict(t) for t in db.scalars(stmt).all()]


class ReplyIn(BaseModel):
    reply: str = Field(min_length=2, max_length=5000)
    close: bool = True


@router.post("/tickets/{ticket_id}/reply")
def ticket_reply(
    ticket_id: int, body: ReplyIn, user: User = Depends(ADMIN), db: Session = Depends(auth.get_db)
) -> dict[str, Any]:
    t = db.get(SupportTicket, ticket_id)
    if t is None:
        raise HTTPException(404)
    reply_ticket(db, t, user, body.reply, body.close)
    _audit(db, user, "ticket.reply", f"ticket:{t.id}", {"close": body.close})
    db.commit()
    return ticket_dict(t)


@router.patch("/tickets/{ticket_id}")
def ticket_status(
    ticket_id: int,
    status: str = Query(pattern="^(open|answered|closed)$"),
    user: User = Depends(ADMIN),
    db: Session = Depends(auth.get_db),
) -> dict[str, Any]:
    t = db.get(SupportTicket, ticket_id)
    if t is None:
        raise HTTPException(404)
    t.status = status
    _audit(db, user, "ticket.status", f"ticket:{t.id}", {"status": status})
    db.commit()
    return ticket_dict(t)
