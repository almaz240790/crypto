"""Поддержка (план 3.16): письмо владельцу содержит контекст, ответ меняет статус."""

from __future__ import annotations

from app.models import SupportTicket
from app.support import owner_notice, ticket_dict


def test_owner_notice_contains_context() -> None:
    t = SupportTicket(
        id=5,
        email="u@example.com",
        subject="Не вижу сигнал",
        message="Открыл карточку, пусто",
        context={"page": "/signals/abc", "plan": "pro", "version": "0.1.0"},
        status="open",
    )
    subject, body = owner_notice(t)
    assert "#5" in subject and "Не вижу сигнал" in subject
    assert "/signals/abc" in body and "pro" in body and "0.1.0" in body and "u@example.com" in body
    d = ticket_dict(t)
    assert d["status"] == "open" and d["context"]["plan"] == "pro" and d["reply"] is None
