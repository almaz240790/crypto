"""/v1/admin/auth — отдельный вход в админку (ADR-0011).

Шаги: ``/login`` (email + пароль) или ``/magic`` → ``/magic/consume`` (ссылка из письма) дают
билет; затем ``/verify`` (код TOTP или резервный код) или, если 2FA ещё не включена,
``/setup`` → ``/setup/confirm`` (QR-код, первый код, резервные коды). Только после второго
фактора выдаётся cookie админки. Ошибки первого шага одинаковые для неизвестного адреса,
неверного пароля и аккаунта без прав (без перебора адресов). Каждая попытка — строка аудита.

Коды ответов для страницы входа: 401 — неверные данные (можно повторить), 409 — шаг не тот
(2FA уже включена или ещё нет), 410 — билет недействителен или сгорел (начать вход заново).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, NoReturn

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import admin_auth as aa
from app import auth, ratelimit, sessions, twofactor
from app.config import settings
from app.mail import send_mail
from app.models import AdminSession, EmailToken, TwoFactor, User

router = APIRouter(prefix="/v1/admin/auth", tags=["admin-auth"])


class LoginIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=256)


class MagicIn(BaseModel):
    email: EmailStr


class LinkIn(BaseModel):
    link: str = Field(min_length=10, max_length=200)


class TicketIn(BaseModel):
    ticket: str = Field(min_length=10, max_length=200)


class CodeIn(BaseModel):
    ticket: str = Field(min_length=10, max_length=200)
    code: str = Field(min_length=6, max_length=16)


def _step_out(db: Session, user: User, method: str) -> dict[str, Any]:
    """Первый фактор пройден: билет на второй шаг; setup — если 2FA ещё не включена."""
    enabled = twofactor.is_enabled(db.get(TwoFactor, user.id))
    ticket = aa.issue_ticket(db, user, method)
    return {"step": "code" if enabled else "setup", "ticket": ticket, "email": user.email}


def _me_out(user: User, row: AdminSession, db: Session) -> dict[str, Any]:
    tf = db.get(TwoFactor, user.id)
    return {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "role": user.role,
        "method": row.method,
        "started_at": row.created_at.isoformat(),
        "expires_at": row.expires_at.isoformat(),
        "idle_minutes": int(aa.IDLE.total_seconds() // 60),
        "backup_codes_left": len(tf.backup_codes) if tf is not None and tf.enabled_at else 0,
    }


def _ticket_user(db: Session, raw: str, request: Request) -> tuple[EmailToken, User]:
    """Билет второго шага → (строка билета, админ). Иначе — 401 «начните заново»."""
    found = aa.find_email_token(db, raw, set(aa.TICKET_PURPOSES))
    if found is None:
        aa.audit(db, request, "admin_login.ticket_invalid", None)
        db.commit()
        raise HTTPException(410, aa.TICKET_FAILED)
    row, user = found
    problem = aa.account_problem(user)
    if problem is not None:
        row.used_at = datetime.now(tz=UTC)
        aa.audit(db, request, "admin_login.failed", user, reason=problem, stage="code")
        db.commit()
        raise HTTPException(410, aa.TICKET_FAILED)
    return row, user


def _notice(email: str, request: Request, what: str) -> tuple[str, str, str]:
    """Письмо владельцу аккаунта о входе/настройке (без секретов): адрес, тема, текст."""
    now = datetime.now(tz=UTC).strftime("%d.%m.%Y %H:%M UTC")
    device = sessions.device_label(request.headers.get("user-agent"))
    ip = ratelimit.client_ip(request)
    text = (
        f"{what}: {now}, IP {ip}, {device}.\n\n"
        "Если это были не вы — смените пароль на сайте (Настройки → Пароль): "
        "это сразу закроет все сеансы админки."
    )
    return email, f"PlatformSol: {what.lower()}", text


def _finish(
    db: Session,
    request: Request,
    response: Response,
    background: BackgroundTasks,
    ticket_row: EmailToken,
    user: User,
    what: str,
    **extra: Any,
) -> dict[str, Any]:
    """Второй фактор пройден: билет сгорает, открывается сеанс, ставится cookie, пишется аудит."""
    method = aa.TICKET_PURPOSES.get(ticket_row.purpose, "password")
    ticket_row.used_at = datetime.now(tz=UTC)
    row, token = aa.open_session(db, user, request, method)
    aa.audit(db, request, "admin_login.success", user, method=method, session=row.id[:8], **extra)
    db.commit()
    aa.set_cookie(response, token)
    background.add_task(send_mail, *_notice(user.email, request, what))
    return _me_out(user, row, db)


@router.get("/config")
def config() -> dict[str, Any]:
    """Что показать на странице входа: работает ли вход по ссылке, сроки сеанса."""
    return {
        "mail": aa.mail_ready(),
        "idle_minutes": int(aa.IDLE.total_seconds() // 60),
        "session_hours": int(aa.TTL.total_seconds() // 3600),
    }


@router.post("/login")
def login(body: LoginIn, request: Request, db: Session = Depends(auth.get_db)) -> dict[str, Any]:
    email = body.email.strip().lower()
    ratelimit.guard(
        request,
        "admin-login",
        email,
        ratelimit.ADMIN_LOGIN_PER_EMAIL,
        ratelimit.ADMIN_LOGIN_PER_IP,
        strict=True,
    )
    user = db.scalar(select(User).where(User.email == email))
    ok = aa.check_password(user, body.password)
    if ok and user is not None and auth.promote_owner(user, settings.owner_email_set):
        db.commit()
    if user is not None and not ok:
        problem: str | None = "bad_password" if user.password_hash else "no_password"
    else:
        problem = aa.account_problem(user)
    if problem is not None:
        extra = {"email": aa.mask_email(email)} if user is None else {}
        aa.audit(db, request, "admin_login.failed", user, reason=problem, stage="password", **extra)
        db.commit()
        raise HTTPException(401, aa.LOGIN_FAILED)
    assert user is not None
    out = _step_out(db, user, "password")
    aa.audit(db, request, "admin_login.password_ok", user, next=out["step"])
    db.commit()
    return out


@router.post("/magic", status_code=202)
def magic(
    body: MagicIn,
    request: Request,
    background: BackgroundTasks,
    db: Session = Depends(auth.get_db),
) -> dict[str, str]:
    """Ссылка на почту для аккаунтов без пароля (вход через Google или по ссылке).

    Ответ одинаковый для любого адреса; письмо уходит в фоне, чтобы время ответа не выдавало,
    есть ли у адреса доступ к админке."""
    email = body.email.strip().lower()
    ratelimit.guard(
        request,
        "admin-magic",
        email,
        ratelimit.ADMIN_MAIL_PER_EMAIL,
        ratelimit.ADMIN_MAIL_PER_IP,
        strict=True,
    )
    if not aa.mail_ready():
        raise HTTPException(503, aa.MAIL_OFF)
    user = db.scalar(select(User).where(User.email == email))
    if user is not None and auth.promote_owner(user, settings.owner_email_set):
        db.commit()
    problem = aa.account_problem(user)
    if problem is not None:
        extra = {"email": aa.mask_email(email)} if user is None else {}
        aa.audit(db, request, "admin_login.link_refused", user, reason=problem, **extra)
        db.commit()
    else:
        assert user is not None
        raw = aa.issue_email_token(db, user, aa.MAGIC_PURPOSE, aa.MAGIC_TTL)
        aa.audit(db, request, "admin_login.link_sent", user)
        db.commit()
        minutes = int(aa.MAGIC_TTL.total_seconds() // 60)
        background.add_task(
            send_mail,
            user.email,
            "PlatformSol: вход в админку",
            f"Ссылка для входа в админку ({minutes} минут, один раз): "
            f"{settings.frontend_url}/admin/login?link={raw}\n\n"
            "После неё понадобится код из приложения-аутентификатора. "
            "Если вы не запрашивали вход — просто удалите письмо.",
        )
    return {"status": "если у адреса есть доступ к админке, письмо со ссылкой отправлено"}


@router.post("/magic/consume")
def magic_consume(
    body: LinkIn, request: Request, db: Session = Depends(auth.get_db)
) -> dict[str, Any]:
    ratelimit.guard(
        request,
        "admin-link",
        None,
        ratelimit.ADMIN_LOGIN_PER_IP,
        ratelimit.ADMIN_LOGIN_PER_IP,
        strict=True,
    )
    found = aa.find_email_token(db, body.link, {aa.MAGIC_PURPOSE})
    if found is None:
        aa.audit(db, request, "admin_login.link_failed", None, reason="invalid_link")
        db.commit()
        raise HTTPException(400, aa.LINK_FAILED)
    row, user = found
    row.used_at = datetime.now(tz=UTC)
    problem = aa.account_problem(user)
    if problem is not None:
        aa.audit(db, request, "admin_login.link_failed", user, reason=problem)
        db.commit()
        raise HTTPException(400, aa.LINK_FAILED)
    if user.email_verified_at is None:
        user.email_verified_at = datetime.now(tz=UTC)
    out = _step_out(db, user, "magic")
    aa.audit(db, request, "admin_login.link_used", user, next=out["step"])
    db.commit()
    return out


@router.post("/setup")
def setup_start(
    body: TicketIn, request: Request, db: Session = Depends(auth.get_db)
) -> dict[str, Any]:
    """Первая настройка 2FA: новый секрет (всегда новый — не берём чужой незавершённый)."""
    _, user = _ticket_user(db, body.ticket, request)
    row = db.get(TwoFactor, user.id)
    if twofactor.is_enabled(row):
        raise HTTPException(409, "Защита кодом уже включена — введите код из приложения.")
    secret = twofactor.new_secret()
    if row is None:
        db.add(TwoFactor(user_id=user.id, secret=secret, backup_codes=[]))
    else:
        row.secret = secret
        row.backup_codes = []
    aa.audit(db, request, "admin_login.setup_started", user)
    db.commit()
    return aa.setup_payload(secret, user.email)


@router.post("/setup/confirm")
def setup_confirm(
    body: CodeIn,
    request: Request,
    response: Response,
    background: BackgroundTasks,
    db: Session = Depends(auth.get_db),
) -> dict[str, Any]:
    """Первый верный код включает 2FA, выдаёт резервные коды (один раз) и открывает сеанс."""
    ticket_row, user = _ticket_user(db, body.ticket, request)
    ratelimit.guard(
        request,
        "admin-code",
        str(user.id),
        ratelimit.ADMIN_CODE_PER_USER,
        ratelimit.ADMIN_CODE_PER_IP,
        strict=True,
    )
    row = db.get(TwoFactor, user.id)
    if row is None or twofactor.is_enabled(row):
        raise HTTPException(409, "Начните настройку заново.")
    if not aa.check_totp(row.secret, body.code, user.id):
        _wrong_code(db, request, ticket_row, user, "admin_login.setup_code_failed")
    plain, hashes = twofactor.make_backup_codes()
    row.enabled_at = datetime.now(tz=UTC)
    row.backup_codes = hashes
    aa.audit(db, request, "admin_login.setup_done", user)
    me = _finish(
        db,
        request,
        response,
        background,
        ticket_row,
        user,
        "Включена защита админки кодом и выполнен вход",
        setup=True,
    )
    return {**me, "backup_codes": plain}


@router.post("/verify")
def verify(
    body: CodeIn,
    request: Request,
    response: Response,
    background: BackgroundTasks,
    db: Session = Depends(auth.get_db),
) -> dict[str, Any]:
    """Второй шаг обычного входа: код из приложения или резервный код."""
    ticket_row, user = _ticket_user(db, body.ticket, request)
    ratelimit.guard(
        request,
        "admin-code",
        str(user.id),
        ratelimit.ADMIN_CODE_PER_USER,
        ratelimit.ADMIN_CODE_PER_IP,
        strict=True,
    )
    row = db.get(TwoFactor, user.id)
    if row is None or not twofactor.is_enabled(row):
        raise HTTPException(409, "Защита кодом ещё не настроена — начните вход заново.")
    kind = aa.check_second_factor(row, body.code, user.id)
    if kind is None:
        _wrong_code(db, request, ticket_row, user, "admin_login.code_failed")
    extra: dict[str, Any] = {"backup_left": len(row.backup_codes)} if kind == "backup" else {}
    return _finish(
        db,
        request,
        response,
        background,
        ticket_row,
        user,
        "Вход в админку",
        factor=kind,
        **extra,
    )


def _wrong_code(
    db: Session, request: Request, ticket_row: EmailToken, user: User, action: str
) -> NoReturn:
    """Неверный код: аудит; 401, а на 5-м неверном коде билет сгорает — 410."""
    # hit пропускает limit попыток; (N - 1) — значит N-я неверная попытка уже сжигает билет
    left = ratelimit.hit(
        f"admin-ticket:{ticket_row.token_hash[:16]}",
        ratelimit.ADMIN_WRONG_CODES_PER_TICKET - 1,
        int(aa.TICKET_TTL.total_seconds()),
        strict=True,
    )
    if not left:
        ticket_row.used_at = datetime.now(tz=UTC)
    aa.audit(db, request, action, user, ticket_burned=not left)
    db.commit()
    if not left:
        raise HTTPException(410, aa.CODE_LOCKED)
    raise HTTPException(401, aa.CODE_FAILED)


@router.get("/me")
def me(request: Request, db: Session = Depends(auth.get_db)) -> dict[str, Any]:
    user, row = aa.admin_session(request, db)
    return _me_out(user, row, db)


@router.post("/logout", status_code=204)
def logout(request: Request, db: Session = Depends(auth.get_db)) -> Response:
    """Выход из админки: сеанс отзывается на сервере, cookie админки удаляется.
    Сессию сайта (refresh-cookie на /v1/auth) не трогает."""
    raw = request.cookies.get(aa.COOKIE)
    if raw:
        try:
            payload = aa.decode_token(raw)
            row = db.get(AdminSession, str(payload["sid"]))
            if row is not None and row.revoked_at is None:
                row.revoked_at = datetime.now(tz=UTC)
                user = db.get(User, row.user_id)
                aa.audit(db, request, "admin_logout", user, session=row.id[:8])
                db.commit()
        except HTTPException:
            pass
    out = Response(status_code=204)
    aa.clear_cookie(out)
    return out
