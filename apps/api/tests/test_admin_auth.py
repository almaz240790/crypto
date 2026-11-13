"""Отдельный вход в админку (ADR-0011): токен со своей областью, сеанс 8 ч / 1 ч простоя, отзыв,
обязательный второй фактор, одинаковые ошибки, лимиты попыток, аудит без секретов.

Чистые части — без БД; сценарии через HTTP — на БД с миграциями (в CI; локально — пропуск)."""

from __future__ import annotations

import os
import re
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any

import pyotp
import pytest
import segno
from fastapi import HTTPException
from sqlalchemy import select, text

from app import admin_auth as aa
from app import apikeys, auth, ratelimit, twofactor
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
    row = TwoFactor(user_id=1, secret=secret, backup_codes=[], enabled_at=now)
    assert aa.check_second_factor(row, code, now) == "totp"
    assert aa.check_second_factor(row, code, now) is None  # тот же код второй раз — нет
    assert prev == code or aa.check_second_factor(row, prev, now) is None  # старый шаг — тоже
    other = TwoFactor(user_id=2, secret=secret, backup_codes=[], enabled_at=now)
    assert aa.check_second_factor(other, code, now) == "totp"  # у другого аккаунта своя отметка
    assert aa.check_second_factor(other, "12345", now) is None
    plain, hashes = twofactor.make_backup_codes()
    row.backup_codes = list(hashes)
    assert aa.check_second_factor(row, plain[3].lower(), now) == "backup"
    assert len(row.backup_codes) == 9
    assert aa.check_second_factor(row, plain[3], now) is None  # резервный код сгорел
    fresh = pyotp.TOTP(secret).at(now + timedelta(seconds=30))
    assert aa.check_second_factor(row, fresh, now) == "totp"
    # новый секрет (настройка заново) — отметка шага сбрасывается
    twofactor.reset_secret(row, twofactor.new_secret())
    assert row.last_step is None and row.backup_codes == []


def test_totp_single_use_survives_utc_midnight() -> None:
    """SEC-4: код, принятый в 23:59:45, не принимается в 00:00:15 (раньше — новый день счётчика)."""
    secret = twofactor.new_secret()
    before = datetime(2026, 11, 5, 23, 59, 45, tzinfo=UTC)
    after = datetime(2026, 11, 6, 0, 0, 15, tzinfo=UTC)
    code = pyotp.TOTP(secret).at(before)
    assert twofactor.matched_step(secret, code, after) is not None  # ещё в окне ±30 с
    row = TwoFactor(user_id=1, secret=secret, backup_codes=[], enabled_at=before)
    assert twofactor.use_totp(row, code, before)
    assert not twofactor.use_totp(row, code, after)
    # сайт и админка делят отметку: verify_code (сайт) тот же код тоже не примет
    assert not twofactor.verify_code(row, code)


def _fake_clock(monkeypatch: pytest.MonkeyPatch, t: float) -> dict[str, float]:
    box = {"t": t}
    monkeypatch.setattr(ratelimit, "time", SimpleNamespace(time=lambda: box["t"]))
    return box


def test_strict_window_slides_over_clock_boundary(monkeypatch: pytest.MonkeyPatch) -> None:
    """SEC-5: у лимитов админки нет двойного запаса на стыке окон."""
    boundary = 900 * 2_000_000.0
    clock = _fake_clock(monkeypatch, boundary - 20)
    assert all(ratelimit.hit("adm-slide", 10, 900, strict=True) for _ in range(10))
    clock["t"] = boundary + 20
    assert not ratelimit.hit("adm-slide", 10, 900, strict=True)
    # обычный (сайт) — по-прежнему фиксированные окна
    clock["t"] = boundary - 20
    assert all(ratelimit.hit("site-fixed", 2, 900) for _ in range(2))
    clock["t"] = boundary + 20
    assert ratelimit.hit("site-fixed", 2, 900)
    # счётчик на срок жизни (билет): граница часов его не обнуляет
    clock["t"] = boundary - 20
    assert all(ratelimit.hit_total("ticket-x", 4, 900) for _ in range(4))
    clock["t"] = boundary + 20
    assert not ratelimit.hit_total("ticket-x", 4, 900)
    # только неудачи: take занимает попытку, give_back возвращает (удачный вход)
    for _ in range(5):
        ok, bucket = ratelimit.take("only-fail", 2, 900)
        assert ok
        ratelimit.give_back(bucket)
    assert ratelimit.take("only-fail", 2, 900)[0] and ratelimit.take("only-fail", 2, 900)[0]
    assert not ratelimit.take("only-fail", 2, 900)[0]


