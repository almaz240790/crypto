"""Поддержка (план 3.16): тикет попадает в админку и на почту владельцам; ответ уходит письмом."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy.orm import Session

from app.config import settings
from app.mail import send_mail
from app.models import SupportTicket, User

MAX_PER_HOUR = 5


def ticket_dict(t: SupportTicket) -> dict[str, Any]:
    return {
        "id": t.id,
        "user_id": t.user_id,
        "email": t.email,
        "subject": t.subject,
        "message": t.message,
        "context": t.context or {},
        "status": t.status,
        "reply": t.reply,
        "replied_at": t.replied_at.isoformat() if t.replied_at else None,
        "created_at": t.created_at.isoformat() if t.created_at else None,
    }


def owner_notice(t: SupportTicket) -> tuple[str, str]:
    ctx = t.context or {}
    return (
        f"[Поддержка] #{t.id}: {t.subject}",
        f"От: {t.email}\nСтраница: {ctx.get('page', '—')} · тариф: {ctx.get('plan', '—')} · "
        f"версия: {ctx.get('version', '—')}\n\n{t.message}\n\n"
        f"Ответить: {settings.frontend_url}/admin?tab=tickets",
    )


def create_ticket(
    db: Session,
    user: User | None,
    email: str,
    subject: str,
    message: str,
    context: dict[str, Any],
) -> SupportTicket:
    t = SupportTicket(
        user_id=user.id if user else None,
        email=(user.email if user else email).lower(),
        subject=subject.strip(),
        message=message.strip(),
        context=context,
    )
    db.add(t)
    db.flush()
    subj, body = owner_notice(t)
    for to in sorted(settings.owner_email_set):
        send_mail(to, subj, body)
    send_mail(
        t.email,
        f"Обращение #{t.id} принято",
        f"Мы получили ваше обращение «{t.subject}». Ответим на этот адрес; обычно в течение суток.",
    )
    return t


def reply_ticket(db: Session, t: SupportTicket, admin: User, reply: str, close: bool) -> None:
    t.reply = reply.strip()
    t.replied_by = admin.id
    t.replied_at = datetime.now(tz=UTC)
    t.status = "closed" if close else "answered"
    send_mail(
        t.email,
        f"Ответ по обращению #{t.id}: {t.subject}",
        f"{t.reply}\n\n— Поддержка Platform\n\nВаше обращение:\n{t.message}",
    )
    db.flush()
