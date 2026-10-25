"""/v1/auth — регистрация, вход, обновление сессии, выход, Google, Telegram, magic link."""

from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import auth
from app.config import settings
from app.mail import send_mail
from app.models import EmailToken, RiskProfile, User

router = APIRouter(prefix="/v1/auth", tags=["auth"])


class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=10, max_length=128)
    name: str | None = Field(default=None, max_length=100)
    country: str | None = Field(default=None, min_length=2, max_length=2)
    marketing_opt_in: bool = False


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int = int(auth.ACCESS_TTL.total_seconds())


class UserOut(BaseModel):
    id: int
    email: str
    name: str | None
    email_verified: bool
    role: str
    locale: str
    timezone: str
    theme: str
    risk: dict[str, Any]


def _user_out(user: User, risk: RiskProfile | None) -> UserOut:
    return UserOut(
        id=user.id,
        email=user.email,
        name=user.name,
        email_verified=user.email_verified_at is not None,
        role=user.role,
        locale=user.locale,
        timezone=user.timezone,
        theme=user.theme,
        risk={
            "deposit": str(risk.deposit) if risk and risk.deposit is not None else None,
            "risk_pct": str(risk.risk_pct) if risk else "1.00",
            "exchange": risk.exchange if risk else "binance",
            "market_type": risk.market_type if risk else "futures",
            "default_leverage": risk.default_leverage if risk else 3,
            "experience": risk.experience if risk else None,
        },
    )


def _set_refresh_cookie(response: Response, raw: str) -> None:
    response.set_cookie(
        auth.REFRESH_COOKIE,
        raw,
        max_age=int(auth.REFRESH_TTL.total_seconds()),
        httponly=True,
        secure=settings.app_env != "local",
        samesite="lax",
        path="/v1/auth",
    )


def _issue(db: Session, user: User, request: Request, response: Response) -> TokenOut:
    if user.role == "user" and user.email.lower() in settings.owner_email_set:
        user.role = "owner"
        db.commit()
    raw = auth.issue_refresh(db, user, request.headers.get("user-agent"))
    _set_refresh_cookie(response, raw)
    return TokenOut(access_token=auth.make_access_token(user))


def _email_token(db: Session, user: User, purpose: str, ttl: timedelta) -> str:
    raw = secrets.token_urlsafe(32)
    db.add(
        EmailToken(
            user_id=user.id,
            purpose=purpose,
            token_hash=auth.sha256(raw),
            expires_at=datetime.now(tz=UTC) + ttl,
        )
    )
    db.commit()
    return raw


def _consume_email_token(db: Session, raw: str, purpose: str) -> User:
    row = db.scalar(select(EmailToken).where(EmailToken.token_hash == auth.sha256(raw)))
    now = datetime.now(tz=UTC)
    if row is None or row.purpose != purpose or row.used_at is not None or row.expires_at < now:
        raise HTTPException(400, "ссылка недействительна или устарела")
    row.used_at = now
    user = db.get(User, row.user_id)
    if user is None:
        raise HTTPException(400, "пользователь не найден")
    return user


@router.post("/register", response_model=TokenOut, status_code=201)
def register(
    body: RegisterIn, request: Request, response: Response, db: Session = Depends(auth.get_db)
) -> TokenOut:
    if db.scalar(select(User).where(User.email == body.email.lower())):
        raise HTTPException(409, "email уже зарегистрирован")
    user = auth.create_user(db, body.email, body.password, body.name)
    user.country = body.country
    user.marketing_opt_in = body.marketing_opt_in
    db.commit()
    raw = _email_token(db, user, "verify", timedelta(days=3))
    send_mail(
        user.email,
        "Подтвердите email",
        f"Подтвердите адрес: {settings.frontend_url}/verify?token={raw}\n\n"
        "Если вы не регистрировались, просто проигнорируйте письмо.",
    )
    return _issue(db, user, request, response)


@router.post("/login", response_model=TokenOut)
def login(
    body: LoginIn, request: Request, response: Response, db: Session = Depends(auth.get_db)
) -> TokenOut:
    user = db.scalar(select(User).where(User.email == body.email.lower()))
    if (
        user is None
        or user.deleted_at is not None
        or not auth.verify_password(body.password, user.password_hash)
    ):
        raise HTTPException(401, "неверный email или пароль")
    return _issue(db, user, request, response)


@router.post("/refresh", response_model=TokenOut)
def refresh(request: Request, response: Response, db: Session = Depends(auth.get_db)) -> TokenOut:
    raw = request.cookies.get(auth.REFRESH_COOKIE)
    if not raw:
        raise HTTPException(401, "нет сессии")
    user, new_raw = auth.rotate_refresh(db, raw, request.headers.get("user-agent"))
    _set_refresh_cookie(response, new_raw)
    return TokenOut(access_token=auth.make_access_token(user))


