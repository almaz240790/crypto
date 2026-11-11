"""Отправка писем: Resend, если задан ключ; иначе — в лог (план 6.6)."""

from __future__ import annotations

import json
import logging
import re

import httpx

from app.config import settings

log = logging.getLogger("mail")
RESEND_URL = "https://api.resend.com/emails"


def configured() -> bool:
    """Задан ли ключ Resend. Без него письма только пишутся в лог."""
    return bool(settings.resend_api_key)


PERMANENT_CODES = frozenset({400, 422})
"""Коды, при которых отказ *может* касаться только этого письма (поля запроса)."""
RECIPIENT_FIELD = re.compile(r"[`'\"]to[`'\"]|\bto\s+field\b|\brecipient", re.IGNORECASE)
"""Сообщение Resend об ошибке в адресе получателя («Invalid `to` field…»)."""


def recipient_rejected(status_code: int, message: str) -> bool:
    """Постоянный отказ по адресу получателя: повтор того же письма не поможет, а другим
    адресатам этот отказ не мешает.

    По одному коду этого не понять: 400 ``validation_error`` Resend отдаёт и при неверном ключе,
    и при неверном ``from`` (MAIL_FROM), 422 — при пропущенном поле. Такие отказы касаются всех
    писем процесса, а не адреса: их надо повторять после исправления настроек. Поэтому
    постоянный — только 400/422, в сообщении которого речь о поле ``to``.
    """
    return status_code in PERMANENT_CODES and bool(RECIPIENT_FIELD.search(message))


def _error_of(resp: httpx.Response) -> tuple[str, str]:
    """(``name``, ``message``) из тела ошибки Resend; тело не JSON — ("", начало текста)."""
    text = resp.text or ""
    try:
        data = json.loads(text)
    except ValueError:
        return "", text[:200]
    if not isinstance(data, dict):
        return "", text[:200]
    return str(data.get("name") or ""), str(data.get("message") or data.get("error") or "")


class MailError(RuntimeError):
    """Письмо не принято провайдером (только в строгом режиме ``send_mail``).

    ``permanent`` — отказ по адресу получателя (``recipient_rejected``): повтор не поможет.
    Иначе (ключ, домен, отправитель, лимит, сбой провайдера) отказ касается всех писем процесса —
    отправку стоит повторить позже (``provider_wide``).
    """

    def __init__(self, status_code: int, name: str = "", message: str = "") -> None:
        super().__init__(f"Resend {status_code}" + (f" {name}" if name else ""))
        self.status_code = status_code
        self.name = name
        self.message = message
        self.permanent = recipient_rejected(status_code, message)


def provider_wide(exc: BaseException) -> bool:
    """Сбой почты не из-за конкретного письма: отказ провайдера, кроме неверного адреса
    получателя, или сеть (таймаут, нет соединения). После исправления настроек или восстановления
    сети то же письмо уйдёт — повторять его можно, пока оно не устарело."""
    if isinstance(exc, MailError):
        return not exc.permanent
    return isinstance(exc, httpx.TransportError)


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
    письмо отправленным и решает, повторять ли (``MailError.permanent``, ``provider_wide``). Без
    ``strict`` отказ, как и раньше, только пишется в лог.
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
        raise MailError(resp.status_code, *_error_of(resp))
