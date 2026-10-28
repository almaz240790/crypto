"""Аутентификация (план 3.2, 6.3, 6.8): email+пароль (Argon2id), magic link, Google OAuth,
Telegram Login Widget; JWT access 15 минут + refresh в httpOnly cookie с ротацией.

Отправка писем — через ``app.mail`` (в local/staging письма пишутся в лог).
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.db import SessionLocal
from app.models import AuthIdentity, RefreshToken, RiskProfile, User, Watchlist

_hasher = PasswordHasher()
ACCESS_TTL = timedelta(minutes=15)
REFRESH_TTL = timedelta(days=30)
REFRESH_COOKIE = "refresh_token"


def get_db() -> Any:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# --- пароли и токены ---------------------------------------------------------------------------


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str | None) -> bool:
    if not password_hash:
        return False
    try:
        return _hasher.verify(password_hash, password)
    except VerifyMismatchError:
        return False


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def make_access_token(user: User) -> str:
    now = datetime.now(tz=UTC)
    payload = {
        "sub": str(user.id),
        "role": user.role,
        "iat": int(now.timestamp()),
        "exp": int((now + ACCESS_TTL).timestamp()),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


def decode_access_token(token: str) -> dict[str, Any]:
    try:
        return jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError as exc:
        raise HTTPException(401, "недействительный токен") from exc


def issue_refresh(db: Session, user: User, user_agent: str | None) -> str:
    raw = secrets.token_urlsafe(48)
    db.add(
        RefreshToken(
            user_id=user.id,
            token_hash=sha256(raw),
            expires_at=datetime.now(tz=UTC) + REFRESH_TTL,
            user_agent=(user_agent or "")[:255],
        )
    )
    db.commit()
    return raw


def rotate_refresh(db: Session, raw: str, user_agent: str | None) -> tuple[User, str]:
    row = db.scalar(select(RefreshToken).where(RefreshToken.token_hash == sha256(raw)))
    now = datetime.now(tz=UTC)
    if row is None or row.revoked_at is not None or row.expires_at < now:
        raise HTTPException(401, "сессия истекла")
    row.revoked_at = now
    user = db.get(User, row.user_id)
    if user is None or user.deleted_at is not None:
        raise HTTPException(401, "пользователь не найден")
    return user, issue_refresh(db, user, user_agent)


def revoke_refresh(db: Session, raw: str) -> None:
    row = db.scalar(select(RefreshToken).where(RefreshToken.token_hash == sha256(raw)))
    if row and row.revoked_at is None:
        row.revoked_at = datetime.now(tz=UTC)
        db.commit()


# --- пользователи -------------------------------------------------------------------------------


def create_user(db: Session, email: str, password: str | None, name: str | None = None) -> User:
    user = User(
        email=email.lower().strip(),
        password_hash=hash_password(password) if password else None,
        name=name,
        terms_accepted_at=datetime.now(tz=UTC),
    )
    db.add(user)
    db.flush()
    db.add(RiskProfile(user_id=user.id))
    db.add(Watchlist(user_id=user.id))
    db.commit()
    return user


def find_or_link_identity(
    db: Session,
    provider: str,
    provider_user_id: str,
    email: str | None,
    name: str | None,
    data: dict[str, Any],
) -> User:
    """Вход через провайдера: существующая связка → пользователь; иначе по email; иначе новый."""
    ident = db.scalar(
        select(AuthIdentity).where(
            AuthIdentity.provider == provider, AuthIdentity.provider_user_id == provider_user_id
        )
    )
    if ident:
        user = db.get(User, ident.user_id)
        assert user is not None
        return user
    user = db.scalar(select(User).where(User.email == email.lower())) if email else None
    if user is None:
        pseudo_email = email or f"{provider}-{provider_user_id}@users.platform.local"
        user = create_user(db, pseudo_email, None, name)
        if email:
            user.email_verified_at = datetime.now(tz=UTC)  # email подтверждён провайдером
    db.add(
        AuthIdentity(
            user_id=user.id, provider=provider, provider_user_id=provider_user_id, data=data
        )
    )
    db.commit()
    return user


# --- внешние провайдеры ----------------------------------------------------------------------


def verify_telegram_payload(
    payload: dict[str, Any], bot_token: str, max_age_sec: int = 86400
) -> bool:
    """Проверка подписи Telegram Login Widget (HMAC-SHA256 по секрету sha256(bot_token))."""
    received = payload.get("hash")
    if not received:
        return False
    pairs = sorted(f"{k}={v}" for k, v in payload.items() if k != "hash")
    check = "\n".join(pairs).encode()
    secret = hashlib.sha256(bot_token.encode()).digest()
    expected = hmac.new(secret, check, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, str(received)):
        return False
    try:
        auth_date = int(payload.get("auth_date", 0))
    except (TypeError, ValueError):
        return False
    return datetime.now(tz=UTC).timestamp() - auth_date <= max_age_sec


def google_exchange(code: str, redirect_uri: str) -> dict[str, Any]:
    """Код авторизации → профиль пользователя Google (sub, email, name)."""
    if not settings.google_client_id or not settings.google_client_secret:
        raise HTTPException(501, "вход через Google не настроен")
    token = httpx.post(
        "https://oauth2.googleapis.com/token",
        data={
            "code": code,
            "client_id": settings.google_client_id,
            "client_secret": settings.google_client_secret,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
        },
        timeout=15,
    )
    if token.status_code != 200:
        raise HTTPException(401, "Google отклонил код авторизации")
    info = httpx.get(
        "https://openidconnect.googleapis.com/v1/userinfo",
        headers={"Authorization": f"Bearer {token.json()['access_token']}"},
        timeout=15,
    )
    if info.status_code != 200:
        raise HTTPException(401, "не удалось получить профиль Google")
    profile: dict[str, Any] = info.json()
    return profile


# --- зависимости FastAPI -------------------------------------------------------------------------


def _api_key_user(request: Request, db: Session, raw: str) -> User:
    """Вход по API-ключу (план 3.10): только GET, лимит запросов на ключ, только Premium."""
    from app import apikeys, ratelimit
    from app.entitlements import entitlements_for

    if request.method != "GET":
        raise HTTPException(403, "API-ключ даёт только чтение")
    user = apikeys.find_user(db, raw)
    if user is None:
        raise HTTPException(401, "неверный или отозванный API-ключ")
    if not entitlements_for(db, user).api_access:
        raise HTTPException(403, "API-ключи доступны на тарифе Premium")
    if not ratelimit.hit(f"apikey:{sha256(raw)[:16]}", *apikeys.API_RATE):
        raise HTTPException(429, "лимит запросов по ключу исчерпан, подождите минуту")
    return user


def current_user(request: Request, db: Session = Depends(get_db)) -> User:
    api_key = request.headers.get("x-api-key")
    if api_key:
        return _api_key_user(request, db, api_key.strip())
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("bearer "):
        raise HTTPException(401, "нужен токен")
    payload = decode_access_token(header[7:])
    user = db.get(User, int(payload["sub"]))
    if user is None or user.deleted_at is not None:
        raise HTTPException(401, "пользователь не найден")
    if user.blocked_at is not None:
        raise HTTPException(403, "аккаунт заблокирован")
    return user


def promote_owner(user: User, owner_emails: set[str]) -> bool:
    """Роль owner для адресов из OWNER_EMAILS. Вызывается при входе, обновлении токена и /auth/me,
    чтобы владелец получил права, даже если адрес добавили в настройки уже после его входа.
    Адрес владельца считается подтверждённым: его вписал в настройки сервера сам владелец."""
    if user.email.strip().lower() not in owner_emails:
        return False
    changed = False
    if user.role == "user":
        user.role = "owner"
        changed = True
    if user.email_verified_at is None:
        user.email_verified_at = datetime.now(tz=UTC)
        changed = True
    return changed


def require_role(*roles: str) -> Any:
    def dep(user: User = Depends(current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(403, "недостаточно прав")
        return user

    return dep
