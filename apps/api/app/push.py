"""Web Push (план 3.11, задача 2.15): отправка через VAPID. Без ключей — тихо пропускаем.
Мёртвые подписки (404/410 или 5 ошибок подряд) удаляются."""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.models import PushSubscription

log = logging.getLogger("push")
MAX_FAILURES = 5


def enabled() -> bool:
    return bool(settings.vapid_private_key and settings.vapid_public_key)


def _send(sub: PushSubscription, payload: dict[str, Any]) -> int:
    """Код ответа push-сервиса; 0 — ключей нет (отправка пропущена)."""
    if not enabled():
        return 0
    from pywebpush import WebPushException, webpush

    try:
        resp = webpush(
            subscription_info={
                "endpoint": sub.endpoint,
                "keys": {"p256dh": sub.p256dh, "auth": sub.auth_key},
            },
            data=json.dumps(payload, ensure_ascii=False),
            vapid_private_key=settings.vapid_private_key,
            vapid_claims={"sub": settings.vapid_subject},
            ttl=3600,
        )
        return int(resp.status_code)
    except WebPushException as exc:
        code = getattr(exc.response, "status_code", None)
        return int(code) if code else 500


def send_to_user(db: Session, user_id: int, payload: dict[str, Any]) -> int:
    """Отправить всем подпискам пользователя; вернуть число успешных."""
    subs = db.scalars(select(PushSubscription).where(PushSubscription.user_id == user_id)).all()
    ok = 0
    now = datetime.now(tz=UTC)
    for sub in subs:
        code = _send(sub, payload)
        if code == 0:
            continue
        if 200 <= code < 300:
            sub.last_ok_at = now
            sub.failures = 0
            ok += 1
        elif code in (404, 410):
            db.delete(sub)
        else:
            sub.failures += 1
            if sub.failures >= MAX_FAILURES:
                db.delete(sub)
            log.warning("push %s: код %s (ошибок подряд %d)", sub.id, code, sub.failures)
    return ok