def test_client_ip_is_validated_and_proxy_ip_trusted_only_with_secret(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """SEC-2: в аудит, сеансы и письма идёт только IP-адрес; IP от прокси — только с секретом."""
    from fastapi import Request

    def req(headers: dict[str, str], host: str = "10.0.0.9") -> Request:
        raw = [(k.encode(), v.encode()) for k, v in headers.items()]
        return Request({"type": "http", "headers": raw, "client": (host, 1), "method": "GET"})

    forged = "192.0.2.1 (home Wi-Fi - this was you - no action needed), 198.51.100.99"
    assert ratelimit.client_ip(req({"x-forwarded-for": forged})) == "10.0.0.9"
    assert ratelimit.client_ip(req({"x-forwarded-for": "203.0.113.5, 10.0.0.2"})) == "203.0.113.5"
    assert ratelimit.client_ip(req({}, host="testclient")) == "?"
    proxied = {
        "x-forwarded-for": "6.6.6.6",
        ratelimit.PROXY_HEADER: "proxy-secret-xyz",
        ratelimit.PROXY_IP_HEADER: "198.51.100.7",
    }
    monkeypatch.setattr(settings, "proxy_secret", None)
    assert ratelimit.client_ip(req(proxied)) == "6.6.6.6"  # без секрета заголовок прокси не верим
    monkeypatch.setattr(settings, "proxy_secret", "proxy-secret-xyz")
    assert ratelimit.client_ip(req(proxied)) == "198.51.100.7"
    assert ratelimit.client_ip(req({**proxied, ratelimit.PROXY_HEADER: "guess"})) == "6.6.6.6"
    with pytest.raises(HTTPException) as e:
        aa.site_proxy_only(req({"x-forwarded-for": "6.6.6.6"}))
    assert e.value.status_code == 403
    aa.site_proxy_only(req(proxied))


def test_device_cookie_and_rotation_tokens_are_bound() -> None:
    from fastapi import Request

    token = aa.make_device(7)
    r = Request({"type": "http", "headers": [(b"cookie", f"{aa.DEVICE_COOKIE}={token}".encode())]})
    dev = aa.read_device(r)
    assert dev is not None and dev[0] == 7
    owner = User(id=7, email="o@x.io", role="owner")
    stranger = User(id=8, email="s@x.io", role="owner")
    assert aa.limit_keys("admin-login", "o@x.io", owner, dev, r)[0].startswith("admin-login:dev:")
    assert aa.limit_keys("admin-login", "s@x.io", stranger, dev, r) == (
        "admin-login:s:s@x.io",
        None,
    )
    # cookie устройства — не сеанс: подписана своим ключом, токеном админки не служит
    with pytest.raises(HTTPException):
        aa.decode_token(token)
    pending = aa.make_rotation(7, "sid-1", "SECRET")
    assert aa.read_rotation(pending, 7, "sid-1") == "SECRET"
    assert aa.read_rotation(pending, 7, "sid-2") is None  # только в том же сеансе
    assert aa.read_rotation(pending, 8, "sid-1") is None
    assert aa.read_rotation(token, 7, "sid-1") is None


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
    monkeypatch.setattr(settings, "proxy_secret", None)
    # local: cookie без Secure (тестовый клиент ходит по http), письма — в лог
    monkeypatch.setattr(settings, "app_env", "local")
    monkeypatch.setattr(settings, "resend_api_key", None)
    try:
        yield w
    finally:
        w.close()


def _code(secret: str, shift: int = 0) -> str:
    return pyotp.TOTP(secret).at(datetime.now(tz=UTC) + timedelta(seconds=30 * shift))


def _login(c: Any, email: str, password: str = PASSWORD) -> Any:
    return c.post("/v1/admin/auth/login", json={"email": email, "password": password})


def _last_link(w: World) -> str:
    """Ссылка входа в админку из последнего письма."""
    m = re.search(r"/admin/login\?link=([\w-]+)", w.mails[-1][2])
    assert m, w.mails[-1]
    return m.group(1)


def _setup_by_link(w: World, c: Any, email: str) -> tuple[dict[str, Any], dict[str, Any]]:
    """Пароль → письмо со ссылкой → ссылка → первая настройка кода. (шаг ссылки, ответ setup)."""
    first = _login(c, email).json()
    assert first["step"] == "mail" and first["sent"] is True, first
    step = c.post("/v1/admin/auth/magic/consume", json={"link": _last_link(w)}).json()
    assert step["step"] == "setup", step
    s = c.post("/v1/admin/auth/setup", json={"ticket": step["ticket"]}).json()
    return step, s


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
    # пароль без 2FA (и почта ещё не подтверждена) — только письмо со ссылкой, не настройка
    first = _login(c, u.email).json()
    assert first == {"step": "mail", "email": u.email, "mail": True, "sent": True}
    world.db.expire_all()
    assert world.db.get(User, u.id).role == "user"  # type: ignore[union-attr]
    assert world.mails[-1][0] == u.email
    step = c.post("/v1/admin/auth/magic/consume", json={"link": _last_link(world)}).json()
    assert step["step"] == "setup" and step["email"] == u.email
    world.db.expire_all()
    promoted = world.db.get(User, u.id)
    assert promoted is not None and promoted.role == "owner" and promoted.email_verified_at
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
    cookies = ok.headers.get_list("set-cookie")
    cookie = next(x for x in cookies if x.startswith("pl_admin="))
    assert "Path=/v1/admin" in cookie and "HttpOnly" in cookie
    assert f"Max-Age={int((aa.TTL + aa.COOKIE_GRACE).total_seconds())}" in cookie
    assert "SameSite=strict" in cookie or "samesite=strict" in cookie.lower()
    device = next(x for x in cookies if x.startswith(f"{aa.DEVICE_COOKIE}="))
    assert "Path=/v1/admin/auth" in device and "HttpOnly" in device
    # билет одноразовый
    again = c.post(
        "/v1/admin/auth/setup/confirm",
        json={"ticket": step["ticket"], "code": _code(s["secret"], 1)},
    )
    assert again.status_code == 410
    me = c.get("/v1/admin/auth/me").json()
    assert me["email"] == u.email and me["backup_codes_left"] == 10 and me["idle_minutes"] == 60
    assert c.get("/v1/admin/audit").status_code == 200
    world.db.expire_all()
    tf = world.db.get(TwoFactor, u.id)
    assert tf is not None and tf.enabled_at is not None and tf.last_step is not None
    actions = [a for a, _ in world.audit(u.id)]
    for a in (
        "admin_login.password_ok",
        "admin_login.link_used",
        "admin_login.setup_started",
        "admin_login.setup_code_failed",
        "admin_login.setup_done",
        "admin_login.success",
    ):
        assert a in actions
    assert world.mails and world.mails[-1][0] == u.email  # письмо о входе
    assert s["secret"] not in str(world.audit(u.id)) and s["secret"] not in str(world.mails)


@db_only
def test_password_alone_never_opens_first_setup(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    """SEC-1/SEC-7: без подтверждения почты в этом входе привязать своё приложение нельзя."""
    c = world.client()
    u, _, _ = world.user(role="owner")
    # билет после пароля (как будто его выдали) настройку не открывает
    pw_ticket = aa.issue_ticket(world.db, u, "password")
    world.db.commit()
    r = c.post("/v1/admin/auth/setup", json={"ticket": pw_ticket})
    assert r.status_code == 409 and r.json()["detail"] == aa.SETUP_NEEDS_LINK
    r = c.post("/v1/admin/auth/setup/confirm", json={"ticket": pw_ticket, "code": "123456"})
    assert r.status_code == 409
    # почта на сервере не настроена: шаг mail без письма, подсказка про ссылку с сервера
    monkeypatch.setattr(settings, "app_env", "production")
    sent_before = len(world.mails)
    off = _login(c, u.email).json()
    assert off == {"step": "mail", "email": u.email, "mail": False, "sent": False}
    assert len(world.mails) == sent_before
    assert world.db.get(TwoFactor, u.id) is None
    # ссылка с сервера (scripts/admin_link.py делает то же) открывает настройку
    raw = aa.issue_email_token(world.db, u, aa.MAGIC_PURPOSE, timedelta(minutes=30))
    world.db.commit()
    step = c.post("/v1/admin/auth/magic/consume", json={"link": raw}).json()
    assert step["step"] == "setup"


@db_only
def test_reregistered_owner_address_gets_no_admin(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    """SEC-7: украденная сессия сайта → удалить аккаунт → зарегистрировать адрес владельца заново
    со своим паролем. Новый аккаунт не владелец (почта не подтверждена), настройка кода — только
    по ссылке, которая уходит в ящик настоящего владельца."""
    owner, _, _ = world.user(role="owner", two_factor=True)
    owner_id, owner_email = owner.id, owner.email
    monkeypatch.setattr(settings, "owner_emails", owner_email)
    c = world.client()
    stolen = {"authorization": f"Bearer {auth.make_access_token(owner)}"}
    assert c.get("/v1/admin/users", headers=stolen).status_code == 401
    # удалить аккаунт владельца из сеанса сайта нельзя (адрес не освобождается)
    assert c.delete("/v1/me", headers=stolen).status_code == 403
    world.db.expire_all()
    assert world.db.get(User, owner_id).deleted_at is None  # type: ignore[union-attr]
    # адрес всё же свободен (так было до этой правки; или адрес из OWNER_EMAILS ещё без аккаунта)
    gone = world.db.get(User, owner_id)
    assert gone is not None
    gone.deleted_at, gone.email = datetime.now(tz=UTC), f"deleted-{owner_id}@users.platform.local"
    world.db.commit()
    attacker = world.client()
    reg = attacker.post(
        "/v1/auth/register", json={"email": owner_email, "password": "attacker password 77"}
    )
    assert reg.status_code == 201, reg.text
    world.db.expire_all()
    new = world.db.scalar(select(User).where(User.email == owner_email))
    assert new is not None and new.id != owner_id
    world.ids.append(new.id)
    assert new.role == "user" and new.email_verified_at is None
    token = {"authorization": f"Bearer {reg.json()['access_token']}"}
    assert attacker.get("/v1/auth/me", headers=token).json()["role"] == "user"
    step = _login(attacker, owner_email, "attacker password 77").json()
    assert step["step"] == "mail" and "ticket" not in step  # ссылка — в ящик владельца
    assert world.mails[-1][0] == owner_email
    world.db.expire_all()
    assert world.db.get(TwoFactor, new.id) is None
    assert attacker.get("/v1/admin/users").status_code == 401
    # и из сеанса сайта своё приложение к адресу владельца не привязать
    r = attacker.post("/v1/me/2fa/setup", headers=token)
    assert r.status_code == 403 and "админку" in r.json()["detail"]


@db_only
def test_site_session_cannot_enable_2fa_for_admin_account(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Окно SEC-1 через сайт: украденный пароль (вход на сайт без кода) или сессия сайта не
    включают 2FA админу — иначе чужое приложение стало бы вторым фактором админки."""
    c = world.client()
    owner, _, _ = world.user(role="owner")
    bearer = {"authorization": f"Bearer {auth.make_access_token(owner)}"}
    st = c.get("/v1/me/2fa", headers=bearer).json()
    assert st == {"enabled": False, "backup_codes_left": 0, "admin": True}
    assert c.post("/v1/me/2fa/setup", headers=bearer).status_code == 403
    world.db.add(TwoFactor(user_id=owner.id, secret=twofactor.new_secret(), backup_codes=[]))
    world.db.commit()
    r = c.post("/v1/me/2fa/enable", json={"code": "123456"}, headers=bearer)
    assert r.status_code == 403
    world.db.expire_all()
    tf = world.db.get(TwoFactor, owner.id)
    assert tf is not None and tf.enabled_at is None
    assert _login(world.client(), owner.email).json()["step"] == "mail"  # пароль → только письмо
    # обычный пользователь настраивает 2FA на сайте как раньше
    plain, _, _ = world.user(role="user")
    b2 = {"authorization": f"Bearer {auth.make_access_token(plain)}"}
    assert c.get("/v1/me/2fa", headers=b2).json()["admin"] is False
    s = c.post("/v1/me/2fa/setup", headers=b2)
    assert s.status_code == 200
    ok = c.post("/v1/me/2fa/enable", json={"code": _code(s.json()["secret"])}, headers=b2)
    assert ok.status_code == 200 and len(ok.json()["backup_codes"]) == 10
    # адрес из OWNER_EMAILS без роли (почта не подтверждена) — тоже нельзя
    listed, _, _ = world.user(role="user")
    monkeypatch.setattr(settings, "owner_emails", listed.email)
    b3 = {"authorization": f"Bearer {auth.make_access_token(listed)}"}
    assert c.post("/v1/me/2fa/setup", headers=b3).status_code == 403


@db_only
def test_provider_verified_email_promotes_existing_owner_account(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Вход через Google с подтверждённым адресом подтверждает почту и у аккаунта, который уже
    был заведён на этот адрес, — после этого адрес из OWNER_EMAILS получает роль владельца."""
    u, _, _ = world.user(role="user")
    monkeypatch.setattr(settings, "owner_emails", u.email)
    assert not auth.promote_owner(u, settings.owner_email_set)
    same = auth.find_or_link_identity(world.db, "google", f"g-{u.id}", u.email, None, {})
    assert same.id == u.id and same.email_verified_at is not None
    assert auth.promote_owner(same, settings.owner_email_set) and same.role == "owner"
    world.db.commit()
    world.db.execute(text("delete from auth_identities where user_id = :u"), {"u": u.id})
    world.db.commit()


@db_only
def test_code_used_in_admin_is_not_accepted_on_site(world: World) -> None:
    """SEC-1: код, которым владелец вошёл в админку, нельзя повторить на сайте. Отключить 2FA на
    сайте админ не может вовсе — иначе аккаунт вернулся бы в переходный режим (админка по токену
    сайта); после сброса на сервере следующий вход ведёт к письму, а не к настройке."""
    c = world.client()
    u, backup, secret = world.user(two_factor=True)
    assert secret is not None
    used = _code(secret)
    step = _login(c, u.email).json()
    ok = c.post("/v1/admin/auth/verify", json={"ticket": step["ticket"], "code": used})
    assert ok.status_code == 200  # этим кодом владелец вошёл в админку
    site = world.client()
    first = site.post("/v1/auth/login", json={"email": u.email, "password": PASSWORD}).json()
    assert first["two_factor"] is True
    r = site.post("/v1/auth/login/2fa", json={"ticket": first["ticket"], "code": used})
    assert r.status_code == 401
    bearer = {"authorization": f"Bearer {auth.make_access_token(u)}"}
    # ни использованным, ни свежим, ни резервным кодом
    for code in (used, _code(secret, 1), backup[0]):
        r = site.post("/v1/me/2fa/disable", json={"code": code}, headers=bearer)
        assert r.status_code == 403 and "Защита входа" in r.json()["detail"]
    assert c.get("/v1/admin/auth/me").status_code == 200  # сеанс владельца цел
    world.db.expire_all()
    tf = world.db.get(TwoFactor, u.id)
    assert twofactor.is_enabled(tf) and tf is not None and len(tf.backup_codes) == 10
    assert site.get("/v1/admin/users", headers=bearer).status_code == 401  # и токен сайта — нет
    # сброс на сервере (scripts/admin_2fa_reset.py): сеанс закрыт, новая настройка — по ссылке
    world.db.delete(tf)
    aa.revoke_user_sessions(world.db, u.id, "2fa")
    world.db.commit()
    r = c.get("/v1/admin/auth/me")
    assert r.status_code == 401 and r.headers[aa.ENDED_HEADER] == "2fa"
    assert _login(world.client(), u.email).json()["step"] == "mail"
    # обычный пользователь отключает 2FA на сайте как раньше; использованный код не повторить
    plain, _, s2 = world.user(role="user", two_factor=True)
    assert s2 is not None
    b2 = {"authorization": f"Bearer {auth.make_access_token(plain)}"}
    t2 = site.post("/v1/auth/login", json={"email": plain.email, "password": PASSWORD}).json()
    spent = _code(s2)
    r = site.post("/v1/auth/login/2fa", json={"ticket": t2["ticket"], "code": spent})
    assert r.status_code == 200
    assert site.post("/v1/me/2fa/disable", json={"code": spent}, headers=b2).status_code == 400
    r = site.post("/v1/me/2fa/disable", json={"code": _code(s2, 1)}, headers=b2)
    assert r.status_code == 204


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
    assert late.status_code == 410 and late.json()["detail"] == aa.TICKET_FAILED


GRACE_PATHS = (
    "/v1/admin/strategies",
    "/v1/admin/users",
    "/v1/admin/audit",
    "/v1/admin/labels/stats",
)


def _bearer(user: User) -> dict[str, str]:
    """Обычный токен сайта этого пользователя (как у вошедшего на сайт)."""
    return {"authorization": f"Bearer {auth.make_access_token(user)}"}


def _promo() -> dict[str, Any]:
    return {"code": f"ADMT{uuid.uuid4().hex[:6]}", "percent": 5}


@db_only
def test_site_token_opens_admin_only_until_2fa_is_enabled(world: World) -> None:
    """Переходный режим: владельца без 2FA в админку пускает обычный токен сайта (как до
    ADR-0011), действия помечены в аудите; первый верный код закрывает этот путь навсегда."""
    c = world.client()
    owner, _, _ = world.user(role="owner")
    bearer = _bearer(owner)
    assert c.get("/v1/admin/users").status_code == 401  # без токена и без cookie — нет
    me = c.get("/v1/admin/auth/me", headers=bearer)
    assert me.status_code == 200, me.text
    assert me.json() == {
        "id": owner.id,
        "email": owner.email,
        "name": None,
        "role": "owner",
        "method": "site",
        "grace": True,
        "setup_required": True,
        "backup_codes_left": 0,
    }  # сроков сеанса нет: это не сеанс админки
    assert aa.COOKIE not in c.cookies
    for path in GRACE_PATHS:
        assert c.get(path, headers=bearer).status_code == 200, path
    # изменяющий запрос: заголовок против CSRF не нужен (токен не cookie), в аудите — access=grace
    made = c.post("/v1/admin/promo", json=_promo(), headers=bearer)
    assert made.status_code == 201, made.text
    assert [p for a, p in world.audit(owner.id) if a == "promo.create"][-1]["access"] == "grace"
    # настроить код без письма нельзя: пароль → письмо; начатая настройка режим не закрывает
    c2 = world.client()
    step, s = _setup_by_link(world, c2, owner.email)
    assert c.get("/v1/admin/users", headers=bearer).status_code == 200
    for path in ("/v1/admin/auth/2fa/backup-codes", "/v1/admin/auth/2fa/rotate"):
        r = c.post(path, json={"code": "123456"}, headers=bearer)
        assert r.status_code == 401, path  # действия с кодом — только в сеансе админки
    done = c2.post(
        "/v1/admin/auth/setup/confirm", json={"ticket": step["ticket"], "code": _code(s["secret"])}
    )
    assert done.status_code == 200, done.text
    # 2FA включена — тот же токен сайта больше не подходит нигде
    for path in ("/v1/admin/auth/me", *GRACE_PATHS):
        r = c.get(path, headers=bearer)
        assert r.status_code == 401 and r.json()["detail"] == aa.NEED_LOGIN, path
    assert c.post("/v1/admin/promo", json=_promo(), headers=bearer).status_code == 401
    # сеанс админки работает как раньше: сроки, заголовок против CSRF, в аудите отметки нет
    me2 = c2.get("/v1/admin/auth/me").json()
    assert me2["grace"] is False and me2["method"] == "magic" and "setup_required" not in me2
    assert me2["expires_at"] and me2["idle_minutes"] == 60 and me2["backup_codes_left"] == 10
    r = c2.post("/v1/admin/promo", json=_promo(), headers=bearer)  # cookie есть — решает сеанс
    assert r.status_code == 403 and r.json()["detail"] == aa.CSRF_FAILED
    assert c2.post("/v1/admin/promo", json=_promo(), headers=CSRF).status_code == 201
    assert "access" not in [p for a, p in world.audit(owner.id) if a == "promo.create"][-1]
    # cookie админки не годится как токен сайта
    raw = c2.cookies.get("pl_admin")
    assert raw
    site = world.client().get("/v1/auth/me", headers={"authorization": f"Bearer {raw}"})
    assert site.status_code == 401


@db_only
def test_grace_is_for_admins_without_2fa_only(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Переходный режим не шире, чем доступ до ADR-0011: не админ — 403, заблокированный и
    удалённый — отказ, чужие токены — 401, права админки без кода не выдаются."""
    c = world.client()
    for role in ("user", "support"):
        plain, _, _ = world.user(role=role)
        for path in ("/v1/admin/auth/me", *GRACE_PATHS):
            r = c.get(path, headers=_bearer(plain))
            assert r.status_code == 403 and r.json()["detail"] == aa.NO_RIGHTS, (role, path)
    owner, _, _ = world.user(role="owner")
    bearer = _bearer(owner)
    assert c.get("/v1/admin/users", headers=bearer).status_code == 200
    # подделка, токен без подписи сайта, токен админки и API-ключ — не подходят
    now = datetime.now(tz=UTC)
    admin_token = aa.make_token(owner.id, "a" * 32, now, now + aa.TTL)
    for bad in ("garbage", admin_token, aa.make_device(owner.id)):
        r = c.get("/v1/admin/users", headers={"authorization": f"Bearer {bad}"})
        assert r.status_code == 401, bad[:12]
    # API-ключ открывает только эндпоинты /api-docs (ADR-0017): админка по ключу — 403
    r = c.get("/v1/admin/users", headers={"x-api-key": "pk_whatever"})
    assert r.status_code == 403 and r.json()["detail"] == apikeys.OUT_OF_SCOPE
    # выдать права админки в переходном режиме нельзя (кода ещё нет) — даже с «кодом»
    target, _, _ = world.user(role="user")
    url = f"/v1/admin/users/{target.id}"
    for body in ({"role": "admin"}, {"role": "owner", "code": "123456"}):
        r = c.patch(url, json=body, headers=bearer)
        assert r.status_code == 403 and "сначала настройте защиту" in r.json()["detail"]
    world.db.expire_all()
    assert world.db.get(User, target.id).role == "user"  # type: ignore[union-attr]
    # остальное — как до ADR-0011: роль support и блокировка работают и видны в аудите
    assert c.patch(url, json={"role": "support"}, headers=bearer).status_code == 200
    r = c.patch(url, json={"block": True, "reason": "проверка"}, headers=bearer)
    assert r.status_code == 200
    marks = {a: p.get("access") for a, p in world.audit(owner.id)}
    assert marks == {"user.role": "grace", "user.block": "grace"}
    # только через прокси сайта, если задан PROXY_SECRET
    monkeypatch.setattr(settings, "proxy_secret", "proxy-secret-for-grace")
    r = c.get("/v1/admin/users", headers=bearer)
    assert r.status_code == 403 and r.json()["detail"] == aa.PROXY_ONLY
    signed = {**bearer, ratelimit.PROXY_HEADER: "proxy-secret-for-grace"}
    assert c.get("/v1/admin/users", headers=signed).status_code == 200
    monkeypatch.setattr(settings, "proxy_secret", None)
    # заблокированный и удалённый владелец
    world.db.expire_all()
    row = world.db.get(User, owner.id)
    assert row is not None
    row.blocked_at = now
    world.db.commit()
    r = c.get("/v1/admin/users", headers=bearer)
    assert r.status_code == 403 and r.json()["detail"] == aa.BLOCKED
    assert c.get("/v1/admin/auth/me", headers=bearer).status_code == 403
    row.blocked_at, row.deleted_at = None, now
    world.db.commit()
    assert c.get("/v1/admin/users", headers=bearer).status_code == 401


@db_only
def test_closed_session_keeps_its_reason_and_server_reset_returns_grace(world: World) -> None:
    """Закрытый сеанс админа с 2FA: токен сайта не помогает, причина закрытия доходит до страницы
    входа. После сброса 2FA на сервере аккаунт снова в переходном режиме — до новой настройки."""
    c = world.client()
    u, _, _ = _admin_in(world, c)
    bearer = _bearer(u)
    assert c.get("/v1/admin/auth/me", headers=bearer).json()["grace"] is False  # решает сеанс
    aa.revoke_user_sessions(world.db, u.id, "password")
    world.db.commit()
    r = c.get("/v1/admin/users", headers=bearer)
    assert r.status_code == 401 and r.headers[aa.ENDED_HEADER] == "password"
    # scripts/admin_2fa_reset.py: секрет удалён, сеансы закрыты
    c2 = world.client()
    u2, _, _ = _admin_in(world, c2)
    tf = world.db.get(TwoFactor, u2.id)
    assert tf is not None
    world.db.delete(tf)
    aa.revoke_user_sessions(world.db, u2.id, "2fa")
    world.db.commit()
    r = c2.get("/v1/admin/auth/me")
    assert r.status_code == 401 and r.headers[aa.ENDED_HEADER] == "2fa"
    me = c2.get("/v1/admin/auth/me", headers=_bearer(u2))  # старая cookie ещё в браузере
    assert me.status_code == 200 and me.json()["grace"] is True


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
    assert r.status_code == 401 and r.headers[aa.ENDED_HEADER] == "idle"
    assert r.json()["detail"] == aa.ENDED_TEXT["idle"]
    c2 = world.client()
    u2, _, _ = _admin_in(world, c2)
    world.db.expire_all()
    row2 = world.db.query(AdminSession).filter_by(user_id=u2.id).one()
    row2.expires_at = datetime.now(tz=UTC) - timedelta(seconds=1)
    world.db.commit()
    r2 = c2.get("/v1/admin/users")
    assert r2.status_code == 401 and r2.headers[aa.ENDED_HEADER] == "expired"
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
def test_password_change_revokes_admin_sessions_and_2fa_stays(world: World) -> None:
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
    # снова вошёл; отключить 2FA на сайте админу нельзя — сеанс остаётся
    step = _login(c, u.email, "another long password 7").json()
    again = c.post("/v1/admin/auth/verify", json={"ticket": step["ticket"], "code": backup[0]})
    assert again.status_code == 200
    assert c.get("/v1/admin/auth/me").status_code == 200
    r = c.post("/v1/me/2fa/disable", json={"code": _code(secret, 1)}, headers=bearer)
    assert r.status_code == 403
    assert c.get("/v1/admin/auth/me").status_code == 200
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
    # верные входы попыток не тратят (раньше 5 входов за 15 минут запирали самого владельца)
    for _ in range(ratelimit.ADMIN_LOGIN_PER_EMAIL[0] + 1):
        assert _login(c, u.email).json()["step"] == "code"
    for _ in range(ratelimit.ADMIN_LOGIN_PER_EMAIL[0]):
        assert _login(c, u.email, "wrong password x").status_code == 401
    # с нового браузера (без cookie устройства) — 429 даже с верным паролем: перебор по адресу
    assert _login(c, u.email).status_code == 429
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
    # верные коды попыток не тратят: владелец не запирает себя обычными входами
    ratelimit._memory.values.clear()
    u_ok, backup_ok, _ = world.user(two_factor=True)
    for i in range(ratelimit.ADMIN_CODE_PER_USER[0] + 2):
        t_ok = _login(c, u_ok.email).json()["ticket"]
        r_ok = c.post("/v1/admin/auth/verify", json={"ticket": t_ok, "code": backup_ok[i % 10]})
        if i < 10:
            assert r_ok.status_code == 200, (i, r_ok.text)
    # мусорные билеты с одного IP: лимит до поиска билета, в аудит они не пишутся вовсе
    ratelimit._memory.values.clear()
    junk = [
        c.post(
            "/v1/admin/auth/verify", json={"ticket": f"junk-ticket-{i:04d}", "code": "123456"}
        ).status_code
        for i in range(ratelimit.ADMIN_CODE_PER_IP[0] + 1)
    ]
    assert set(junk[:-1]) == {410} and junk[-1] == 429
    assert not [a for a, _ in world.audit(None) if a == "admin_login.ticket_invalid"]


@db_only
def test_strangers_cannot_lock_the_owner_out(world: World) -> None:
    """SEC-3 / OWNER-EMAIL-LOCKOUT: перебор по известному адресу (с любых IP) не запирает
    браузер, где владелец уже входил; ссылку на почту — тоже."""
    owner_browser = world.client()
    u, _, _ = _admin_in(world, owner_browser)
    assert owner_browser.cookies.get(aa.DEVICE_COOKIE)
    attacker = world.client()

    def guess(i: int, password: str) -> int:
        r = attacker.post(
            "/v1/admin/auth/login",
            json={"email": u.email, "password": password},
            headers={"x-forwarded-for": f"203.0.113.{i + 1}"},  # каждый раз новый IP
        )
        return int(r.status_code)

    assert [guess(i, f"guess {i}") for i in range(ratelimit.ADMIN_LOGIN_PER_EMAIL[0])] == [401] * 5
    assert guess(9, "guess again") == 429
    assert guess(10, PASSWORD) == 429  # с чужого браузера — даже верный пароль (перебор по адресу)
    for _ in range(ratelimit.ADMIN_MAIL_PER_EMAIL[0]):
        assert attacker.post("/v1/admin/auth/magic", json={"email": u.email}).status_code == 202
    assert attacker.post("/v1/admin/auth/magic", json={"email": u.email}).status_code == 429
    # владелец со своего браузера: и пароль, и ссылка работают
    assert _login(owner_browser, u.email).json()["step"] == "code"
    assert owner_browser.post("/v1/admin/auth/magic", json={"email": u.email}).status_code == 202
    # но cookie устройства — не пропуск: неверный пароль с неё тоже считается (5 за 15 минут)
    for i in range(ratelimit.ADMIN_LOGIN_PER_EMAIL[0]):
        assert _login(owner_browser, u.email, f"typo {i}").status_code == 401
    assert _login(owner_browser, u.email).status_code == 429


@db_only
def test_behind_site_proxy_guessing_from_other_ips_does_not_lock_new_device(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    """SEC-3 с PROXY_SECRET: IP клиента называет прокси сайта, лимит пароля и писем — на пару
    «адрес + IP». Перебор с чужих IP не запирает владельца даже с нового устройства; общий
    потолок по адресу ограничивает распределённый перебор."""
    monkeypatch.setattr(settings, "proxy_secret", "proxy-secret-test")

    def via(ip: str) -> dict[str, str]:
        return {ratelimit.PROXY_HEADER: "proxy-secret-test", ratelimit.PROXY_IP_HEADER: ip}

    u, _, _ = world.user(two_factor=True)
    attacker = world.client()

    def guess(ip: str, password: str = "guess") -> int:
        r = attacker.post(
            "/v1/admin/auth/login", json={"email": u.email, "password": password}, headers=via(ip)
        )
        return int(r.status_code)

    per_email = ratelimit.ADMIN_LOGIN_PER_EMAIL[0]
    assert [guess("203.0.113.5") for _ in range(per_email)] == [401] * per_email
    assert guess("203.0.113.5") == 429 and guess("203.0.113.5", PASSWORD) == 429  # сам себя запер
    # подставленный клиентом X-Forwarded-For ничего не меняет: IP — от прокси
    forged = {**via("203.0.113.5"), "x-forwarded-for": "198.51.100.77"}
    r = attacker.post(
        "/v1/admin/auth/login", json={"email": u.email, "password": "guess"}, headers=forged
    )
    assert r.status_code == 429
    for _ in range(ratelimit.ADMIN_MAIL_PER_EMAIL[0]):
        m = attacker.post(
            "/v1/admin/auth/magic", json={"email": u.email}, headers=via("203.0.113.5")
        )
        assert m.status_code == 202
    m = attacker.post("/v1/admin/auth/magic", json={"email": u.email}, headers=via("203.0.113.5"))
    assert m.status_code == 429
    # владелец: новое устройство (cookie устройства нет), свой IP — пароль и ссылка работают
    owner = world.client()
    ok = owner.post(
        "/v1/admin/auth/login",
        json={"email": u.email, "password": PASSWORD},
        headers=via("198.51.100.7"),
    )
    assert ok.status_code == 200 and ok.json()["step"] == "code"
    link = owner.post("/v1/admin/auth/magic", json={"email": u.email}, headers=via("198.51.100.7"))
    assert link.status_code == 202
    # распределённый перебор упирается в общий потолок по адресу
    ratelimit._memory.values.clear()
    total = ratelimit.ADMIN_LOGIN_PER_EMAIL_ALL[0]
    codes = {guess(f"10.{i // 250}.{i % 250}.9") for i in range(total)}
    assert codes == {401}
    assert guess("10.200.0.1") == 429


@db_only
def test_wrong_codes_burn_ticket_across_clock_boundary(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    """SEC-5: 5-й неверный код сжигает билет, даже если попытки пришлись на стык окон."""
    c = world.client()
    u, _, secret = world.user(two_factor=True)
    assert secret is not None
    ticket = _login(c, u.email).json()["ticket"]
    boundary = (int(datetime.now(tz=UTC).timestamp()) // 900 + 1) * 900
    clock = _fake_clock(monkeypatch, boundary - 20)
    wrong = [
        c.post("/v1/admin/auth/verify", json={"ticket": ticket, "code": "000001"}).status_code
        for _ in range(4)
    ]
    clock["t"] = boundary + 20
    fifth = c.post("/v1/admin/auth/verify", json={"ticket": ticket, "code": "000001"})
    assert wrong == [401] * 4 and fifth.status_code == 410
    late = c.post("/v1/admin/auth/verify", json={"ticket": ticket, "code": _code(secret)})
    assert late.status_code == 410


@db_only
def test_single_use_secrets_hold_under_concurrency(world: World) -> None:
    """SEC-6: один резервный код и одна ссылка из письма — один вход, даже одновременно."""
    import threading

    u, backup, _ = world.user(two_factor=True)
    tickets = [_login(world.client(), u.email).json()["ticket"] for _ in range(6)]
    barrier = threading.Barrier(len(tickets))
    results: list[int] = []

    def go(ticket: str) -> None:
        client = world.client()
        barrier.wait()
        r = client.post("/v1/admin/auth/verify", json={"ticket": ticket, "code": backup[0]})
        results.append(r.status_code)

    threads = [threading.Thread(target=go, args=(t,)) for t in tickets]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(results).count(200) == 1, results
    world.db.expire_all()
    assert world.db.query(AdminSession).filter_by(user_id=u.id).count() == 1
    tf = world.db.get(TwoFactor, u.id)
    assert tf is not None and len(tf.backup_codes) == 9
    # ссылка из письма: 4 одновременных перехода — один билет
    raw = aa.issue_email_token(world.db, u, aa.MAGIC_PURPOSE, aa.MAGIC_TTL)
    world.db.commit()
    barrier2 = threading.Barrier(4)
    used: list[int] = []

    def consume() -> None:
        client = world.client()
        barrier2.wait()
        used.append(client.post("/v1/admin/auth/magic/consume", json={"link": raw}).status_code)

    threads = [threading.Thread(target=consume) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(used) == [200, 400, 400, 400], used


@db_only
def test_proxy_secret_gates_admin_and_supplies_client_ip(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    """SEC-2: с PROXY_SECRET админка — только через прокси сайта, IP — от прокси; в аудит и
    письмо подставленный текст не попадает."""
    monkeypatch.setattr(settings, "proxy_secret", "proxy-secret-test")
    c = world.client()
    assert c.get("/v1/admin/auth/config").status_code == 403
    assert c.get("/v1/admin/users").status_code == 403
    proxy = {ratelimit.PROXY_HEADER: "proxy-secret-test", ratelimit.PROXY_IP_HEADER: "203.0.113.9"}
    forged = "1.2.3.4 (this was you - all good), 5.6.7.8"
    hdrs = {**proxy, "x-forwarded-for": forged}
    assert c.get("/v1/admin/auth/config", headers=hdrs).status_code == 200
    u, _, secret = world.user(two_factor=True)
    assert secret is not None
    step = c.post(
        "/v1/admin/auth/login", json={"email": u.email, "password": PASSWORD}, headers=hdrs
    ).json()
    ok = c.post(
        "/v1/admin/auth/verify",
        json={"ticket": step["ticket"], "code": _code(secret)},
        headers=hdrs,
    )
    assert ok.status_code == 200
    ips = {p["ip"] for _, p in world.audit(u.id)}
    assert ips == {"203.0.113.9"}
    world.db.expire_all()
    row = world.db.query(AdminSession).filter_by(user_id=u.id).one()
    assert row.ip == "203.0.113.9"
    assert "this was you" not in world.mails[-1][2] and "203.0.113.9" in world.mails[-1][2]
    # без секрета прокси — подставленный X-Forwarded-For с текстом не проходит проверку
    monkeypatch.setattr(settings, "proxy_secret", None)
    c.post(
        "/v1/admin/auth/login",
        json={"email": u.email, "password": "wrong password"},
        headers={"x-forwarded-for": forged},
    )
    assert "this was you" not in str(world.audit(u.id))


@db_only
def test_session_end_reasons_reach_login_page(world: World) -> None:
    """ENDED-MESSAGE-WRONG-REASON: причина закрытия сеанса — в заголовке X-Admin-Ended."""
    c = world.client()
    u, _, _ = _admin_in(world, c)
    bearer = {"authorization": f"Bearer {auth.make_access_token(u)}"}
    c.post(
        "/v1/me/password",
        json={"current_password": PASSWORD, "new_password": "another long password 8"},
        headers=bearer,
    )
    r = c.get("/v1/admin/audit")
    assert r.status_code == 401 and r.headers[aa.ENDED_HEADER] == "password"
    assert r.json()["detail"] == aa.ENDED_TEXT["password"]
    c2 = world.client()
    _admin_in(world, c2)
    c2_cookie = c2.cookies.get(aa.COOKIE)
    other_tab = world.client()
    other_tab.cookies.set(aa.COOKIE, c2_cookie, domain="testserver.local", path="/v1/admin")
    assert c2.post("/v1/admin/auth/logout").status_code == 204
    assert other_tab.get("/v1/admin/auth/me").headers[aa.ENDED_HEADER] == "logout"
    c3 = world.client()
    u3, _, _ = _admin_in(world, c3)
    world.db.expire_all()
    world.db.get(User, u3.id).role = "user"  # type: ignore[union-attr]
    world.db.commit()
    r3 = c3.get("/v1/admin/users")
    assert r3.status_code == 403 and r3.headers[aa.ENDED_HEADER] == "role"
    nobody = world.client().get("/v1/admin/auth/me")
    assert nobody.status_code == 401 and aa.ENDED_HEADER not in nobody.headers  # без cookie
    # cookie живёт дольше сеанса: через 8 часов API называет причину, а не «нет входа»
    c4 = world.client()
    u4, _, _ = world.user(two_factor=True)
    past = datetime.now(tz=UTC) - aa.TTL - timedelta(minutes=5)
    old_token = aa.make_token(u4.id, "f" * 32, past, past + aa.TTL)
    c4.cookies.set(aa.COOKIE, old_token, domain="testserver.local", path="/v1/admin")
    r4 = c4.get("/v1/admin/users")
    assert r4.status_code == 401 and r4.headers[aa.ENDED_HEADER] == "expired"
    c4.cookies.set(aa.COOKIE, old_token[:-4] + "AAAA", domain="testserver.local", path="/v1/admin")
    assert c4.get("/v1/admin/users").headers[aa.ENDED_HEADER] == "gone"  # подделка — без подсказок


@db_only
def test_backup_codes_reissue_and_moving_code_to_new_phone(world: World) -> None:
    """OWNER-BACKUP-CODES-LOST-ON-RELOAD: новые резервные коды внутри админки по коду из
    приложения; перенос кода на другой телефон — без выключения 2FA."""
    c = world.client()
    u, secret, old_backup = _admin_in(world, c)
    r = c.post("/v1/admin/auth/2fa/backup-codes", json={"code": _code(secret, 1)})
    assert r.status_code == 403  # без заголовка админки (CSRF)
    r = c.post("/v1/admin/auth/2fa/backup-codes", json={"code": old_backup[0]}, headers=CSRF)
    assert r.status_code == 401  # резервным кодом новые коды не выпускаются — нужен телефон
    r = c.post("/v1/admin/auth/2fa/backup-codes", json={"code": _code(secret, 1)}, headers=CSRF)
    assert r.status_code == 200 and len(r.json()["backup_codes"]) == 10
    new_backup = r.json()["backup_codes"]
    world.db.expire_all()
    tf = world.db.get(TwoFactor, u.id)
    assert tf is not None and auth.sha256(old_backup[1]) not in tf.backup_codes
    # второй браузер с сеансом админки — его закроет перенос кода
    other = world.client()
    step = _login(other, u.email).json()
    assert (
        other.post(
            "/v1/admin/auth/verify", json={"ticket": step["ticket"], "code": new_backup[0]}
        ).status_code
        == 200
    )
    # перенос: телефон потерян — начать можно резервным кодом
    start = c.post("/v1/admin/auth/2fa/rotate", json={"code": new_backup[1]}, headers=CSRF)
    assert start.status_code == 200, start.text
    data = start.json()
    assert data["qr"]["path"].startswith("M") and data["secret"] != secret
    bad = c.post(
        "/v1/admin/auth/2fa/rotate/confirm",
        json={"pending": data["pending"], "code": _code(secret, 1)},
        headers=CSRF,
    )
    assert bad.status_code == 401  # код старого телефона новый секрет не подтверждает
    done = c.post(
        "/v1/admin/auth/2fa/rotate/confirm",
        json={"pending": data["pending"], "code": _code(data["secret"])},
        headers=CSRF,
    )
    assert done.status_code == 200 and len(done.json()["backup_codes"]) == 10
    again = c.post(
        "/v1/admin/auth/2fa/rotate/confirm",
        json={"pending": data["pending"], "code": _code(data["secret"], 1)},
        headers=CSRF,
    )
    assert again.status_code == 410  # ожидающий секрет одноразовый
    assert c.get("/v1/admin/auth/me").status_code == 200  # этот сеанс остаётся
    gone = other.get("/v1/admin/auth/me")
    assert gone.status_code == 401 and gone.headers[aa.ENDED_HEADER] == "2fa"
    world.db.expire_all()
    tf = world.db.get(TwoFactor, u.id)
    assert tf is not None and tf.secret == data["secret"]
    actions = [a for a, _ in world.audit(u.id)]
    for a in ("admin_2fa.backup_codes_reissued", "admin_2fa.rotate_started", "admin_2fa.rotated"):
        assert a in actions
    assert data["secret"] not in str(world.audit(u.id))


@db_only
def test_granting_admin_role_needs_fresh_code(world: World) -> None:
    """SEC-8 (смягчение): выдать права админки можно только с кодом из телефона — скрипт на
    странице сайта при открытом сеансе админки не сделает своего админа."""
    c = world.client()
    owner, secret, _ = _admin_in(world, c)
    target, _, _ = world.user(role="user")
    url = f"/v1/admin/users/{target.id}"
    r = c.patch(url, json={"role": "admin"}, headers=CSRF)
    assert r.status_code == 403
    r = c.patch(url, json={"role": "admin", "code": "000000"}, headers=CSRF)
    assert r.status_code == 403
    r = c.patch(url, json={"role": "admin", "code": _code(secret, 1)}, headers=CSRF)
    assert r.status_code == 200, r.text
    world.db.expire_all()
    assert world.db.get(User, target.id).role == "admin"  # type: ignore[union-attr]
    # admin → owner — тоже повышение: без кода нельзя
    assert c.patch(url, json={"role": "owner"}, headers=CSRF).status_code == 403
    world.db.expire_all()
    assert world.db.get(User, target.id).role == "admin"  # type: ignore[union-attr]
    # понижение и роль support — без кода
    assert c.patch(url, json={"role": "support"}, headers=CSRF).status_code == 200
    assert "user.role_code_failed" in [a for a, _ in world.audit(owner.id)]
    # перебор кода скриптом упирается в лимит кодов аккаунта (10 неверных за 15 минут)
    ratelimit._memory.values.clear()
    tries = [
        c.patch(url, json={"role": "admin", "code": f"{i:06d}"}, headers=CSRF).status_code
        for i in range(ratelimit.ADMIN_CODE_PER_USER[0] + 1)
    ]
    assert tries[:-1] == [403] * ratelimit.ADMIN_CODE_PER_USER[0] and tries[-1] == 429
    r = c.patch(url, json={"role": "admin", "code": _code(secret, 2)}, headers=CSRF)
    assert r.status_code == 429  # и верный код — после паузы


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