@router.post("/logout", status_code=204)
def logout(request: Request, response: Response, db: Session = Depends(auth.get_db)) -> Response:
    raw = request.cookies.get(auth.REFRESH_COOKIE)
    if raw:
        auth.revoke_refresh(db, raw)
    response.delete_cookie(auth.REFRESH_COOKIE, path="/v1/auth")
    return Response(status_code=204)


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(auth.current_user), db: Session = Depends(auth.get_db)) -> UserOut:
    return _user_out(user, db.get(RiskProfile, user.id))


class VerifyIn(BaseModel):
    token: str


@router.post("/verify", status_code=204)
def verify_email(body: VerifyIn, db: Session = Depends(auth.get_db)) -> Response:
    user = _consume_email_token(db, body.token, "verify")
    user.email_verified_at = datetime.now(tz=UTC)
    db.commit()
    return Response(status_code=204)


class MagicIn(BaseModel):
    email: EmailStr


@router.post("/magic", status_code=202)
def magic_link(body: MagicIn, db: Session = Depends(auth.get_db)) -> dict[str, str]:
    """Ссылка для входа без пароля; ответ одинаковый, существует ли email (не раскрываем)."""
    user = db.scalar(select(User).where(User.email == body.email.lower()))
    if user and user.deleted_at is None:
        raw = _email_token(db, user, "magic", timedelta(minutes=15))
        send_mail(
            user.email,
            "Вход в Platform",
            f"Ссылка для входа (15 минут): {settings.frontend_url}/magic?token={raw}",
        )
    return {"status": "если адрес зарегистрирован, письмо отправлено"}


@router.post("/magic/consume", response_model=TokenOut)
def magic_consume(
    body: VerifyIn, request: Request, response: Response, db: Session = Depends(auth.get_db)
) -> TokenOut:
    user = _consume_email_token(db, body.token, "magic")
    if user.email_verified_at is None:
        user.email_verified_at = datetime.now(tz=UTC)
    db.commit()
    return _issue(db, user, request, response)


class ResetRequestIn(BaseModel):
    email: EmailStr


@router.post("/reset", status_code=202)
def reset_request(body: ResetRequestIn, db: Session = Depends(auth.get_db)) -> dict[str, str]:
    user = db.scalar(select(User).where(User.email == body.email.lower()))
    if user and user.deleted_at is None:
        raw = _email_token(db, user, "reset", timedelta(hours=1))
        send_mail(
            user.email,
            "Сброс пароля",
            f"Задать новый пароль (1 час): {settings.frontend_url}/reset?token={raw}",
        )
    return {"status": "если адрес зарегистрирован, письмо отправлено"}


class ResetIn(BaseModel):
    token: str
    password: str = Field(min_length=10, max_length=128)


@router.post("/reset/confirm", status_code=204)
def reset_confirm(body: ResetIn, db: Session = Depends(auth.get_db)) -> Response:
    user = _consume_email_token(db, body.token, "reset")
    user.password_hash = auth.hash_password(body.password)
    db.commit()
    return Response(status_code=204)


class TelegramIn(BaseModel):
    id: int
    first_name: str | None = None
    last_name: str | None = None
    username: str | None = None
    photo_url: str | None = None
    auth_date: int
    hash: str


@router.post("/telegram", response_model=TokenOut)
def telegram_login(
    body: TelegramIn, request: Request, response: Response, db: Session = Depends(auth.get_db)
) -> TokenOut:
    if not settings.telegram_bot_token:
        raise HTTPException(501, "вход через Telegram не настроен")
    payload = {k: v for k, v in body.model_dump().items() if v is not None}
    if not auth.verify_telegram_payload(payload, settings.telegram_bot_token):
        raise HTTPException(401, "подпись Telegram неверна")
    name = " ".join(x for x in (body.first_name, body.last_name) if x) or body.username
    user = auth.find_or_link_identity(
        db, "telegram", str(body.id), None, name, {"username": body.username}
    )
    return _issue(db, user, request, response)


class GoogleIn(BaseModel):
    code: str
    redirect_uri: str


@router.post("/google", response_model=TokenOut)
def google_login(
    body: GoogleIn, request: Request, response: Response, db: Session = Depends(auth.get_db)
) -> TokenOut:
    info = auth.google_exchange(body.code, body.redirect_uri)
    if not info.get("email_verified", False):
        raise HTTPException(401, "email в Google не подтверждён")
    user = auth.find_or_link_identity(
        db,
        "google",
        str(info["sub"]),
        info.get("email"),
        info.get("name"),
        {"picture": info.get("picture")},
    )
    return _issue(db, user, request, response)
