"""API-ключи для чтения (план 3.10): формат, хэш, поиск и отзыв (на БД — в CI)."""

from __future__ import annotations

import os

import pytest
from sqlalchemy import text

from app import apikeys, auth


def _db_available() -> bool:
    try:
        from app.db import engine

        with engine.connect() as c:
            c.execute(text("select 1 from api_keys limit 1"))
        return True
    except Exception:
        return False


db_only = pytest.mark.skipif(not _db_available(), reason="БД с миграциями недоступна")


def test_new_key_format_and_hash() -> None:
    raw, prefix, h = apikeys.new_key()
    assert raw.startswith("pk_") and len(raw) >= 40 and prefix == raw[:10]
    assert h == auth.sha256(raw) and len(h) == 64
    assert apikeys.looks_like_key(raw) and not apikeys.looks_like_key("Bearer x")
    assert apikeys.new_key()[0] != raw


@db_only
def test_find_user_and_revoke() -> None:
    from datetime import UTC, datetime

    from app.db import SessionLocal
    from app.models import ApiKey, User

    with SessionLocal() as s:
        s.begin()
        try:
            u = User(email=f"apikey-{os.getpid()}@example.com", password_hash=None)
            s.add(u)
            s.flush()
            raw, prefix, h = apikeys.new_key()
            k = ApiKey(user_id=u.id, name="t", prefix=prefix, key_hash=h)
            s.add(k)
            s.flush()
            found = apikeys.find_user(s, raw)
            assert found is not None and found.id == u.id and k.last_used_at is not None
            assert apikeys.find_user(s, "pk_" + "x" * 40) is None
            k.revoked_at = datetime.now(tz=UTC)
            s.flush()
            assert apikeys.find_user(s, raw) is None
        finally:
            s.rollback()
