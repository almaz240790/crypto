"""Web Push (план 3.11, задача 2.15): отправка через VAPID. Без ключей — тихо пропускаем.
Мёртвые подписки (404/410 или 5 ошибок подряд) удаляются.

Адрес подписки (``endpoint``) присылает браузер, и сервер не может проверить, что его не
подменили. Поэтому принимаются и получают push только адреса https на push-сервисах браузеров
(``PUSH_HOSTS``), а запрос к push-сервису ограничен ``PUSH_TIMEOUT``. Иначе любой пользователь мог
бы указать свой сервер, который принимает соединение и молчит: уведомитель ждал бы его без конца,
а push и письма алертов остальных пользователей стояли бы в очереди за ним. Или указать
внутренний адрес сети хостинга, куда API и уведомитель стали бы слать запросы.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.models import PushSubscription

log = logging.getLogger("push")
MAX_FAILURES = 5
PUSH_TIMEOUT = 10.0
"""Таймаут запроса к push-сервису, с: на соединение и на ожидание ответа. Без него (у pywebpush
по умолчанию таймаута нет) запрос к адресу, который принял соединение и молчит, висел бы вечно."""
PUSH_HOSTS = (
    "fcm.googleapis.com",  # Chrome и другие браузеры на Chromium
    "android.googleapis.com",  # старые подписки Chrome (GCM)
    "push.services.mozilla.com",  # Firefox: updates.push.services.mozilla.com
    "notify.windows.com",  # Edge: wns2-….notify.windows.com
    "push.apple.com",  # Safari: web.push.apple.com
)
"""Push-сервисы браузеров: адрес подписки — https на одном из этих хостов или его поддомене."""
_skipped_hosts: set[str] = set()


def enabled() -> bool:
    return bool(settings.vapid_private_key and settings.vapid_public_key)


def endpoint_allowed(endpoint: str) -> bool:
    """Адрес подписки — https на push-сервисе браузера (``PUSH_HOSTS``), без логина в адресе и
    без нестандартного порта. IP-адреса, localhost и прочие хосты не проходят."""
    try:
        url = urlsplit(endpoint)
        port = url.port
    except ValueError:
        return False
    if url.scheme != "https" or url.username is not None or port not in (None, 443):
        return False
    host = (url.hostname or "").lower().rstrip(".")
    return any(host == h or host.endswith("." + h) for h in PUSH_HOSTS)


def _send(sub: PushSubscription, payload: dict[str, Any]) -> int:
    """Код ответа push-сервиса; 0 — отправка пропущена (нет ключей или адрес не на push-сервисе)."""
    if not enabled():
        return 0
    if not endpoint_allowed(sub.endpoint):
        # подписка записана до проверки адреса: запрос туда не шлём, но и не удаляем — если
        # это настоящий push-сервис, которого нет в списке, его достаточно добавить в PUSH_HOSTS
        host = urlsplit(sub.endpoint).hostname or "?"
        if host not in _skipped_hosts:
            _skipped_hosts.add(host)
            log.warning("push: адрес подписки не на push-сервисе (%s) — пропуск", host)
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
            timeout=PUSH_TIMEOUT,
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
