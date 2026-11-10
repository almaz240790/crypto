"""Отправка писем: Resend, если задан ключ; иначе — в лог (план 6.6)."""

from __future__ import annotations

import logging

import httpx

from app.config import settings

log = logging.getLogger("mail")
RESEND_URL = "https://api.resend.com/emails"


def configured() -> bool:
    """Задан ли ключ Resend. Без него письма только пишутся в лог."""
    return bool(settings.resend_api_key)


class MailError(RuntimeError):
    """Временный отказ провайдера (429 или 5xx): письмо не отправлено, отправку стоит повторить."""


def send_mail(
    to: str,
    subject: str,
    text: str,
    idempotency_key: str | None = None,
    *,
    strict: bool = False,
) -> None:
    """Отправить письмо. Ошибка HTTP пишется в лог; сетевая ошибка — исключение.

    ``idempotency_key`` — ключ идемпотентности Resend (действует сутки): повтор того же письма
    после сбоя между отправкой и фиксацией в БД не даёт второго письма. ``strict`` — временный
    отказ провайдера (429, 5xx) поднимает ``MailError``, чтобы вызывающий повторил отправку
    (доставка алертов); иначе он, как и прочие ошибки HTTP, только пишется в лог.
    """
    if not configured():
        log.info("письмо (не отправлено, нет ключа) → %s | %s\n%s", to, subject, text)
        return
    headers = {"Authorization": f"Bearer {settings.resend_api_key}"}
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    resp = httpx.post(
        RESEND_URL,
        headers=headers,
        json={"from": settings.mail_from, "to": [to], "subject": subject, "text": text},
        timeout=15,
    )
    if resp.status_code >= 300:
        log.error("Resend %s: %s", resp.status_code, resp.text[:200])
        if strict and (resp.status_code == 429 or resp.status_code >= 500):
            raise MailError(f"Resend {resp.status_code}")
