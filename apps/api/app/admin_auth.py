"""Отдельный вход в админку (ADR-0011).

Сеанс админки не связан с сессией сайта:

- токен — JWT с ``scope=admin`` и своей аудиторией, подписан ключом, выведенным из JWT_SECRET
  (HMAC с меткой): токен сайта не проходит проверку админки, а токен админки — проверку сайта;
- лежит в httpOnly-cookie ``pl_admin`` с путём ``/v1/admin`` и SameSite=Strict: браузер не
  отправляет её на остальные адреса API, скрипт страницы её не видит;
- живёт 8 часов с входа и обрывается после 1 часа без действий; refresh-токена нет;
- каждый запрос сверяется со строкой ``admin_sessions``: выход, смена пароля и отключение 2FA
  отзывают сеансы на сервере сразу.

Изменяющие запросы требуют заголовок ``X-Requested-With: platformsol-admin`` (защита от CSRF
поверх SameSite). Вход: пароль или ссылка из письма → обязательный код TOTP (или резервный код).
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
import pyotp
import segno
from fastapi import Depends, HTTPException, Request, Response
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app import auth, ratelimit, twofactor
from app.config import settings
from app.models import AdminAudit, AdminSession, EmailToken, TwoFactor, User

ADMIN_ROLES = frozenset({"admin", "owner"})
COOKIE = "pl_admin"
COOKIE_PATH = "/v1/admin"
TTL = timedelta(hours=8)
"""Абсолютный срок сеанса админки с момента входа."""
IDLE = timedelta(hours=1)
"""Сеанс обрывается, если в админке не было запросов дольше этого."""
TOUCH_EVERY = timedelta(minutes=1)
"""Как часто обновлять отметку последнего действия (чтобы не писать в БД на каждый запрос)."""
TICKET_TTL = timedelta(minutes=15)
"""Билет между первым фактором и кодом: на первую настройку приложения нужно время."""
MAGIC_TTL = timedelta(minutes=10)
TICKET_PURPOSES = {"admin_2fa_pw": "password", "admin_2fa_link": "magic"}
"""Назначение билета второго шага → как пройден первый фактор (пароль или ссылка из письма)."""
MAGIC_PURPOSE = "admin_magic"
AUDIENCE = "platformsol-admin"
SCOPE = "admin"
_KEY_LABEL = b"platformsol:admin-session:v1"
CSRF_HEADER = "x-requested-with"
CSRF_VALUE = "platformsol-admin"
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
AUDIT_TARGET = "admin_login"

LOGIN_FAILED = "Не получилось войти. Проверьте email и пароль."
LINK_FAILED = "Ссылка недействительна или устарела. Запросите новую."
TICKET_FAILED = "Вход устарел. Начните заново: email и пароль или ссылка из письма."
CODE_FAILED = "Код не подошёл. Введите свежий код из приложения — он меняется каждые 30 секунд."
CODE_LOCKED = "Слишком много неверных кодов. Начните вход заново."
NEED_LOGIN = "Нужен вход в админку."
SESSION_ENDED = "Сеанс админки закончился. Войдите снова."
NO_RIGHTS = "Недостаточно прав для админки."
CSRF_FAILED = "Запрос отклонён: нет заголовка админки."
MAIL_OFF = "Отправка писем на сервере не настроена — войдите по паролю."


# --- токен ----------------------------------------------------------------------------------------


def _signing_key() -> bytes:
    """Свой ключ для токенов админки: HMAC(JWT_SECRET, метка). Токены сайта им не подписаны."""
    return hmac.new(settings.jwt_secret.encode(), _KEY_LABEL, hashlib.sha256).digest()


def make_token(user_id: int, sid: str, issued_at: datetime, expires_at: datetime) -> str:
    payload = {
        "sub": str(user_id),
        "sid": sid,
        "scope": SCOPE,
        "aud": AUDIENCE,
        "iat": int(issued_at.timestamp()),
        "exp": int(expires_at.timestamp()),
    }
    return jwt.encode(payload, _signing_key(), algorithm="HS256")


def decode_token(token: str) -> dict[str, Any]:
    """Проверка подписи, аудитории, срока и scope; любая ошибка — 401."""
    try:
        payload: dict[str, Any] = jwt.decode(
            token,
            _signing_key(),
            algorithms=["HS256"],
            audience=AUDIENCE,
            options={"require": ["exp", "iat", "sub", "sid", "aud"]},
        )
    except jwt.PyJWTError as exc:
        raise HTTPException(401, SESSION_ENDED) from exc
    if payload.get("scope") != SCOPE:
        raise HTTPException(401, SESSION_ENDED)
    return payload


def session_problem(row: AdminSession | None, user_id: int, now: datetime) -> str | None:
    """Почему сеанс не годится: unknown / revoked / expired / idle; None — годится."""
    if row is None or row.user_id != user_id:
        return "unknown"
    if row.revoked_at is not None:
        return "revoked"
    if now >= row.expires_at:
        return "expired"
    if now - row.last_seen_at >= IDLE:
        return "idle"
    return None


def is_admin_account(user: User) -> bool:
    """Роль admin/owner или адрес из OWNER_EMAILS (получит owner при первом входе)."""
    return user.role in ADMIN_ROLES or user.email.strip().lower() in settings.owner_email_set


def account_problem(user: User | None) -> str | None:
    """Почему аккаунт не может войти в админку; None — может."""
    if user is None:
        return "unknown_email"
    if user.deleted_at is not None:
        return "deleted"
    if user.blocked_at is not None:
        return "blocked"
    if user.role not in ADMIN_ROLES:
        return "not_admin"
    return None


# --- сеансы ---------------------------------------------------------------------------------------


def open_session(
    db: Session, user: User, request: Request, method: str, now: datetime | None = None
) -> tuple[AdminSession, str]:
    now = now or datetime.now(tz=UTC)
    row = AdminSession(
        id=secrets.token_hex(16),
        user_id=user.id,
        method=method,
        created_at=now,
        last_seen_at=now,
        expires_at=now + TTL,
        ip=ratelimit.client_ip(request)[:64],
        user_agent=(request.headers.get("user-agent") or "")[:255],
    )
    db.add(row)
    return row, make_token(user.id, row.id, now, row.expires_at)


def revoke_user_sessions(db: Session, user_id: int, now: datetime | None = None) -> int:
    """Отозвать все открытые сеансы админки пользователя (commit — снаружи)."""
    now = now or datetime.now(tz=UTC)
    res = db.execute(
        update(AdminSession)
        .where(AdminSession.user_id == user_id, AdminSession.revoked_at.is_(None))
        .values(revoked_at=now)
    )
    return int(getattr(res, "rowcount", 0) or 0)


def set_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        COOKIE,
        token,
        max_age=int(TTL.total_seconds()),
        httponly=True,
        secure=settings.app_env != "local",
        samesite="strict",
        path=COOKIE_PATH,
    )


def clear_cookie(response: Response) -> None:
    response.delete_cookie(
        COOKIE,
        path=COOKIE_PATH,
        httponly=True,
        secure=settings.app_env != "local",
        samesite="strict",
    )


def admin_session(request: Request, db: Session) -> tuple[User, AdminSession]:
    """Пользователь и сеанс по cookie админки. Токен сайта (Authorization) здесь не читается."""
    raw = request.cookies.get(COOKIE)
    if not raw:
        raise HTTPException(401, NEED_LOGIN)
    payload = decode_token(raw)
    try:
        user_id = int(payload["sub"])
    except (TypeError, ValueError) as exc:
        raise HTTPException(401, SESSION_ENDED) from exc
    now = datetime.now(tz=UTC)
    row = db.get(AdminSession, str(payload["sid"]))
    if session_problem(row, user_id, now) is not None or row is None:
        raise HTTPException(401, SESSION_ENDED)
    user = db.get(User, user_id)
    problem = account_problem(user)
    if problem is not None or user is None:
        row.revoked_at = now
        db.commit()
        raise HTTPException(403 if problem == "not_admin" else 401, NO_RIGHTS)
    if request.method not in SAFE_METHODS and request.headers.get(CSRF_HEADER) != CSRF_VALUE:
        raise HTTPException(403, CSRF_FAILED)
    if now - row.last_seen_at >= TOUCH_EVERY:
        row.last_seen_at = now
        db.commit()
    return user, row


def require_admin(request: Request, db: Session = Depends(auth.get_db)) -> User:
    """Зависимость всех /v1/admin/*: только сеанс админки (обычный токен сайта не подходит)."""
    user, _ = admin_session(request, db)
    return user


# --- первый фактор и билет ------------------------------------------------------------------------

_dummy_hash: str | None = None


def check_password(user: User | None, password: str) -> bool:
    """Проверка пароля с одинаковым временем: без пользователя или без пароля — по пустышке."""
    global _dummy_hash
    if user is None or not user.password_hash:
        if _dummy_hash is None:
            _dummy_hash = auth.hash_password(secrets.token_urlsafe(16))
        auth.verify_password(password, _dummy_hash)
        return False
    return auth.verify_password(password, user.password_hash)


def issue_email_token(
    db: Session, user: User, purpose: str, ttl: timedelta, now: datetime | None = None
) -> str:
    now = now or datetime.now(tz=UTC)
    raw = secrets.token_urlsafe(32)
    db.add(
        EmailToken(
            user_id=user.id,
            purpose=purpose,
            token_hash=auth.sha256(raw),
            expires_at=now + ttl,
        )
    )
    return raw


def find_email_token(
    db: Session, raw: str, purposes: frozenset[str] | set[str], now: datetime | None = None
) -> tuple[EmailToken, User] | None:
    """Действующий одноразовый токен одного из назначений и его владелец; иначе None."""
    now = now or datetime.now(tz=UTC)
    row = db.scalar(select(EmailToken).where(EmailToken.token_hash == auth.sha256(raw)))
    if row is None or row.purpose not in purposes or row.used_at is not None:
        return None
    if row.expires_at <= now:
        return None
    user = db.get(User, row.user_id)
    if user is None:
        return None
    return row, user


def issue_ticket(db: Session, user: User, method: str) -> str:
    """Билет второго шага (15 минут, один раз); method — password или magic."""
    purpose = next(k for k, v in TICKET_PURPOSES.items() if v == method)
    return issue_email_token(db, user, purpose, TICKET_TTL)


def mail_ready() -> bool:
    """Письма уходят наружу (Resend) или это локальная разработка (письмо пишется в лог)."""
    return bool(settings.resend_api_key) or settings.app_env == "local"


# --- второй фактор --------------------------------------------------------------------------------


def _matched_step(secret: str, digits: str, now: datetime) -> int | None:
    """Номер 30-секундного шага, которому соответствует код (окно ±1 шаг), или None."""
    totp = pyotp.TOTP(secret)
    base = totp.timecode(now)
    for off in (0, -1, 1):
        if hmac.compare_digest(totp.generate_otp(base + off), digits):
            return base + off
    return None


def check_totp(secret: str, code: str, user_id: int, now: datetime | None = None) -> bool:
    """Код TOTP; один и тот же код (шаг) повторно не принимается — защита от подсмотренного кода."""
    digits = "".join(ch for ch in code if ch.isdigit())
    if len(digits) != 6:
        return False
    step = _matched_step(secret, digits, now or datetime.now(tz=UTC))
    if step is None:
        return False
    return ratelimit.hit(f"admin-totp:{user_id}:{step}", 1, 86400, strict=True)


def check_second_factor(
    row: TwoFactor, code: str, user_id: int, now: datetime | None = None
) -> str | None:
    """«totp», «backup» (резервный код сгорает, commit — снаружи) или None."""
    if check_totp(row.secret, code, user_id, now):
        return "totp"
    h = auth.sha256("".join(ch for ch in code.upper() if ch.isalnum()))
    if h in row.backup_codes:
        row.backup_codes = [x for x in row.backup_codes if x != h]
        return "backup"
    return None


def qr_svg_path(data: str) -> tuple[int, str]:
    """QR-код как SVG-путь (модуль = 1 единица, без рамки): (размер, d). Цвет задаёт страница."""
    qr = segno.make(data, error="m", micro=False)
    rows = qr.matrix
    parts: list[str] = []
    for y, row in enumerate(rows):
        x, n = 0, len(row)
        while x < n:
            if row[x]:
                start = x
                while x < n and row[x]:
                    x += 1
                parts.append(f"M{start} {y}h{x - start}v1h-{x - start}z")
            else:
                x += 1
    return len(rows), "".join(parts)


def setup_payload(secret: str, email: str) -> dict[str, Any]:
    url = twofactor.otpauth_url(secret, email)
    size, path = qr_svg_path(url)
    return {"secret": secret, "otpauth_url": url, "qr": {"size": size, "path": path}}


# --- аудит ----------------------------------------------------------------------------------------


def mask_email(email: str) -> str:
    """Адрес для аудита неизвестных аккаунтов: первая буква и домен (o***@example.com)."""
    local, sep, domain = email.strip().lower().partition("@")
    if not sep or not local:
        return "***"
    return f"{local[0]}***@{domain[:120]}"


def audit(db: Session, request: Request, action: str, user: User | None, **extra: Any) -> None:
    """Строка аудита входа в админку: без паролей, кодов и токенов; с IP и браузером."""
    payload: dict[str, Any] = {
        "ip": ratelimit.client_ip(request)[:64],
        "ua": (request.headers.get("user-agent") or "")[:200],
        **extra,
    }
    db.add(
        AdminAudit(
            actor_id=user.id if user is not None else None,
            action=action,
            target=AUDIT_TARGET,
            payload=payload,
        )
    )
