"""/v1/support — форма обращений (план 3.16). Без входа — с email; с входом — от аккаунта."""

from __future__ import annotations

import logging
import time
from typing import Any

import redis
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.orm import Session

from app import auth
from app.billing import plan_for
from app.config import settings
from app.models import User
from app.routers.public import optional_user
from app.support import MAX_PER_HOUR, create_ticket, ticket_dict

log = logging.getLogger("support")
router = APIRouter(prefix="/v1/support", tags=["support"])


class TicketIn(BaseModel):
    email: EmailStr | None = None
    subject: str = Field(min_length=3, max_length=200)
    message: str = Field(min_length=10, max_length=5000)
    page: str | None = Field(default=None, max_length=300)
    version: str | None = Field(default=None, max_length=32)


def _rate_ok(key: str) -> bool:
    """Не больше MAX_PER_HOUR обращений в час с одного адреса/IP. Без Redis — пропускаем."""
    try:
        r = redis.from_url(settings.redis_url, socket_timeout=2)
        k = f"support:rate:{key}:{int(time.time() // 3600)}"
        n = int(r.incr(k))
        r.expire(k, 3600)
        return n <= MAX_PER_HOUR
    except Exception:
        return True


@router.post("/tickets", status_code=201)
def create(
    body: TicketIn,
    request: Request,
    user: User | None = Depends(optional_user),
    db: Session = Depends(auth.get_db),
) -> dict[str, Any]:
    if user is None and not body.email:
        raise HTTPException(400, "укажите email для ответа")
    ip = request.headers.get("x-forwarded-for", request.client.host if request.client else "?")
    who = user.email if user else str(body.email)
    if not _rate_ok(ip.split(",")[0].strip()) or not _rate_ok(who.lower()):
        raise HTTPException(429, "слишком много обращений, попробуйте через час")
    context = {
        "page": body.page,
        "version": body.version,
        "plan": plan_for(db, user) if user else None,
        "user_agent": (request.headers.get("user-agent") or "")[:200],
    }
    t = create_ticket(db, user, str(body.email or ""), body.subject, body.message, context)
    db.commit()
    return ticket_dict(t)


@router.get("/tickets")
def my_tickets(
    user: User = Depends(auth.current_user), db: Session = Depends(auth.get_db)
) -> list[dict[str, Any]]:
    from sqlalchemy import select

    from app.models import SupportTicket

    rows = db.scalars(
        select(SupportTicket)
        .where(SupportTicket.user_id == user.id)
        .order_by(SupportTicket.id.desc())
        .limit(50)
    ).all()
    return [ticket_dict(t) for t in rows]
