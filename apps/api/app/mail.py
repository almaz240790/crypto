"""Отправка писем: Resend, если задан ключ; иначе — в лог (план 6.6)."""

from __future__ import annotations

import logging

import httpx

from app.config import settings

log = logging.getLogger("mail")


def send_mail(to: str, subject: str, text: str) -> None:
    if not settings.resend_api_key:
        log.info("письмо (не отправлено, нет ключа) → %s | %s\n%s", to, subject, text)
        return
    resp = httpx.post(
        "https://api.resend.com/emails",
        headers={"Authorization": f"Bearer {settings.resend_api_key}"},
        json={"from": settings.mail_from, "to": [to], "subject": subject, "text": text},
        timeout=15,
    )
    if resp.status_code >= 300:
        log.error("Resend %s: %s", resp.status_code, resp.text[:200])
