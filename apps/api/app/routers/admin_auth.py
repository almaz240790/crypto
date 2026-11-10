"""/v1/admin/auth — отдельный вход в админку (ADR-0011).

Шаги: ``/login`` (email + пароль) или ``/magic`` → ``/magic/consume`` (ссылка из письма) дают
билет; затем ``/verify`` (код TOTP или резервный код) или, если 2FA ещё не включена,
``/setup`` → ``/setup/confirm`` (QR-код, первый код, резервные коды). Только после второго
фактора выдаётся cookie админки. Ошибки первого шага одинаковые для неизвестного адреса,
неверного пароля и аккаунта без прав (без перебора адресов). Каждая попытка — строка аудита.

Первая настройка кода — только с билетом от ссылки из письма: верный пароль аккаунта без 2FA
отвечает шагом ``mail`` и отправляет ссылку на адрес аккаунта (без почты на сервере — ссылку
выдаёт ``scripts/admin_link.py``). Так один украденный пароль (или аккаунт, заново заведённый
на адрес владельца) не позволяет привязать к админке чужое приложение.

Внутри админки: ``/2fa/backup-codes`` (новые резервные коды по коду из приложения) и
``/2fa/rotate`` → ``/2fa/rotate/confirm`` (перенос кода на другой телефон без выключения 2FA).

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

router = APIRouter(
    prefix="/v1/admin/auth", tags=["admin-auth"], dependencies=[Depends(aa.site_proxy_only)]
)


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


class OnlyCodeIn(BaseModel):
    code: str = Field(min_length=6, max_length=16)


class RotateConfirmIn(BaseModel):
    pending: str = Field(min_length=20, max_length=2000)
    code: str = Field(min_length=6, max_length=16)


LOGIN_ALL = ratelimit.ADMIN_LOGIN_PER_EMAIL_ALL


def _too_many(window: int) -> NoReturn:
    raise HTTPException(429, f"слишком много попыток, подождите {max(1, window // 60)} мин")


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


def _guard_ip(request: Request, scope: str = "admin-code") -> None:
    """Лимит с IP — до поиска билета или аккаунта: мусорные запросы не раздувают аудит."""
    per_ip = ratelimit.ADMIN_CODE_PER_IP if scope == "admin-code" else ratelimit.ADMIN_LOGIN_PER_IP
    ratelimit.guard(request, scope, None, per_ip, per_ip, strict=True)


def _guard_user(user: User) -> str:
    """Лимит кодов на аккаунт (10 за 15 минут). Возвращает ключ попытки: верный код её
    возвращает (:func:`ratelimit.give_back`), так что считаются только неверные коды."""
    return aa.take_code_attempt(user.id)


def _ticket_user(db: Session, raw: str, request: Request) -> tuple[EmailToken, User]:
    """Билет второго шага → (строка билета, админ). Иначе — 410 «начните заново».

    Несуществующий билет в аудит не пишется (как и отказ по лимиту): у него нет владельца,
    а перебор мусорных билетов иначе вытеснял бы из журнала настоящие события."""
    found = aa.find_email_token(db, raw, set(aa.TICKET_PURPOSES))
    if found is None:
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
    ip = ratelimit.client_ip(request)  # только правильный IP-адрес, без текста из заголовков
    text = (
        f"{what}: {now}, IP {ip}, {device}.\n\n"
        "Если это были не вы — задайте новый пароль через «Забыли пароль?» на странице входа "
        "сайта: это сразу закроет все сеансы админки."
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
    device = aa.read_device(request)
    if device is None or device[0] != user.id:
        aa.set_device_cookie(response, aa.make_device(user.id))
    background.add_task(send_mail, *_notice(user.email, request, what))
    return _me_out(user, row, db)


def _send_link(db: Session, background: BackgroundTasks, user: User) -> None:
    raw = aa.issue_email_token(db, user, aa.MAGIC_PURPOSE, aa.MAGIC_TTL)
    db.commit()
    minutes = int(aa.MAGIC_TTL.total_seconds() // 60)
    background.add_task(
        send_mail, user.email, "PlatformSol: вход в админку", aa.link_text(raw, minutes)
    )


@router.get("/config")
def config() -> dict[str, Any]:
    """Что показать на странице входа: работает ли вход по ссылке, сроки сеанса."""
    return {
        "mail": aa.mail_ready(),
        "idle_minutes": int(aa.IDLE.total_seconds() // 60),
        "session_hours": int(aa.TTL.total_seconds() // 3600),
    }


@router.post("/login")
def login(
    body: LoginIn,
    request: Request,
    background: BackgroundTasks,
    db: Session = Depends(auth.get_db),
) -> dict[str, Any]:
    """Email и пароль → билет на код; без включённой 2FA — ссылка на почту (шаг ``mail``).

    Лимиты считают только неудачи (верный пароль владельца их не тратит). Чужой перебор по
    известному адресу владельца не запирает: браузер, где этот админ уже входил, считается по
    cookie устройства, а через прокси сайта лимит идёт на пару «адрес + IP»
    (:func:`admin_auth.limit_keys`)."""
    email = body.email.strip().lower()
    ip_ok, ip_bucket = ratelimit.take(
        f"admin-login:ip:{ratelimit.client_ip(request)}", *ratelimit.ADMIN_LOGIN_PER_IP
    )
    if not ip_ok:
        _too_many(ratelimit.ADMIN_LOGIN_PER_IP[1])
    user = db.scalar(select(User).where(User.email == email))
    device = aa.read_device(request)
    key, total_key = aa.limit_keys("admin-login", email, user, device, request)
    taken = [ip_bucket]
    for k, limit in ((key, ratelimit.ADMIN_LOGIN_PER_EMAIL), (total_key, LOGIN_ALL)):
        if k is None:
            continue
        ok_subject, bucket = ratelimit.take(k, *limit)
        if not ok_subject:
            _too_many(limit[1])
        taken.append(bucket)
    ok = aa.check_password(user, body.password)
    if ok and user is not None and auth.promote_owner(user, settings.owner_email_set):
        db.commit()
    if user is not None and not ok:
        problem: str | None = "bad_password" if user.password_hash else "no_password"
    else:
        problem = aa.account_problem(user)
        if problem == "not_admin" and aa.can_receive_link(user):
            problem = None  # адрес из OWNER_EMAILS, почта ещё не подтверждена: дальше — письмо
    if problem is not None:
        extra = {"email": aa.mask_email(email)} if user is None else {}
        aa.audit(db, request, "admin_login.failed", user, reason=problem, stage="password", **extra)
        db.commit()
        raise HTTPException(401, aa.LOGIN_FAILED)
    assert user is not None
    for bucket in taken:  # верный пароль попыток не тратит
        ratelimit.give_back(bucket)
    if user.role in aa.ADMIN_ROLES and twofactor.is_enabled(db.get(TwoFactor, user.id)):
        out = _step_out(db, user, "password")
        aa.audit(db, request, "admin_login.password_ok", user, next=out["step"])
        db.commit()
        return out
    # 2FA ещё не настроена (или адрес владельца не подтверждён): настройка — только по ссылке
    mail = aa.mail_ready()
    sent = mail and aa.mail_allowed(email, user, device, request)
    aa.audit(
        db, request, "admin_login.password_ok", user, next="mail" if sent else "mail_unavailable"
    )
    db.commit()
    if sent:
        _send_link(db, background, user)
    return {"step": "mail", "email": user.email, "mail": mail, "sent": sent}


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
    per_ip = ratelimit.ADMIN_MAIL_PER_IP
    ratelimit.guard(request, "admin-magic", None, per_ip, per_ip, strict=True)
    if not aa.mail_ready():
        raise HTTPException(503, aa.MAIL_OFF)
    user = db.scalar(select(User).where(User.email == email))
    if not aa.mail_allowed(email, user, aa.read_device(request), request):
        _too_many(ratelimit.ADMIN_MAIL_PER_EMAIL[1])
    if not aa.can_receive_link(user):
        problem = aa.account_problem(user)
        extra = {"email": aa.mask_email(email)} if user is None else {}
        aa.audit(db, request, "admin_login.link_refused", user, reason=problem, **extra)
        db.commit()
    else:
        assert user is not None
        aa.audit(db, request, "admin_login.link_sent", user)
        _send_link(db, background, user)
    return {"status": "если у адреса есть доступ к админке, письмо со ссылкой отправлено"}


@router.post("/magic/consume")
def magic_consume(
    body: LinkIn, request: Request, db: Session = Depends(auth.get_db)
) -> dict[str, Any]:
    """Ссылка из письма (или из ``scripts/admin_link.py``) — подтверждение почты: дальше код
    или первая настройка кода."""
    _guard_ip(request, "admin-link")
    found = aa.find_email_token(db, body.link, {aa.MAGIC_PURPOSE})
    if found is None:
        raise HTTPException(400, aa.LINK_FAILED)
    row, user = found
    now = datetime.now(tz=UTC)
    row.used_at = now
    if not aa.can_receive_link(user):
        aa.audit(db, request, "admin_login.link_failed", user, reason=aa.account_problem(user))
        db.commit()
        raise HTTPException(400, aa.LINK_FAILED)
    if user.email_verified_at is None:
        user.email_verified_at = now  # ссылка пришла на этот адрес — почта подтверждена
    auth.promote_owner(user, settings.owner_email_set)
    problem = aa.account_problem(user)
    if problem is not None:
        aa.audit(db, request, "admin_login.link_failed", user, reason=problem)
        db.commit()
        raise HTTPException(400, aa.LINK_FAILED)
    out = _step_out(db, user, "magic")
    aa.audit(db, request, "admin_login.link_used", user, next=out["step"])
    db.commit()
    return out


def _setup_ticket(db: Session, raw: str, request: Request) -> tuple[EmailToken, User]:
    """Билет для первой настройки кода: только от ссылки из письма (подтверждена почта)."""
    ticket_row, user = _ticket_user(db, raw, request)
    if aa.TICKET_PURPOSES.get(ticket_row.purpose) != "magic":
        raise HTTPException(409, aa.SETUP_NEEDS_LINK)
    return ticket_row, user


@router.post("/setup")
def setup_start(
    body: TicketIn, request: Request, db: Session = Depends(auth.get_db)
) -> dict[str, Any]:
    """Первая настройка 2FA: новый секрет (всегда новый — не берём чужой незавершённый)."""
    _guard_ip(request)
    _, user = _setup_ticket(db, body.ticket, request)
    row = twofactor.locked(db, user.id)
    if twofactor.is_enabled(row):
        raise HTTPException(409, "Защита кодом уже включена — введите код из приложения.")
    secret = twofactor.new_secret()
    if row is None:
        db.add(TwoFactor(user_id=user.id, secret=secret, backup_codes=[]))
    else:
        twofactor.reset_secret(row, secret)
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
    _guard_ip(request)
    ticket_row, user = _setup_ticket(db, body.ticket, request)
    attempt = _guard_user(user)
    row = twofactor.locked(db, user.id)
    if row is None or twofactor.is_enabled(row):
        raise HTTPException(409, "Начните настройку заново.")
    if not twofactor.use_totp(row, body.code):
        _wrong_code(db, request, ticket_row, user, "admin_login.setup_code_failed")
    ratelimit.give_back(attempt)
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
    _guard_ip(request)
    ticket_row, user = _ticket_user(db, body.ticket, request)
    attempt = _guard_user(user)
    row = twofactor.locked(db, user.id)
    if row is None or not twofactor.is_enabled(row):
        raise HTTPException(409, "Защита кодом ещё не настроена — начните вход заново.")
    kind = aa.check_second_factor(row, body.code)
    if kind is None:
        _wrong_code(db, request, ticket_row, user, "admin_login.code_failed")
    ratelimit.give_back(attempt)
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
    """Неверный код: аудит; 401, а на 5-м неверном коде билет сгорает — 410.

    Счёт идёт на весь срок жизни билета (не по окнам часов): 5-й неверный код сжигает билет,
    даже если попытки пришлись на границу окна."""
    # hit_total пропускает limit попыток; (N - 1) — значит N-я неверная попытка уже сжигает билет
    left = ratelimit.hit_total(
        f"admin-ticket:{ticket_row.token_hash[:16]}",
        ratelimit.ADMIN_WRONG_CODES_PER_TICKET - 1,
        int(aa.TICKET_TTL.total_seconds()),
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
                row.revoked_at, row.revoked_reason = datetime.now(tz=UTC), "logout"
                user = db.get(User, row.user_id)
                aa.audit(db, request, "admin_logout", user, session=row.id[:8])
                db.commit()
        except HTTPException:
            pass
    out = Response(status_code=204)
    aa.clear_cookie(out)
    return out


# --- защита входа внутри админки ------------------------------------------------------------------


def _session_code_failed(db: Session, request: Request, user: User, action: str) -> NoReturn:
    aa.audit(db, request, action, user)
    db.commit()
    raise HTTPException(401, aa.CODE_FAILED)


@router.post("/2fa/backup-codes")
def backup_codes(
    body: OnlyCodeIn,
    request: Request,
    background: BackgroundTasks,
    db: Session = Depends(auth.get_db),
) -> dict[str, Any]:
    """Новые 10 резервных кодов (старые перестают работать) — по коду из приложения."""
    user, _ = aa.admin_session(request, db)
    attempt = _guard_user(user)
    row = twofactor.locked(db, user.id)
    if row is None or not twofactor.is_enabled(row):
        raise HTTPException(409, "Защита кодом не включена.")
    if not twofactor.use_totp(row, body.code):
        _session_code_failed(db, request, user, "admin_2fa.code_failed")
    ratelimit.give_back(attempt)
    plain, hashes = twofactor.make_backup_codes()
    row.backup_codes = hashes
    aa.audit(db, request, "admin_2fa.backup_codes_reissued", user)
    db.commit()
    background.add_task(
        send_mail, *_notice(user.email, request, "Выпущены новые резервные коды админки")
    )
    return {"backup_codes": plain, "backup_codes_left": len(plain)}


@router.post("/2fa/rotate")
def rotate_start(
    body: OnlyCodeIn, request: Request, db: Session = Depends(auth.get_db)
) -> dict[str, Any]:
    """Перенос кода на другой телефон, шаг 1: текущий код (или резервный) → новый QR-код.

    Защита при этом не выключается: старый код работает, пока новый не подтверждён."""
    user, session = aa.admin_session(request, db)
    attempt = _guard_user(user)
    row = twofactor.locked(db, user.id)
    if row is None or not twofactor.is_enabled(row):
        raise HTTPException(409, "Защита кодом не включена.")
    kind = aa.check_second_factor(row, body.code)
    if kind is None:
        _session_code_failed(db, request, user, "admin_2fa.code_failed")
    ratelimit.give_back(attempt)
    secret = twofactor.new_secret()
    aa.audit(db, request, "admin_2fa.rotate_started", user, factor=kind)
    db.commit()
    return {
        **aa.setup_payload(secret, user.email),
        "pending": aa.make_rotation(user.id, session.id, secret),
    }


@router.post("/2fa/rotate/confirm")
def rotate_confirm(
    body: RotateConfirmIn,
    request: Request,
    background: BackgroundTasks,
    db: Session = Depends(auth.get_db),
) -> dict[str, Any]:
    """Шаг 2: код из нового приложения — секрет заменяется, выдаются новые резервные коды,
    остальные сеансы админки закрываются (этот остаётся)."""
    user, session = aa.admin_session(request, db)
    attempt = _guard_user(user)
    secret = aa.read_rotation(body.pending, user.id, session.id)
    row = twofactor.locked(db, user.id)
    if secret is None or row is None or not twofactor.is_enabled(row) or row.secret == secret:
        raise HTTPException(410, aa.ROTATE_FAILED)
    step = twofactor.matched_step(secret, body.code)
    if step is None:
        _session_code_failed(db, request, user, "admin_2fa.rotate_code_failed")
    ratelimit.give_back(attempt)
    plain, hashes = twofactor.make_backup_codes()
    row.secret, row.last_step, row.backup_codes = secret, step, hashes
    closed = aa.revoke_user_sessions(db, user.id, "2fa", keep=session.id)
    aa.audit(db, request, "admin_2fa.rotated", user, sessions_closed=closed)
    db.commit()
    background.add_task(
        send_mail, *_notice(user.email, request, "Код админки перенесён на другое устройство")
    )
    return {"backup_codes": plain, "backup_codes_left": len(plain)}
