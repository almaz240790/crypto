"""/v1/billing — тарифы, оформление, вебхук провайдера, статус и история (план 3.13)."""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import auth, billing
from app.config import settings
from app.models import Payment, User
from app.payments import nowpayments
from app.plans import catalog

log = logging.getLogger("billing")
router = APIRouter(prefix="/v1/billing", tags=["billing"])


@router.get("/plans")
def plans() -> dict[str, Any]:
    return {"plans": catalog(), "billing_enabled": settings.billing_enabled}


@router.get("/me")
def me(
    user: User = Depends(auth.current_user), db: Session = Depends(auth.get_db)
) -> dict[str, Any]:
    return billing.billing_status(db, user)


@router.get("/payments")
def payments(
    user: User = Depends(auth.current_user), db: Session = Depends(auth.get_db)
) -> list[dict[str, Any]]:
    rows = db.scalars(
        select(Payment).where(Payment.user_id == user.id).order_by(Payment.id.desc()).limit(100)
    ).all()
    return [billing.payment_out(p) for p in rows]


class QuoteIn(BaseModel):
    plan: str = Field(pattern="^(pro|premium)$")
    months: int = Field(ge=1, le=12)
    promo_code: str | None = Field(default=None, max_length=32)


@router.post("/quote")
def quote(
    body: QuoteIn, user: User = Depends(auth.current_user), db: Session = Depends(auth.get_db)
) -> dict[str, Any]:
    now = datetime.now(tz=UTC)
    try:
        promo = billing.find_promo(db, body.promo_code, now)
        q = billing.quote(body.plan, body.months, promo, billing.balance_of(db, user.id))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {
        k: str(v) if not isinstance(v, (str, int, type(None))) else v for k, v in q.__dict__.items()
    }


@router.post("/checkout", status_code=201)
def checkout(
    body: QuoteIn, user: User = Depends(auth.current_user), db: Session = Depends(auth.get_db)
) -> dict[str, Any]:
    if not settings.billing_enabled:
        raise HTTPException(503, "оплата ещё не включена")
    if user.blocked_at is not None:
        raise HTTPException(403, "аккаунт заблокирован")
    now = datetime.now(tz=UTC)
    try:
        promo = billing.find_promo(db, body.promo_code, now)
        q = billing.quote(body.plan, body.months, promo, billing.balance_of(db, user.id))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if q.amount_due <= 0:
        p = billing.create_payment(db, user, q, "balance", now)
        billing.activate(db, p, now)
        db.commit()
        return {"payment": billing.payment_out(p), "paid_from_balance": True}
    p = billing.create_payment(db, user, q, "nowpayments", now)
    try:
        inv = nowpayments.create_invoice(
            p.public_id,
            q.amount_due,
            f"Platform {q.plan} × {q.months} мес.",
            f"{settings.frontend_url}/billing?paid={p.public_id}",
            f"{settings.frontend_url}/pricing",
        )
    except Exception as exc:
        db.rollback()
        log.exception("создание инвойса")
        raise HTTPException(502, "платёжный провайдер недоступен, попробуйте позже") from exc
    p.provider_invoice_id = inv.invoice_id
    p.invoice_url = inv.url
    db.commit()
    return {"payment": billing.payment_out(p), "paid_from_balance": False}


@router.post("/webhook/nowpayments")
async def webhook_nowpayments(
    request: Request, db: Session = Depends(auth.get_db)
) -> dict[str, str]:
    raw = await request.body()
    try:
        body = json.loads(raw)
    except ValueError as exc:
        raise HTTPException(400, "bad json") from exc
    sig = request.headers.get("x-nowpayments-sig")
    if not nowpayments.verify_signature(body, sig, settings.nowpayments_ipn_secret):
        log.warning("IPN с неверной подписью")
        raise HTTPException(401, "bad signature")
    upd = nowpayments.parse_ipn(body)
    p = db.scalar(select(Payment).where(Payment.public_id == upd["order_id"]).with_for_update())
    if p is None:
        log.warning("IPN для неизвестного заказа %s", upd["order_id"])
        return {"status": "ignored"}
    status = billing.apply_provider_update(db, p, upd)
    db.commit()
    return {"status": status}


@router.post("/payments/{public_id}/refresh")
def refresh_payment(
    public_id: str, user: User = Depends(auth.current_user), db: Session = Depends(auth.get_db)
) -> dict[str, Any]:
    """Повторная сверка статуса у провайдера (кнопка «Проверить оплату»)."""
    p = db.scalar(select(Payment).where(Payment.public_id == public_id, Payment.user_id == user.id))
    if p is None:
        raise HTTPException(404)
    if p.provider == "nowpayments" and p.provider_payment_id and p.status != "paid":
        try:
            data = nowpayments.fetch_payment(p.provider_payment_id)
        except Exception as exc:
            raise HTTPException(502, "провайдер недоступен") from exc
        billing.apply_provider_update(
            db, p, nowpayments.parse_ipn({**data, "order_id": p.public_id})
        )
        db.commit()
    return billing.payment_out(p)
