"""Отдельный вход в админку (ADR-0011).

Сеанс админки не связан с сессией сайта:

- токен — JWT с ``scope=admin`` и своей аудиторией, подписан ключом, выведенным из JWT_SECRET
  (HMAC с меткой): токен сайта не проходит проверку админки, а токен админки — проверку сайта;
- лежит в httpOnly-cookie ``pl_admin`` с путём ``/v1/admin`` и SameSite=Strict: браузер не
  отправляет её на остальные адреса API, скрипт страницы её не видит;
- живёт 8 часов с входа и обрывается после 1 часа без действий; refresh-токена нет;
- каждый запрос сверяется со строкой ``admin_sessions``: выход, смена пароля и отключение 2FA
  отзывают сеансы на сервере сразу; причина закрытия уходит странице входа (``X-Admin-Ended``).

Изменяющие запросы требуют заголовок ``X-Requested-With: platformsol-admin`` (защита от CSRF
поверх SameSite). Вход: пароль или ссылка из письма → обязательный код TOTP (или резервный код).
Первая настройка кода — только после ссылки из письма (или одноразовой ссылки с сервера):
одного пароля для неё мало. Браузер, где админ уже входил, получает cookie устройства
``pl_admin_device``: лимит попыток по адресу его не блокирует (чужой перебор не запирает владельца).
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
import segno
from fastapi import Depends, HTTPException, Request, Response
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app import auth, ratelimit, twofactor
from app.config import settings
from app.models import AdminAudit, AdminSession, EmailToken, TwoFactor, User

ROTATE_TTL = timedelta(minutes=15)
"""Сколько ждёт подтверждения новый секрет при переносе кода на другой телефон."""
DEVICE_COOKIE = "pl_admin_device"
DEVICE_PATH = "/v1/admin/auth"
DEVICE_TTL = timedelta(days=180)
ENDED_HEADER = "X-Admin-Ended"
"""Почему сеанс админки закрыт: idle / expired / logout / password / 2fa / role / blocked / gone."""

ADMIN_ROLES = frozenset({"admin", "owner"})
COOKIE = "pl_admin"
COOKIE_PATH = "/v1/admin"
TTL = timedelta(hours=8)
"""Абсолютный срок сеанса админки с момента входа."""
IDLE = timedelta(hours=1)
"""Сеанс обрывается, если в админке не было запросов дольше этого."""
COOKIE_GRACE = timedelta(days=1)
"""Сколько cookie живёт после конца сеанса: чтобы API ответил «прошло 8 часов», а не «нет входа»."""
TOUCH_EVERY = timedelta(minutes=1)
"""Как часто обновлять отметку последнего действия (чтобы не писать в БД на каждый запрос)."""
TICKET_TTL = timedelta(minutes=15)
"""Билет между первым фактором и кодом: на первую настройку приложения нужно время."""
MAGIC_TTL = timedelta(minutes=10)
TICKET_PURPOSES = {"admin_2fa_pw": "password", "admin_2fa_link": "magic"}
"""Назначение билета второго шага → как пройден первый фактор (пароль или ссылка из письма)."""
MAGIC_PURPOSE = "admin_magic"
AUDIENCE = "platformsol-admin"
DEVICE_AUDIENCE = "platformsol-admin-device"
ROTATE_AUDIENCE = "platformsol-admin-rotate"
SCOPE = "admin"
_KEY_LABEL = b"platformsol:admin-session:v1"
_DEVICE_LABEL = b"platformsol:admin-device:v1"
_ROTATE_LABEL = b"platformsol:admin-rotate:v1"
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
SETUP_NEEDS_LINK = "Первая настройка кода открывается только по ссылке из письма."
PROXY_ONLY = "Админка открывается только через сайт."
ROTATE_FAILED = "Перенос кода устарел. Начните заново."
ENDED_TEXT = {
    "idle": "Сеанс админки закончился: больше часа без действий.",
    "expired": "Сеанс админки закончился: прошло 8 часов с входа.",
    "logout": "Вы вышли из админки (в этой или другой вкладке).",
    "password": "Сеанс админки закрыт: пароль аккаунта изменён.",
    "2fa": "Сеанс админки закрыт: защита кодом изменена.",
    "role": "Сеанс админки закрыт: у аккаунта больше нет прав админки.",
    "blocked": "Сеанс админки закрыт: аккаунт заблокирован или удалён.",
    "gone": SESSION_ENDED,
}


# --- токен ----------------------------------------------------------------------------------------


def _signing_key(label: bytes = _KEY_LABEL) -> bytes:
    """Свой ключ для токенов админки: HMAC(JWT_SECRET, метка). Токены сайта им не подписаны."""
    return hmac.new(settings.jwt_secret.encode(), label, hashlib.sha256).digest()


def ended(reason: str, status: int = 401) -> HTTPException:
    """Ошибка «сеанс закрыт» с причиной для страницы входа (заголовок X-Admin-Ended)."""
    return HTTPException(
        status, ENDED_TEXT.get(reason, SESSION_ENDED), headers={ENDED_HEADER: reason}
    )


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


def token_expired(token: str) -> bool:
    """Токен настоящий (подпись, аудитория, scope), но срок вышел: сеанс прожил свои 8 часов."""
    try:
        payload = jwt.decode(
            token,
            _signing_key(),
            algorithms=["HS256"],
            audience=AUDIENCE,
            options={"require": ["exp", "sub", "sid", "aud"], "verify_exp": False},
        )
    except jwt.PyJWTError:
        return False
    return payload.get("scope") == SCOPE and int(payload["exp"]) <= datetime.now(tz=UTC).timestamp()


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


def revoke_user_sessions(
    db: Session,
    user_id: int,
    reason: str,
    now: datetime | None = None,
    keep: str | None = None,
) -> int:
    """Отозвать открытые сеансы админки пользователя (кроме ``keep``); commit — снаружи.

    ``reason`` — logout / password / 2fa / role / blocked: страница входа объяснит владельцу."""
    now = now or datetime.now(tz=UTC)
    q = update(AdminSession).where(
        AdminSession.user_id == user_id, AdminSession.revoked_at.is_(None)
    )
    if keep is not None:
        q = q.where(AdminSession.id != keep)
    res = db.execute(q.values(revoked_at=now, revoked_reason=reason[:16]))
    return int(getattr(res, "rowcount", 0) or 0)


def set_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        COOKIE,
        token,
        max_age=int((TTL + COOKIE_GRACE).total_seconds()),
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


def site_proxy_only(request: Request) -> None:
    """Зависимость всех /v1/admin/*: при заданном PROXY_SECRET — только через прокси сайта.

    Так IP для лимитов и аудита берётся у прокси, а не из заголовка клиента, и админка не
    открывается напрямую по адресу API."""
    if settings.proxy_secret and not ratelimit.from_site_proxy(request):
        raise HTTPException(403, PROXY_ONLY)


def admin_session(request: Request, db: Session) -> tuple[User, AdminSession]:
    """Пользователь и сеанс по cookie админки. Токен сайта (Authorization) здесь не читается."""
    raw = request.cookies.get(COOKIE)
    if not raw:
        raise HTTPException(401, NEED_LOGIN)
    try:
        payload = decode_token(raw)
        user_id = int(payload["sub"])
    except (HTTPException, TypeError, ValueError) as exc:
        raise ended("expired" if token_expired(raw) else "gone") from exc
    now = datetime.now(tz=UTC)
    row = db.get(AdminSession, str(payload["sid"]))
    problem = session_problem(row, user_id, now)
    if problem is not None or row is None:
        if problem == "revoked" and row is not None:
            raise ended(row.revoked_reason or "gone")
        raise ended(problem if problem in ("idle", "expired") else "gone")
    user = db.get(User, user_id)
    acc = account_problem(user)
    if acc is not None or user is None:
        reason = "role" if acc == "not_admin" else "blocked"
        row.revoked_at, row.revoked_reason = now, reason
        db.commit()
        raise ended(reason, 403 if acc == "not_admin" else 401)
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
    """Действующий одноразовый токен одного из назначений и его владелец; иначе None.

    Строка берётся под блокировкой до commit: второй запрос с тем же токеном ждёт и видит его
    уже использованным (двойного входа по одной ссылке или билету нет)."""
    now = now or datetime.now(tz=UTC)
    row = db.scalar(
        select(EmailToken)
        .where(EmailToken.token_hash == auth.sha256(raw))
        .with_for_update()
        .execution_options(populate_existing=True)
    )
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


def can_receive_link(user: User | None) -> bool:
    """Кому можно отправить ссылку входа в админку: админ/владелец или адрес из OWNER_EMAILS
    (ссылка уходит на сам адрес — она и подтверждает почту), не удалён и не заблокирован."""
    return (
        user is not None
        and user.deleted_at is None
        and user.blocked_at is None
        and is_admin_account(user)
    )


def link_text(raw: str, minutes: int) -> str:
    return (
        f"Ссылка для входа в админку ({minutes} минут, один раз): "
        f"{settings.frontend_url}/admin/login?link={raw}\n\n"
        "После неё понадобится код из приложения-аутентификатора (в первый раз — его настройка). "
        "Если вы не запрашивали вход — просто удалите письмо."
    )


# --- устройство, где админ уже входил -------------------------------------------------------------


def make_device(user_id: int, nonce: str | None = None) -> str:
    now = datetime.now(tz=UTC)
    payload = {
        "sub": str(user_id),
        "nonce": nonce or secrets.token_hex(12),
        "aud": DEVICE_AUDIENCE,
        "iat": int(now.timestamp()),
        "exp": int((now + DEVICE_TTL).timestamp()),
    }
    return jwt.encode(payload, _signing_key(_DEVICE_LABEL), algorithm="HS256")


def read_device(request: Request) -> tuple[int, str] | None:
    """(пользователь, метка устройства) по cookie устройства; иначе None. Не даёт входа —
    только снимает лимит по адресу для браузера, где этот админ уже проходил второй фактор."""
    raw = request.cookies.get(DEVICE_COOKIE)
    if not raw:
        return None
    try:
        p = jwt.decode(
            raw,
            _signing_key(_DEVICE_LABEL),
            algorithms=["HS256"],
            audience=DEVICE_AUDIENCE,
            options={"require": ["exp", "sub", "nonce", "aud"]},
        )
        return int(p["sub"]), str(p["nonce"])[:32]
    except (jwt.PyJWTError, TypeError, ValueError):
        return None


def set_device_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        DEVICE_COOKIE,
        token,
        max_age=int(DEVICE_TTL.total_seconds()),
        httponly=True,
        secure=settings.app_env != "local",
        samesite="strict",
        path=DEVICE_PATH,
    )


def limit_key(scope: str, email: str, user: User | None, device: tuple[int, str] | None) -> str:
    """Ключ лимита первого шага: своё устройство админа — по метке устройства, иначе — по адресу."""
    if device is not None and user is not None and device[0] == user.id:
        return f"{scope}:dev:{device[1]}"
    return f"{scope}:s:{email}"


def mail_ready() -> bool:
    """Письма уходят наружу (Resend) или это локальная разработка (письмо пишется в лог)."""
    return bool(settings.resend_api_key) or settings.app_env == "local"


# --- второй фактор --------------------------------------------------------------------------------


def take_code_attempt(user_id: int) -> str:
    """Занять попытку ввода кода для аккаунта (10 за 15 минут) или 429. Возвращает ключ попытки:
    верный код возвращает её через ``ratelimit.give_back`` — считаются только неверные коды, и
    владелец не запирает себя обычными входами. Общий счётчик для входа, действий с кодом
    внутри админки и выдачи роли."""
    limit, window = ratelimit.ADMIN_CODE_PER_USER
    ok, bucket = ratelimit.take(f"admin-code:s:{user_id}", limit, window)
    if not ok:
        raise HTTPException(429, f"слишком много попыток, подождите {max(1, window // 60)} мин")
    return bucket


def check_second_factor(row: TwoFactor, code: str, now: datetime | None = None) -> str | None:
    """«totp», «backup» (резервный код сгорает) или None; код TOTP — один раз (общая отметка
    шага с сайтом). Строку брать через ``twofactor.locked``; commit — снаружи."""
    return twofactor.use_code(row, code, now)


# --- перенос кода на другой телефон ---------------------------------------------------------------


def make_rotation(user_id: int, sid: str, secret: str) -> str:
    """Новый секрет ждёт подтверждения кодом (15 минут, только в этом сеансе админки)."""
    now = datetime.now(tz=UTC)
    payload = {
        "sub": str(user_id),
        "sid": sid,
        "sec": secret,
        "aud": ROTATE_AUDIENCE,
        "iat": int(now.timestamp()),
        "exp": int((now + ROTATE_TTL).timestamp()),
    }
    return jwt.encode(payload, _signing_key(_ROTATE_LABEL), algorithm="HS256")


def read_rotation(token: str, user_id: int, sid: str) -> str | None:
    try:
        p = jwt.decode(
            token,
            _signing_key(_ROTATE_LABEL),
            algorithms=["HS256"],
            audience=ROTATE_AUDIENCE,
            options={"require": ["exp", "sub", "sid", "sec", "aud"]},
        )
    except jwt.PyJWTError:
        return None
    if p.get("sub") != str(user_id) or p.get("sid") != sid:
        return None
    return str(p["sec"])


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


ANON_AUDIT_PER_MINUTE = 30
"""Строк аудита без пользователя (неизвестный адрес) в минуту: перебор не вытеснит из журнала
настоящие события; сверх лимита попытка всё равно отклоняется, просто без строки."""


def audit(db: Session, request: Request, action: str, user: User | None, **extra: Any) -> None:
    """Строка аудита входа в админку: без паролей, кодов и токенов; с IP и браузером."""
    if user is None and not ratelimit.hit("admin-audit-anon", ANON_AUDIT_PER_MINUTE, 60):
        return
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
