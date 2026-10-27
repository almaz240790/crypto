"""API-ключи для чтения (план 3.10: «API-ключ для чтения истории — Premium»).

Ключ ``pk_<43 символа>`` показывается один раз; в базе — sha256 и префикс для списка.
Доступ только к GET-эндпоинтам, лимит запросов на ключ — в ``auth.current_user``.
"""

from __future__ import annotations

import secrets
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import auth
from app.models import ApiKey, User

PREFIX = "pk_"
KEYS_LIMIT = 5
API_RATE = (600, 60)  # запросов в минуту на ключ


def new_key() -> tuple[str, str, str]:
    """(сырой ключ, префикс для списка, sha256 для хранения)."""
    raw = PREFIX + secrets.token_urlsafe(32)
    return raw, raw[:10], auth.sha256(raw)


def looks_like_key(value: str) -> bool:
    return value.startswith(PREFIX) and 30 <= len(value) <= 80


def find_user(db: Session, raw: str, now: datetime | None = None) -> User | None:
    """Пользователь по ключу; отозванный или неизвестный — None. Отмечает время использования."""
    if not looks_like_key(raw):
        return None
    row = db.scalar(select(ApiKey).where(ApiKey.key_hash == auth.sha256(raw)))
    if row is None or row.revoked_at is not None:
        return None
    user = db.get(User, row.user_id)
    if user is None or user.deleted_at is not None:
        return None
    row.last_used_at = now or datetime.now(tz=UTC)
    db.commit()
    return user
