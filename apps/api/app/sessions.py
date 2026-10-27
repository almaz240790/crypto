"""Сессии и устройства (план 3.12, v2): активные refresh-токены пользователя.

Токен ротируется при каждом обновлении, поэтому «сессия» — это актуальная строка refresh_tokens.
Текущую сессию по cookie здесь не видно (cookie ограничена путём /v1/auth): после отзыва
собственной сессии пользователь выйдет при следующем обновлении токена.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any, cast

from sqlalchemy import select, update
from sqlalchemy.engine import CursorResult
from sqlalchemy.orm import Session

from app import auth
from app.models import RefreshToken

_BROWSERS = (
    ("Edg/", "Edge"),
    ("OPR/", "Opera"),
    ("Firefox/", "Firefox"),
    ("Chrome/", "Chrome"),
    ("Safari/", "Safari"),
)
_OS = (
    ("iPhone", "iPhone"),
    ("iPad", "iPad"),
    ("Android", "Android"),
    ("Mac OS X", "macOS"),
    ("Windows", "Windows"),
    ("Linux", "Linux"),
)


def device_label(user_agent: str | None) -> str:
    """Короткая подпись устройства по User-Agent: «Chrome · macOS»; неизвестно — «устройство»."""
    ua = user_agent or ""
    browser = next((name for key, name in _BROWSERS if key in ua), None)
    os_name = next((name for key, name in _OS if key in ua), None)
    if re.search(r"curl|python|httpx|okhttp", ua, re.I):
        browser = "скрипт"
    parts = [p for p in (browser, os_name) if p]
    return " · ".join(parts) if parts else "устройство"


def session_dict(row: RefreshToken) -> dict[str, Any]:
    return {
        "id": row.id,
        "device": device_label(row.user_agent),
        "user_agent": row.user_agent,
        "created_at": (row.expires_at - auth.REFRESH_TTL).isoformat(),
        "expires_at": row.expires_at.isoformat(),
    }


def active_sessions(db: Session, user_id: int, now: datetime | None = None) -> list[RefreshToken]:
    now = now or datetime.now(tz=UTC)
    return list(
        db.scalars(
            select(RefreshToken)
            .where(
                RefreshToken.user_id == user_id,
                RefreshToken.revoked_at.is_(None),
                RefreshToken.expires_at > now,
            )
            .order_by(RefreshToken.expires_at.desc())
        ).all()
    )


def revoke(db: Session, user_id: int, session_id: int | None, now: datetime | None = None) -> int:
    """Отзыв одной сессии (session_id) или всех активных (None). Возвращает число отозванных."""
    now = now or datetime.now(tz=UTC)
    stmt = (
        update(RefreshToken)
        .where(RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=now)
    )
    if session_id is not None:
        stmt = stmt.where(RefreshToken.id == session_id)
    n = cast(CursorResult[Any], db.execute(stmt)).rowcount
    db.commit()
    return int(n or 0)
