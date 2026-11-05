"""Отдельный вход в админку (ADR-0011): токен со своей областью, сеанс 8 ч / 1 ч простоя, отзыв,
обязательный второй фактор, одинаковые ошибки, лимиты попыток, аудит без секретов.

Чистые части — без БД; сценарии через HTTP — на БД с миграциями (в CI; локально — пропуск)."""

from __future__ import annotations

import os
import re
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import pyotp
import pytest
import segno
from fastapi import HTTPException
from sqlalchemy import text

from app import admin_auth as aa
from app import auth, ratelimit, twofactor
from app.config import settings
from app.models import AdminSession, TwoFactor, User


@pytest.fixture(autouse=True)
def _memory_limits(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Счётчики попыток — в памяти и с чистого листа (без Redis)."""
    monkeypatch.setattr(settings, "redis_url", "")
    ratelimit._memory.values.clear()
    yield
    ratelimit._memory.values.clear()


# --- чистые части ---------------------------------------------------------------------------------


def test_admin_token_has_own_scope_audience_and_key() -> None:
    now = datetime.now(tz=UTC)
    token = aa.make_token(7, "a" * 32, now, now + aa.TTL)
    payload = aa.decode_token(token)
    assert payload["sub"] == "7" and payload["scope"] == "admin" and payload["sid"] == "a" * 32
    assert payload["aud"] == aa.AUDIENCE
    # токен сайта (даже владельца) не проходит проверку админки
    user_token = auth.make_access_token(User(id=7, email="o@example.com", role="owner"))
    with pytest.raises(HTTPException) as e:
        aa.decode_token(user_token)
    assert e.value.status_code == 401
    # и наоборот: токен админки не годится как токен сайта
    with pytest.raises(HTTPException):
        auth.decode_access_token(token)
    # просроченный токен
    old = aa.make_token(7, "b" * 32, now - timedelta(hours=9), now - timedelta(hours=1))
    with pytest.raises(HTTPException):
        aa.decode_token(old)
    # подпись ключом админки, но без scope=admin
    import jwt

    forged = jwt.encode(
        {"sub": "7", "sid": "c", "aud": aa.AUDIENCE, "iat": 1, "exp": 9999999999, "scope": "user"},
        aa._signing_key(),
        algorithm="HS256",
    )
    with pytest.raises(HTTPException):
        aa.decode_token(forged)
    # подпись секретом сайта с полями админки — тоже нет
    forged2 = jwt.encode(
        {"sub": "7", "sid": "c", "aud": aa.AUDIENCE, "iat": 1, "exp": 9999999999, "scope": "admin"},
        settings.jwt_secret,
        algorithm="HS256",
    )
    with pytest.raises(HTTPException):
        aa.decode_token(forged2)


def test_session_problem_absolute_idle_revoked() -> None:
    now = datetime(2026, 11, 5, 12, 0, tzinfo=UTC)
    row = AdminSession(
        id="s" * 32,
        user_id=1,
        method="password",
        created_at=now - timedelta(hours=2),
        last_seen_at=now - timedelta(minutes=10),
        expires_at=now - timedelta(hours=2) + aa.TTL,
    )
    assert aa.session_problem(row, 1, now) is None
    assert aa.session_problem(row, 2, now) == "unknown"
    assert aa.session_problem(None, 1, now) == "unknown"
    assert aa.session_problem(row, 1, now + timedelta(minutes=51)) == "idle"  # 1 ч без действий
    row.last_seen_at = now + timedelta(hours=5, minutes=59)
    assert aa.session_problem(row, 1, now + timedelta(hours=6)) == "expired"  # 8 ч с входа
    row.last_seen_at = now
    row.revoked_at = now
    assert aa.session_problem(row, 1, now) == "revoked"


def test_account_problem_roles() -> None:
    assert aa.account_problem(None) == "unknown_email"
    assert aa.account_problem(User(id=1, email="a@x.io", role="user")) == "not_admin"
    assert aa.account_problem(User(id=1, email="a@x.io", role="support")) == "not_admin"
    assert aa.account_problem(User(id=1, email="a@x.io", role="admin")) is None
    assert aa.account_problem(User(id=1, email="a@x.io", role="owner")) is None
    now = datetime.now(tz=UTC)
    assert aa.account_problem(User(id=1, email="a@x.io", role="owner", blocked_at=now)) == "blocked"
    assert aa.account_problem(User(id=1, email="a@x.io", role="admin", deleted_at=now)) == "deleted"


def test_mask_email() -> None:
    assert aa.mask_email("Owner@Example.com ") == "o***@example.com"
    assert aa.mask_email("x") == "***"


def test_qr_path_draws_exactly_the_segno_matrix() -> None:
    url = twofactor.otpauth_url(twofactor.new_secret(), "owner@example.com")
    size, path = aa.qr_svg_path(url)
    matrix = segno.make(url, error="m", micro=False).matrix
    assert size == len(matrix)
    drawn = [[0] * size for _ in range(size)]
    for x, y, w in re.findall(r"M(\d+) (\d+)h(\d+)v1h-\d+z", path):
        for i in range(int(w)):
            drawn[int(y)][int(x) + i] = 1
    assert drawn == [[1 if v else 0 for v in row] for row in matrix]
    assert "PlatformSol" in url  # подпись в «Пароли» / Google Authenticator


def test_totp_code_is_single_use_and_backup_codes_burn() -> None:
    secret = twofactor.new_secret()
    now = datetime.now(tz=UTC)
    code = pyotp.TOTP(secret).at(now)
    prev = pyotp.TOTP(secret).at(now - timedelta(seconds=30))
    assert aa.check_totp(secret, code, 1, now)
    assert not aa.check_totp(secret, code, 1, now)  # тот же код второй раз — нет
    assert aa.check_totp(secret, code, 2, now)  # у другого пользователя свой счёт
    assert prev == code or aa.check_totp(secret, prev, 1, now)  # окно ±30 с
    assert not aa.check_totp(secret, "12345", 1, now)
    plain, hashes = twofactor.make_backup_codes()
    row = TwoFactor(user_id=1, secret=secret, backup_codes=list(hashes), enabled_at=now)
    assert aa.check_second_factor(row, plain[3].lower(), 1, now) == "backup"
    assert len(row.backup_codes) == 9
    assert aa.check_second_factor(row, plain[3], 1, now) is None  # резервный код сгорел
    fresh = pyotp.TOTP(secret).at(now + timedelta(seconds=30))
    assert aa.check_second_factor(row, fresh, 1, now) == "totp"


def test_strict_limit_counts_in_memory_when_redis_fails() -> None:
    class Broken:
        def incr(self, key: str) -> int:
            raise ConnectionError("redis down")

        def expire(self, key: str, seconds: int) -> None:
            return None

    assert all(ratelimit.hit("k", 1, 60, Broken()) for _ in range(3))  # сайт: пропускаем
    assert ratelimit.hit("adm", 2, 60, Broken(), strict=True)
    assert ratelimit.hit("adm", 2, 60, Broken(), strict=True)
    assert not ratelimit.hit("adm", 2, 60, Broken(), strict=True)  # админка: считаем в памяти


def test_check_password_spends_the_same_work_without_user(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []
    real = auth.verify_password

    def spy(password: str, h: str | None) -> bool:
        calls.append(password)
        return real(password, h)

    monkeypatch.setattr(auth, "verify_password", spy)
    assert not aa.check_password(None, "pw-1")
    assert not aa.check_password(User(id=1, email="a@x.io", password_hash=None), "pw-2")
    assert aa.check_password(
        User(id=1, email="a@x.io", password_hash=auth.hash_password("pw-3")), "pw-3"
    )
    assert calls == ["pw-1", "pw-2", "pw-3"]  # хэш проверяется всегда — время ответа одно


# --- сценарии через HTTP (БД) ---------------------------------------------------------------------


def _db_available() -> bool:
    try:
        from app.db import engine

        with engine.connect() as c:
            c.execute(text("select 1 from admin_sessions limit 1"))
        return True
    except Exception:
        return False


db_only = pytest.mark.skipif(not _db_available(), reason="БД с миграциями недоступна")

PASSWORD = "correct horse battery 42"
UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1"
CSRF = {aa.CSRF_HEADER: aa.CSRF_VALUE}


class World:
    """Пользователи теста и очистка после него."""

    def __init__(self) -> None:
        from fastapi.testclient import TestClient

        from app.db import SessionLocal
        from app.main import app

        self.db = SessionLocal()
        self.app = app
        self.client_cls = TestClient
        self.ids: list[int] = []
        self.audit_from = int(self.db.scalar(text("select coalesce(max(id), 0) from admin_audit")))
        self.mails: list[tuple[str, str, str]] = []

    def client(self) -> Any:
        return self.client_cls(self.app, headers={"user-agent": UA})

    def user(
        self, role: str = "owner", password: str | None = PASSWORD, two_factor: bool = False
    ) -> tuple[User, list[str], str | None]:
        email = f"adm-{os.getpid()}-{uuid.uuid4().hex[:8]}@example.com"
        u = auth.create_user(self.db, email, password)
        u.role = role
        self.db.commit()
        self.ids.append(u.id)
        plain: list[str] = []
        secret = None
        if two_factor:
            secret = twofactor.new_secret()
            plain, hashes = twofactor.make_backup_codes()
            self.db.add(
                TwoFactor(
                    user_id=u.id,
                    secret=secret,
                    backup_codes=hashes,
                    enabled_at=datetime.now(tz=UTC),
                )
            )
            self.db.commit()
        return u, plain, secret

    def audit(self, user_id: int | None = None) -> list[tuple[str, dict[str, Any]]]:
        self.db.expire_all()
        q = "select action, payload from admin_audit where id > :a"
        if user_id is None:
            rows = self.db.execute(
                text(q + " and actor_id is null order by id"), {"a": self.audit_from}
            )
        else:
            rows = self.db.execute(
                text(q + " and actor_id = :u order by id"), {"a": self.audit_from, "u": user_id}
            )
        return [(r[0], r[1]) for r in rows]

    def close(self) -> None:
        self.db.rollback()
        ids = {"ids": self.ids or [-1]}
        for sql in (
            "delete from admin_audit where actor_id = any(:ids)",
            "delete from admin_sessions where user_id = any(:ids)",
            "delete from email_tokens where user_id = any(:ids)",
            "delete from two_factor_secrets where user_id = any(:ids)",
            "delete from refresh_tokens where user_id = any(:ids)",
            "delete from risk_profiles where user_id = any(:ids)",
            "delete from watchlists where user_id = any(:ids)",
            "delete from promo_codes where code like 'ADMT%'",
        ):
            self.db.execute(text(sql), ids)
        self.db.execute(
            text("delete from admin_audit where actor_id is null and id > :a"),
            {"a": self.audit_from},
        )
        self.db.execute(text("delete from users where id = any(:ids)"), ids)
        self.db.commit()
        self.db.close()


@pytest.fixture
def world(monkeypatch: pytest.MonkeyPatch) -> Iterator[World]:
    w = World()
    from app.routers import admin_auth as router_mod

    monkeypatch.setattr(router_mod, "send_mail", lambda *a: w.mails.append(a))
    monkeypatch.setattr(settings, "owner_emails", "")
    try:
        yield w
    finally:
        w.close()


def _code(secret: str, shift: int = 0) -> str:
    return pyotp.TOTP(secret).at(datetime.now(tz=UTC) + timedelta(seconds=30 * shift))


def _login(c: Any, email: str, password: str = PASSWORD) -> Any:
    return c.post("/v1/admin/auth/login", json={"email": email, "password": password})


def _admin_in(w: World, c: Any) -> tuple[User, str, list[str]]:
    """Админ с включённой 2FA, вошедший в админку через этот клиент (secret, резервные коды)."""
    u, backup, secret = w.user(two_factor=True)
    assert secret is not None
    step = _login(c, u.email).json()
    r = c.post("/v1/admin/auth/verify", json={"ticket": step["ticket"], "code": _code(secret)})
    assert r.status_code == 200, r.text
    return u, secret, backup


@db_only
def test_first_step_errors_are_identical(world: World) -> None:
    c = world.client()
    user, _, _ = world.user(role="user")
    nopass, _, _ = world.user(role="owner", password=None)
    owner, _, _ = world.user(role="owner")
    answers = [
        _login(c, "nobody-admin-test@example.com"),
        _login(c, owner.email, "wrong password 1"),
        _login(c, user.email),  # верный пароль, но не админ
        _login(c, nopass.email, "anything at all"),
    ]
    assert {r.status_code for r in answers} == {401}
    assert {r.json()["detail"] for r in answers} == {aa.LOGIN_FAILED}
    assert "pl_admin" not in c.cookies
    # аудит: причины видны владельцу, секретов нет
    assert world.audit(user.id)[-1][1]["reason"] == "not_admin"
    assert world.audit(owner.id)[-1][1]["reason"] == "bad_password"
    assert world.audit(nopass.id)[-1][1]["reason"] == "no_password"
    unknown = world.audit(None)[-1]
    assert unknown[0] == "admin_login.failed" and unknown[1]["email"] == "n***@example.com"
    assert unknown[1]["ip"] and unknown[1]["ua"] == UA
    flat = str(world.audit(owner.id)) + str(world.audit(None))
    assert PASSWORD not in flat and "wrong password" not in flat


@db_only
def test_first_time_setup_then_admin_access(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    c = world.client()
    u, _, _ = world.user(role="user")
    monkeypatch.setattr(settings, "owner_emails", u.email.upper())  # владелец из OWNER_EMAILS
    step = _login(c, u.email).json()
    assert step["step"] == "setup" and step["email"] == u.email
    s = c.post("/v1/admin/auth/setup", json={"ticket": step["ticket"]}).json()
    assert s["otpauth_url"].startswith("otpauth://totp/PlatformSol:") and len(s["secret"]) >= 16
    assert s["qr"]["size"] >= 21 and s["qr"]["path"].startswith("M")
    bad = c.post("/v1/admin/auth/setup/confirm", json={"ticket": step["ticket"], "code": "000000"})
    assert bad.status_code == 401 and bad.json()["detail"] == aa.CODE_FAILED
    ok = c.post(
        "/v1/admin/auth/setup/confirm", json={"ticket": step["ticket"], "code": _code(s["secret"])}
    )
    assert ok.status_code == 200, ok.text
    body = ok.json()
    assert len(body["backup_codes"]) == 10 and body["role"] == "owner"
    cookie = ok.headers["set-cookie"]
    assert "pl_admin=" in cookie and "Path=/v1/admin" in cookie and "HttpOnly" in cookie
    assert "SameSite=strict" in cookie or "samesite=strict" in cookie.lower()
    # билет одноразовый
    again = c.post(
        "/v1/admin/auth/setup/confirm",
        json={"ticket": step["ticket"], "code": _code(s["secret"], 1)},
    )
    assert again.status_code == 401
    me = c.get("/v1/admin/auth/me").json()
    assert me["email"] == u.email and me["backup_codes_left"] == 10 and me["idle_minutes"] == 60
    assert c.get("/v1/admin/audit").status_code == 200
    world.db.expire_all()
    tf = world.db.get(TwoFactor, u.id)
    assert tf is not None and tf.enabled_at is not None
    actions = [a for a, _ in world.audit(u.id)]
    for a in (
        "admin_login.password_ok",
        "admin_login.setup_started",
        "admin_login.setup_code_failed",
        "admin_login.setup_done",
        "admin_login.success",
    ):
        assert a in actions
    assert world.mails and world.mails[-1][0] == u.email  # письмо о входе
    assert s["secret"] not in str(world.audit(u.id)) and s["secret"] not in str(world.mails)


@db_only
def test_code_step_wrong_code_backup_code_and_burned_ticket(world: World) -> None:
    c = world.client()
    u, backup, secret = world.user(two_factor=True)
    assert secret is not None
    step = _login(c, u.email).json()
    assert step["step"] == "code"
    wrong = c.post("/v1/admin/auth/verify", json={"ticket": step["ticket"], "code": "123456"})
    assert wrong.status_code == 401 and wrong.json()["detail"] == aa.CODE_FAILED
    # setup недоступен, когда 2FA уже включена (нельзя подменить секрет)
    assert c.post("/v1/admin/auth/setup", json={"ticket": step["ticket"]}).status_code == 409
    ok = c.post("/v1/admin/auth/verify", json={"ticket": step["ticket"], "code": backup[0]})
    assert ok.status_code == 200 and ok.json()["backup_codes_left"] == 9
    assert [a for a, _ in world.audit(u.id)].count("admin_login.code_failed") == 1
    success = [p for a, p in world.audit(u.id) if a == "admin_login.success"][-1]
    assert success["factor"] == "backup" and success["backup_left"] == 9
    assert backup[0] not in str(world.audit(u.id))
    # 5 неверных кодов — билет сгорает, нужен новый вход
    c2 = world.client()
    u2, _, s2 = world.user(two_factor=True)
    t2 = _login(c2, u2.email).json()["ticket"]
    details = [
        c2.post("/v1/admin/auth/verify", json={"ticket": t2, "code": f"00000{i}"}).json()["detail"]
        for i in range(ratelimit.ADMIN_WRONG_CODES_PER_TICKET)
    ]
    assert details[:-1] == [aa.CODE_FAILED] * (ratelimit.ADMIN_WRONG_CODES_PER_TICKET - 1)
    assert details[-1] == aa.CODE_LOCKED
    assert s2 is not None
    late = c2.post("/v1/admin/auth/verify", json={"ticket": t2, "code": _code(s2)})
    assert late.status_code == 401 and late.json()["detail"] == aa.TICKET_FAILED


@db_only
def test_user_token_never_opens_admin_and_admin_token_not_site(world: World) -> None:
    c = world.client()
    owner, _, _ = world.user(role="owner")
    bearer = {"authorization": f"Bearer {auth.make_access_token(owner)}"}
    for path in (
        "/v1/admin/strategies",
        "/v1/admin/users",
        "/v1/admin/audit",
        "/v1/admin/labels/stats",
    ):
        r = c.get(path, headers=bearer)
        assert r.status_code == 401, path
    assert (
        c.post("/v1/admin/promo", json={"code": "ADMTX", "percent": 5}, headers=bearer).status_code
        == 401
    )
    _admin_in(world, c)
    assert c.get("/v1/admin/users").status_code == 200
    raw = c.cookies.get("pl_admin")
    assert raw
    # cookie админки не годится как токен сайта
    site = world.client().get("/v1/auth/me", headers={"authorization": f"Bearer {raw}"})
    assert site.status_code == 401


@db_only
def test_mutations_need_admin_header(world: World) -> None:
    c = world.client()
    _admin_in(world, c)
    body = {"code": f"ADMT{uuid.uuid4().hex[:6]}", "percent": 10}
    r = c.post("/v1/admin/promo", json=body)
    assert r.status_code == 403 and r.json()["detail"] == aa.CSRF_FAILED
    assert c.post("/v1/admin/promo", json=body, headers=CSRF).status_code == 201


@db_only
def test_idle_and_absolute_expiry(world: World) -> None:
    c = world.client()
    u, _, _ = _admin_in(world, c)
    world.db.expire_all()
    row = world.db.query(AdminSession).filter_by(user_id=u.id).one()
    row.last_seen_at = datetime.now(tz=UTC) - timedelta(minutes=61)
    world.db.commit()
    r = c.get("/v1/admin/auth/me")
    assert r.status_code == 401 and r.json()["detail"] == aa.SESSION_ENDED
    c2 = world.client()
    u2, _, _ = _admin_in(world, c2)
    world.db.expire_all()
    row2 = world.db.query(AdminSession).filter_by(user_id=u2.id).one()
    row2.expires_at = datetime.now(tz=UTC) - timedelta(seconds=1)
    world.db.commit()
    assert c2.get("/v1/admin/users").status_code == 401
    # действие в админке продлевает простой (отметка не чаще раза в минуту)
    c3 = world.client()
    u3, _, _ = _admin_in(world, c3)
    world.db.expire_all()
    row3 = world.db.query(AdminSession).filter_by(user_id=u3.id).one()
    row3.last_seen_at = datetime.now(tz=UTC) - timedelta(minutes=50)
    world.db.commit()
    assert c3.get("/v1/admin/auth/me").status_code == 200
    world.db.expire_all()
    assert world.db.get(AdminSession, row3.id).last_seen_at > datetime.now(tz=UTC) - timedelta(
        minutes=1
    )


@db_only
def test_password_change_and_2fa_disable_revoke_admin_sessions(world: World) -> None:
    c = world.client()
    u, secret, backup = _admin_in(world, c)
    bearer = {"authorization": f"Bearer {auth.make_access_token(u)}"}
    r = c.post(
        "/v1/me/password",
        json={"current_password": PASSWORD, "new_password": "another long password 7"},
        headers=bearer,
    )
    assert r.status_code == 204
    assert c.get("/v1/admin/auth/me").status_code == 401
    # снова вошёл; отключение 2FA на сайте закрывает и этот сеанс
    step = _login(c, u.email, "another long password 7").json()
    again = c.post("/v1/admin/auth/verify", json={"ticket": step["ticket"], "code": backup[0]})
    assert again.status_code == 200
    assert c.get("/v1/admin/auth/me").status_code == 200
    r = c.post("/v1/me/2fa/disable", json={"code": _code(secret, 1)}, headers=bearer)
    assert r.status_code == 204
    assert c.get("/v1/admin/auth/me").status_code == 401
    # пароль по ссылке сброса — тоже
    c2 = world.client()
    u2, _, _ = _admin_in(world, c2)
    raw = aa.issue_email_token(world.db, u2, "reset", timedelta(hours=1))
    world.db.commit()
    reset = c2.post(
        "/v1/auth/reset/confirm", json={"token": raw, "password": "brand new password 9"}
    )
    assert reset.status_code == 204
    assert c2.get("/v1/admin/auth/me").status_code == 401


@db_only
def test_admin_without_password_cannot_set_one_from_site_session(world: World) -> None:
    c = world.client()
    u, _, _ = world.user(role="owner", password=None)
    bearer = {"authorization": f"Bearer {auth.make_access_token(u)}"}
    r = c.post("/v1/me/password", json={"new_password": "attacker password 1"}, headers=bearer)
    assert r.status_code == 403
    plain, _, _ = world.user(role="user", password=None)
    bearer2 = {"authorization": f"Bearer {auth.make_access_token(plain)}"}
    assert (
        c.post(
            "/v1/me/password", json={"new_password": "my new password 1"}, headers=bearer2
        ).status_code
        == 204
    )


@db_only
def test_logout_separation(world: World) -> None:
    c = world.client()
    u, _, _ = _admin_in(world, c)
    # сессия сайта у того же браузера
    raw_refresh = auth.issue_refresh(world.db, u, UA)
    c.cookies.set(auth.REFRESH_COOKIE, raw_refresh, domain="testserver.local", path="/v1/auth")
    out = c.post("/v1/admin/auth/logout")
    assert out.status_code == 204 and "pl_admin=" in out.headers["set-cookie"]
    assert c.get("/v1/admin/auth/me").status_code == 401
    assert "admin_logout" in [a for a, _ in world.audit(u.id)]
    assert c.post("/v1/auth/refresh").status_code == 200  # сайт: по-прежнему вошёл
    # выход с сайта не закрывает админку
    c2 = world.client()
    u2, _, _ = _admin_in(world, c2)
    raw2 = auth.issue_refresh(world.db, u2, UA)
    c2.cookies.set(auth.REFRESH_COOKIE, raw2, domain="testserver.local", path="/v1/auth")
    assert c2.post("/v1/auth/logout").status_code == 204
    assert c2.get("/v1/admin/auth/me").status_code == 200


@db_only
def test_demoted_or_blocked_admin_loses_session(world: World) -> None:
    c = world.client()
    u, _, _ = _admin_in(world, c)
    world.db.expire_all()
    world.db.get(User, u.id).role = "user"  # type: ignore[union-attr]
    world.db.commit()
    assert c.get("/v1/admin/users").status_code == 403
    assert c.get("/v1/admin/auth/me").status_code == 401  # сеанс уже отозван
    c2 = world.client()
    u2, _, _ = _admin_in(world, c2)
    world.db.expire_all()
    world.db.get(User, u2.id).blocked_at = datetime.now(tz=UTC)  # type: ignore[union-attr]
    world.db.commit()
    assert c2.get("/v1/admin/users").status_code == 401


@db_only
def test_rate_limits_per_email_ip_and_code(world: World) -> None:
    c = world.client()
    u, _, secret = world.user(two_factor=True)
    for _ in range(ratelimit.ADMIN_LOGIN_PER_EMAIL[0]):
        assert _login(c, u.email, "wrong password x").status_code == 401
    assert _login(c, u.email).status_code == 429  # даже с верным паролем
    ratelimit._memory.values.clear()
    ip = {"x-forwarded-for": "198.51.100.7"}
    codes = [
        c.post(
            "/v1/admin/auth/login",
            json={"email": f"ip{i}-{uuid.uuid4().hex[:4]}@example.com", "password": "x"},
            headers=ip,
        ).status_code
        for i in range(ratelimit.ADMIN_LOGIN_PER_IP[0] + 1)
    ]
    assert codes[:-1] == [401] * ratelimit.ADMIN_LOGIN_PER_IP[0] and codes[-1] == 429
    ratelimit._memory.values.clear()
    assert secret is not None
    # три билета по очереди: ни один не сгорает, срабатывает лимит кодов на аккаунт
    tickets = [_login(c, u.email).json()["ticket"] for _ in range(3)]
    statuses = [
        c.post(
            "/v1/admin/auth/verify", json={"ticket": tickets[i % 3], "code": "999999"}
        ).status_code
        for i in range(ratelimit.ADMIN_CODE_PER_USER[0] + 1)
    ]
    assert statuses[-1] == 429 and set(statuses[:-1]) == {401}


@db_only
def test_magic_link_for_passwordless_admin(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    c = world.client()
    assert c.get("/v1/admin/auth/config").json()["mail"] is True  # local: письмо в лог
    u, _, _ = world.user(role="admin", password=None)
    plain, _, _ = world.user(role="user", password=None)
    r1 = c.post("/v1/admin/auth/magic", json={"email": u.email})
    r2 = c.post("/v1/admin/auth/magic", json={"email": plain.email})
    r3 = c.post("/v1/admin/auth/magic", json={"email": "nobody-magic@example.com"})
    assert r1.status_code == r2.status_code == r3.status_code == 202
    assert r1.json() == r2.json() == r3.json()
    assert len(world.mails) == 1 and world.mails[0][0] == u.email  # только админу
    link = re.search(r"/admin/login\?link=([\w-]+)", world.mails[0][2])
    assert link
    step = c.post("/v1/admin/auth/magic/consume", json={"link": link.group(1)})
    assert step.status_code == 200 and step.json()["step"] == "setup"
    reuse = c.post("/v1/admin/auth/magic/consume", json={"link": link.group(1)})
    assert reuse.status_code == 400 and reuse.json()["detail"] == aa.LINK_FAILED  # один раз
    s = c.post("/v1/admin/auth/setup", json={"ticket": step.json()["ticket"]}).json()
    ok = c.post(
        "/v1/admin/auth/setup/confirm",
        json={"ticket": step.json()["ticket"], "code": _code(s["secret"])},
    )
    assert ok.status_code == 200 and ok.json()["method"] == "magic"
    # ссылка живёт 10 минут
    raw = aa.issue_email_token(world.db, u, aa.MAGIC_PURPOSE, timedelta(minutes=-1))
    world.db.commit()
    assert c.post("/v1/admin/auth/magic/consume", json={"link": raw}).status_code == 400
    # ссылка входа на сайт не годится для админки
    site = aa.issue_email_token(world.db, u, "magic", timedelta(minutes=10))
    world.db.commit()
    assert c.post("/v1/admin/auth/magic/consume", json={"link": site}).status_code == 400
    actions = [a for a, _ in world.audit(u.id)]
    assert "admin_login.link_sent" in actions and "admin_login.link_used" in actions
    assert "admin_login.link_refused" in [a for a, _ in world.audit(plain.id)]
    # почта не настроена (production без RESEND_API_KEY) — честный отказ
    monkeypatch.setattr(settings, "app_env", "production")
    monkeypatch.setattr(settings, "resend_api_key", None)
    assert world.client().get("/v1/admin/auth/config").json()["mail"] is False
    off = world.client().post("/v1/admin/auth/magic", json={"email": u.email})
    assert off.status_code == 503 and off.json()["detail"] == aa.MAIL_OFF
