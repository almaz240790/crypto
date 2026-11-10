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


PERMANENT_CODES = frozenset({400, 422})
"""Ответы Resend, после которых повтор того же письма не поможет: неверный адрес или поля
письма. Остальные ошибки (401/403 — ключ или домен, 429 — лимит, 5xx — сбой) проходят сами
или после исправления настроек: письмо стоит отправить позже."""


class MailError(RuntimeError):
    """Письмо не принято провайдером (только в строгом режиме ``send_mail``).

    ``permanent`` — повтор не поможет (``PERMANENT_CODES``); иначе отправку стоит повторить.
    """

    def __init__(self, status_code: int) -> None:
        super().__init__(f"Resend {status_code}")
        self.status_code = status_code
        self.permanent = status_code in PERMANENT_CODES


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
    после сбоя между отправкой и фиксацией в БД не даёт второго письма. Ответ 409 на запрос с
    ключом значит, что письмо с этим ключом уже отправлено (или отправляется), — это успех.
    ``strict`` — любой другой отказ провайдера поднимает ``MailError``: вызывающий не отмечает
    письмо отправленным и решает, повторять ли (``MailError.permanent``). Без ``strict`` отказ,
    как и раньше, только пишется в лог.
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
    if resp.status_code < 300:
        return
    if resp.status_code == 409 and idempotency_key:
        log.info("Resend 409 по ключу %s: письмо уже отправлено", idempotency_key)
        return
    log.error("Resend %s: %s", resp.status_code, resp.text[:200])
    if strict:
        raise MailError(resp.status_code)
