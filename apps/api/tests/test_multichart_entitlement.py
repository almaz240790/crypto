"""Мультичарт по тарифу (план, раздел 4, строка «График: таймфреймы»: Premium — «Все + мультичарт
(v2)»; ADR-0009, дополнение 2026-11-13).

Было: /multichart открыт всем, права в тарифах нет. Стало: право ``multichart`` — Premium (админы и
владелец — всегда, как остальные права Premium); сайт узнаёт его из ``GET /v1/billing/me``. Пока
оплата выключена (``BILLING_ENABLED=false``), ничего не меняется: мультичарт открыт всем, включая
гостей, — замок работает только после включения оплаты.

Тесты на БД (нужен DATABASE_URL с миграциями до head; без БД пропускаются) идут во внешней
транзакции и откатываются в конце.
"""

from __future__ import annotations

import secrets
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, OperationalError
from sqlalchemy.orm import Session

from app import auth, ratelimit
from app.config import settings
from app.db import engine
from app.entitlements import ENTITLEMENTS, entitlements_for, restrictions_dict
from app.models import Subscription, User


def _db_available() -> bool:
    try:
        with engine.connect() as conn:
            conn.execute(text("select 1 from subscriptions limit 0"))
        return True
    except (OperationalError, DBAPIError):
        return False


needs_db = pytest.mark.skipif(not _db_available(), reason="БД с миграциями до head недоступна")


def test_multichart_only_premium_in_plan_table() -> None:
    """Таблица тарифов: Free и Pro — нет, Premium — да; поле есть в ограничениях тарифа."""
    assert [ENTITLEMENTS[p].multichart for p in ("free", "pro", "premium")] == [False, False, True]
    assert restrictions_dict(ENTITLEMENTS["premium"])["multichart"] is True
    assert restrictions_dict(ENTITLEMENTS["pro"])["multichart"] is False


@pytest.fixture
def db() -> Iterator[Session]:
    conn = engine.connect()
    outer = conn.begin()
    s = Session(bind=conn, join_transaction_mode="create_savepoint", expire_on_commit=False)
    try:
        yield s
    finally:
        s.close()
        outer.rollback()
        conn.close()


@pytest.fixture
def client(db: Session, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    """Всё приложение на транзакции теста; лимиты — в памяти процесса (без Redis)."""
    from app.main import app

    monkeypatch.setattr(settings, "redis_url", "")
    ratelimit._memory.values.clear()
    app.dependency_overrides[auth.get_db] = lambda: db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(auth.get_db, None)
        ratelimit._memory.values.clear()


def _user(db: Session, plan: str | None = None, role: str = "user") -> User:
    u = User(
        email=f"multichart-{secrets.token_hex(4)}@example.test",
        role=role,
        email_verified_at=datetime(2026, 10, 1, tzinfo=UTC),
    )
    db.add(u)
    db.flush()
    if plan is not None:
        end = datetime.now(tz=UTC) + timedelta(days=30)
        db.add(Subscription(user_id=u.id, plan=plan, status="active", current_period_end=end))
        db.flush()
    return u


def _me(client: TestClient, user: User) -> dict[str, object]:
    r = client.get(
        "/v1/billing/me", headers={"authorization": f"Bearer {auth.make_access_token(user)}"}
    )
    assert r.status_code == 200, r.text
    body: dict[str, object] = r.json()
    return body


@needs_db
def test_billing_on_multichart_only_premium_and_staff(
    db: Session, client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "billing_enabled", True)
    cases = {
        "без подписки (Free)": (_user(db), "free", False),
        "Pro": (_user(db, "pro"), "pro", False),
        "Premium": (_user(db, "premium"), "premium", True),
        # админы и владелец получают права Premium без подписки (entitlements_for)
        "админ": (_user(db, role="admin"), "free", True),
        "владелец": (_user(db, role="owner"), "free", True),
    }
    for name, (user, plan, allowed) in cases.items():
        me = _me(client, user)
        assert (me["plan"], me["multichart"]) == (plan, allowed), name
        assert entitlements_for(db, user).multichart is allowed, name
    assert entitlements_for(db, None).multichart is False  # гость — как Free


@needs_db
def test_billing_off_nothing_changes_multichart_open_to_all(
    db: Session, client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Оплата выключена: мультичарт у всех, как до решения; остальные права — прежние (Pro у
    вошедших, Free у гостя)."""
    monkeypatch.setattr(settings, "billing_enabled", False)
    for user in (_user(db), _user(db, "pro"), _user(db, "premium"), _user(db, role="owner")):
        me = _me(client, user)
        assert me["multichart"] is True and me["billing_enabled"] is False
    ent = entitlements_for(db, _user(db))
    assert ent.plan == "pro" and ent.multichart
    assert restrictions_dict(ent) == {**restrictions_dict(ENTITLEMENTS["pro"]), "multichart": True}
    guest = entitlements_for(db, None)
    assert guest.multichart and not guest.intraday and guest.plan == "free"
    assert client.get("/v1/billing/plans").json()["billing_enabled"] is False
