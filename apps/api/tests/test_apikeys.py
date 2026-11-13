"""API-ключи для чтения (план 3.10): формат, хэш, поиск и отзыв (на БД — в CI), список
эндпоинтов, открытых ключу."""

from __future__ import annotations

import os
import re
from pathlib import Path

import pytest
from sqlalchemy import text

from app import apikeys, auth

# список эндпоинтов страницы /api-docs (apps/web/src/app/api-docs/page.tsx берёт его отсюда)
API_DOCS = Path(__file__).resolve().parents[3] / "apps" / "web" / "src" / "lib" / "apiDocs.ts"


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


def test_key_scope_is_the_api_docs_list() -> None:
    """Ключ открывает ровно эндпоинты со страницы /api-docs (ADR-0017): документация и сервер не
    расходятся. Новый эндпоинт по ключу закрыт, пока его не внесут в оба списка; каждый пункт
    списка — действующий GET-эндпоинт приложения (опечатка не пройдёт)."""
    from app.main import app

    docs = re.findall(r'\bpath: "([^"]+)"', API_DOCS.read_text(encoding="utf-8"))
    assert len(docs) == len(set(docs)) >= 20
    assert set(docs) == apikeys.KEY_ENDPOINTS
    paths = app.openapi()["paths"]
    for path in sorted(apikeys.KEY_ENDPOINTS):
        assert "get" in paths.get(path, {}), path
