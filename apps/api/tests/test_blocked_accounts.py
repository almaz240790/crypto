"""Заблокированный и удалённый аккаунт: вход, обновление токена и сокет /v1/ws.

Было: вход по паролю, по ссылке из письма, второй шаг 2FA, Google и Telegram
(``routers/auth._issue``) и обновление токена (``auth.rotate_refresh``) блокировку не проверяли —
заблокированный аккаунт входил и месяцами продлевал сессию сайта. Удалённому обновление отказывало,
но отзыв токена не сохранялся, а ссылка из письма, билет второго шага и вход через Google/Telegram
выдавали ему токены. Сокет верил любому действительному токену: события сигналов «только вошедшим»
получали удалённый, несуществующий и заблокированный аккаунт, а все вошедшие — без ограничений
тарифа (Free — сигналы всех градаций и инструментов без задержки, которых нет в его ленте).

Теперь: вход заблокированного — 403 «Аккаунт заблокирован. Напишите в поддержку.» (после проверки
пароля, ссылки или кода — без них состояние аккаунта не раскрывается); удалённого — 401;
обновление токена обоим — 401, и этот refresh-токен отозван. Сокет: токен удалённого,
несуществующего или заблокированного аккаунта — гость (тики есть, событий для вошедших нет);
событие сигнала — только тем, кому сигнал виден в ленте по тарифу. Вход в админку (ADR-0011) —
прежняя одинаковая ошибка.

Тесты на БД (нужен DATABASE_URL с миграциями до head; без БД пропускаются) идут во внешней
транзакции и откатываются в конце.
"""

from __future__ import annotations

import asyncio
import json
import secrets
from collections.abc import Iterator
from contextlib import nullcontext
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pyotp
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select, text
from sqlalchemy.exc import DBAPIError, OperationalError
from sqlalchemy.orm import Session

from app import admin_auth, auth, live, ratelimit
from app.config import settings
from app.db import engine
from app.models import (
    AuthIdentity,
    Instrument,
    RefreshToken,
    Signal,
    Strategy,
    StrategyVersion,
    Subscription,
    TwoFactor,
    User,
    Watchlist,
    WatchlistItem,
)
from app.routers import auth as auth_router

PASSWORD = "correct horse battery staple"
BLOCKED = "Аккаунт заблокирован. Напишите в поддержку."


def _db_available() -> bool:
    try:
        with engine.connect() as conn:
            conn.execute(text("select blocked_at from users limit 0"))
        return True
    except (OperationalError, DBAPIError):
        return False


pytestmark = pytest.mark.skipif(not _db_available(), reason="БД с миграциями до head недоступна")


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
    """Всё приложение на транзакции теста. Сессия запроса после ответа откатывается, как
    ``close()`` в бою: что эндпоинт не зафиксировал (commit), то не сохранилось. Cookie без Secure
    (local), лимиты — в памяти, биллинг включён: тариф решает подписка."""
    from app.main import app

    def request_db() -> Iterator[Session]:
        try:
            yield db
        finally:
            db.rollback()

    monkeypatch.setattr(settings, "app_env", "local")
    monkeypatch.setattr(settings, "redis_url", "")
    monkeypatch.setattr(settings, "billing_enabled", True)
    monkeypatch.setattr(settings, "owner_emails", "")
    monkeypatch.setattr(auth_router, "send_mail", lambda *a: None)
    ratelimit._memory.values.clear()
    app.dependency_overrides[auth.get_db] = request_db
    try:
        yield TestClient(app, headers={"user-agent": "pytest"})
    finally:
        app.dependency_overrides.pop(auth.get_db, None)
        ratelimit._memory.values.clear()


# --- данные --------------------------------------------------------------------------------------


def _user(
    db: Session,
    *,
    blocked: bool = False,
    deleted: bool = False,
    plan: str | None = None,
    two_factor: str | None = None,
) -> User:
    u = auth.create_user(db, f"blk-{secrets.token_hex(5)}@example.com", PASSWORD)
    now = datetime.now(tz=UTC)
    u.email_verified_at = now
    if blocked:
        u.blocked_at, u.blocked_reason = now, "спам"
    if deleted:
        u.deleted_at = now
    if plan is not None:
        end = now + timedelta(days=30)
        db.add(Subscription(user_id=u.id, plan=plan, status="active", current_period_end=end))
    if two_factor is not None:
        db.add(TwoFactor(user_id=u.id, secret=two_factor, backup_codes=[], enabled_at=now))
    db.commit()
    return u


def _block(db: Session, user: User) -> None:
    user.blocked_at, user.blocked_reason = datetime.now(tz=UTC), "спам"
    db.commit()


def _refresh_rows(db: Session, user: User) -> int:
    q = select(func.count()).select_from(RefreshToken).where(RefreshToken.user_id == user.id)
    return int(db.scalar(q) or 0)


def _login(c: TestClient, user: User, password: str = PASSWORD) -> Any:
    return c.post("/v1/auth/login", json={"email": user.email, "password": password})


def _no_session(r: Any) -> bool:
    """Ни access-токена в ответе, ни refresh-cookie."""
    body = r.json()
    return not body.get("access_token") and auth.REFRESH_COOKIE not in r.headers.get(
        "set-cookie", ""
    )


# --- вход ----------------------------------------------------------------------------------------


def test_password_login_refuses_blocked_account(db: Session, client: TestClient) -> None:
    """Пароль верный, аккаунт заблокирован — 403 с понятным текстом, токенов и сессии нет. Пароль
    неверный — тот же ответ, что всем (блокировка без пароля не раскрывается). Обычный аккаунт —
    как раньше."""
    blocked = _user(db, blocked=True)
    r = _login(client, blocked)
    assert r.status_code == 403 and r.json()["detail"] == BLOCKED, r.text
    assert _no_session(r) and _refresh_rows(db, blocked) == 0
    r = _login(client, blocked, "wrong password 123")
    assert r.status_code == 401 and r.json()["detail"] == "неверный email или пароль"
    # и с 2FA: отказ сразу, без билета второго шага
    with_2fa = _user(db, blocked=True, two_factor=pyotp.random_base32())
    r = _login(client, with_2fa)
    assert r.status_code == 403 and r.json()["detail"] == BLOCKED and not r.json().get("ticket")

    normal = _user(db)
    r = _login(client, normal)
    assert r.status_code == 200 and r.json()["access_token"], r.text
    assert auth.REFRESH_COOKIE in r.headers["set-cookie"] and _refresh_rows(db, normal) == 1


def test_link_second_step_and_social_login_refuse_blocked_account(
    db: Session, client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Ссылка из письма, второй шаг 2FA (заблокирован между шагами), Google и Telegram — тот же 403
    без токенов. Обычный аккаунт через Google — как раньше."""
    # ссылка из письма, отправленная до блокировки
    u = _user(db)
    link = auth_router._email_token(db, u, "magic", timedelta(minutes=15))
    _block(db, u)
    r = client.post("/v1/auth/magic/consume", json={"token": link})
    assert r.status_code == 403 and r.json()["detail"] == BLOCKED and _no_session(r), r.text

    # второй шаг: билет получен до блокировки, код верный
    secret = pyotp.random_base32()
    u2 = _user(db, two_factor=secret)
    first = _login(client, u2)
    assert first.status_code == 200 and first.json()["two_factor"], first.text
    _block(db, u2)
    second = {"ticket": first.json()["ticket"], "code": pyotp.TOTP(secret).now()}
    r = client.post("/v1/auth/login/2fa", json=second)
    assert r.status_code == 403 and r.json()["detail"] == BLOCKED and _no_session(r), r.text

    # Google: адрес заблокированного аккаунта
    u3 = _user(db, blocked=True)
    profile = {"sub": f"g-{u3.id}", "email": u3.email, "email_verified": True, "name": "x"}
    monkeypatch.setattr(auth, "google_exchange", lambda code, uri: profile)
    body = {"code": "c", "redirect_uri": "https://example.test/auth/google"}
    r = client.post("/v1/auth/google", json=body)
    assert r.status_code == 403 and r.json()["detail"] == BLOCKED and _no_session(r), r.text

    # Telegram: связанный вход заблокированного аккаунта
    u4 = _user(db, blocked=True)
    tg = {"id": 900_000_000 + u4.id, "auth_date": 1, "hash": "h"}
    db.add(
        AuthIdentity(user_id=u4.id, provider="telegram", provider_user_id=str(tg["id"]), data={})
    )
    db.commit()
    monkeypatch.setattr(settings, "telegram_bot_token", "bot-token")
    monkeypatch.setattr(auth, "verify_telegram_payload", lambda payload, token: True)
    r = client.post("/v1/auth/telegram", json=tg)
    assert r.status_code == 403 and r.json()["detail"] == BLOCKED and _no_session(r), r.text
    assert sum(_refresh_rows(db, x) for x in (u, u2, u3, u4)) == 0

    # обычный аккаунт через Google — вход как раньше
    u5 = _user(db)
    profile.update(sub=f"g-{u5.id}", email=u5.email)
    r = client.post("/v1/auth/google", json=body)
    assert r.status_code == 200 and r.json()["access_token"], r.text


def test_deleted_account_gets_no_tokens_by_link_ticket_or_social(
    db: Session, client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Удалённый аккаунт: ссылка из письма и билет 2FA, выданные до удаления, и связанный вход
    Google токенов не дают — 401 «пользователь не найден». Было — 200 с токенами удалённого."""
    u = _user(db)
    link = auth_router._email_token(db, u, "magic", timedelta(minutes=15))
    ticket = auth_router._email_token(db, u, "2fa", timedelta(minutes=5))
    secret = pyotp.random_base32()
    db.add(TwoFactor(user_id=u.id, secret=secret, backup_codes=[], enabled_at=datetime.now(tz=UTC)))
    db.add(AuthIdentity(user_id=u.id, provider="google", provider_user_id=f"g-{u.id}", data={}))
    u.deleted_at = datetime.now(tz=UTC)
    db.commit()

    r = client.post("/v1/auth/magic/consume", json={"token": link})
    assert r.status_code == 401 and r.json()["detail"] == "пользователь не найден", r.text
    code = pyotp.TOTP(secret).now()
    r = client.post("/v1/auth/login/2fa", json={"ticket": ticket, "code": code})
    assert r.status_code == 401 and r.json()["detail"] == "пользователь не найден", r.text
    profile = {"sub": f"g-{u.id}", "email": "someone@example.com", "email_verified": True}
    monkeypatch.setattr(auth, "google_exchange", lambda code, uri: profile)
    r = client.post("/v1/auth/google", json={"code": "c", "redirect_uri": "https://e.test/cb"})
    assert r.status_code == 401 and r.json()["detail"] == "пользователь не найден", r.text
    assert _refresh_rows(db, u) == 0


# --- обновление токена ---------------------------------------------------------------------------


@pytest.mark.parametrize("state", ["blocked", "deleted"])
def test_refresh_refuses_blocked_and_deleted_account_and_revokes_token(
    db: Session, client: TestClient, state: str
) -> None:
    """Refresh-токен заблокированного или удалённого аккаунта — 401 без нового токена и cookie, и
    сам токен отозван (отзыв сохранён): повтор — «сессия истекла», после разблокировки — нужен вход
    заново. Было: заблокированный обновлял сессию; у удалённого отзыв откатывался."""
    u = _user(db)
    raw = auth.issue_refresh(db, u, "pytest")
    if state == "blocked":
        _block(db, u)
    else:
        u.deleted_at = datetime.now(tz=UTC)
        db.commit()
    client.cookies.set(auth.REFRESH_COOKIE, raw, domain="testserver.local", path="/v1/auth")

    r = client.post("/v1/auth/refresh")
    assert r.status_code == 401, r.text
    expected = BLOCKED if state == "blocked" else "пользователь не найден"
    assert r.json()["detail"] == expected
    assert _no_session(r) and _refresh_rows(db, u) == 1
    row = db.scalar(select(RefreshToken).where(RefreshToken.token_hash == auth.sha256(raw)))
    assert row is not None and row.revoked_at is not None  # отзыв зафиксирован, не откатился

    if state == "blocked":  # разблокировали — старая сессия не возвращается
        u.blocked_at = None
        db.commit()
    r = client.post("/v1/auth/refresh")
    assert r.status_code == 401 and r.json()["detail"] == "сессия истекла", r.text


def test_refresh_of_normal_account_unchanged(db: Session, client: TestClient) -> None:
    u = _user(db)
    raw = auth.issue_refresh(db, u, "pytest")
    client.cookies.set(auth.REFRESH_COOKIE, raw, domain="testserver.local", path="/v1/auth")
    r = client.post("/v1/auth/refresh")
    assert r.status_code == 200 and r.json()["access_token"], r.text
    assert auth.REFRESH_COOKIE in r.headers["set-cookie"] and _refresh_rows(db, u) == 2
    old = db.scalar(select(RefreshToken).where(RefreshToken.token_hash == auth.sha256(raw)))
    assert old is not None and old.revoked_at is not None  # ротация, как раньше


def test_admin_login_keeps_uniform_error_for_blocked_account(
    db: Session, client: TestClient
) -> None:
    """Вход в админку (ADR-0011) не раскрывает состояние аккаунта: заблокированный владелец с верным
    паролем получает ту же ошибку, что неверный пароль."""
    owner = _user(db, blocked=True)
    owner.role = "owner"
    db.commit()
    body = {"email": owner.email, "password": PASSWORD}
    r = client.post("/v1/admin/auth/login", json=body)
    wrong = client.post("/v1/admin/auth/login", json={**body, "password": "wrong password 1"})
    assert r.status_code == wrong.status_code == 401, r.text
    assert r.json()["detail"] == wrong.json()["detail"] == admin_auth.LOGIN_FAILED


# --- сокет /v1/ws --------------------------------------------------------------------------------


def _token(user_id: int) -> str:
    return auth.make_access_token(User(id=user_id, email="x@example.test", role="user"))


def _instrument(db: Session, symbol: str | None = None) -> Instrument:
    tag = secrets.token_hex(3).upper()
    inst = Instrument(
        exchange="binance", symbol=symbol or f"BK{tag}USDT", base=f"BK{tag}", quote="USDT",
        market_type="futures", tick_size=Decimal("0.01"), lot_size=Decimal("0.001"),
    )  # fmt: skip
    db.add(inst)
    db.flush()
    return inst


def _signal(db: Session, inst: Instrument, grade: str, age: timedelta) -> Signal:
    tag = secrets.token_hex(3)
    strat = Strategy(slug=f"blk-{tag}", name="blocked test")
    db.add(strat)
    db.flush()
    ver = StrategyVersion(strategy_id=strat.id, version=f"0.{tag}.0", params={}, status="live")
    db.add(ver)
    db.flush()
    s = Signal(
        public_id=f"bk{secrets.token_hex(6)}", strategy_version_id=ver.id, instrument_id=inst.id,
        direction="long", candle_close_time=datetime.now(tz=UTC) - age,
        entry_market=Decimal(100), stop_loss=Decimal(95), tp1=Decimal(105), tp2=Decimal(110),
        tp3=Decimal(120), rr_tp2=Decimal(2), score=80 if grade == "A" else 60, grade=grade,
        input_hash="x" * 64, status="tp1_hit", scope="live",
    )  # fmt: skip
    db.add(s)
    db.flush()
    return s


def _event(sig: Signal) -> dict[str, Any]:
    return {
        "id": sig.public_id,
        "instrument_id": sig.instrument_id,
        "status": "tp1_hit",
        "scope": "live",
        "at": datetime.now(tz=UTC).isoformat(),
    }


@pytest.fixture
def ws_db(db: Session, monkeypatch: pytest.MonkeyPatch) -> Session:
    """Сокет читает БД своей сессией (``live.SessionLocal``) — здесь это сессия теста."""
    monkeypatch.setattr(live, "SessionLocal", lambda: nullcontext(db))
    monkeypatch.setattr(settings, "billing_enabled", True)
    return db


def test_ws_token_of_blocked_deleted_or_missing_account_is_a_guest(
    ws_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Токен удалённого, несуществующего или заблокированного аккаунта — гость: подписка и тики
    работают, событий сигналов нет. Обычный аккаунт — вошедший, событие получает."""
    from app import main

    db = ws_db
    fresh = live.Hub()

    async def no_start(self: live.Hub) -> None:  # без Redis: события подаём сами
        return None

    monkeypatch.setattr(live.Hub, "start", no_start)
    monkeypatch.setattr(live, "hub", fresh)
    monkeypatch.setattr(main, "hub", fresh)
    normal = _user(db, plan="premium")
    blocked = _user(db, blocked=True, plan="premium")
    deleted = _user(db, deleted=True, plan="premium")
    tokens = {
        "normal": _token(normal.id),
        "blocked": _token(blocked.id),
        "deleted": _token(deleted.id),
        "missing": _token(2_000_000_000),
        "garbage": "not-a-token",
    }
    sig = _signal(db, _instrument(db), "A", timedelta(hours=1))
    with TestClient(main.app) as tc:
        sockets = {k: tc.websocket_connect(f"/v1/ws?token={t}") for k, t in tokens.items()}
        try:
            for ws in sockets.values():
                ws.__enter__()
                ws.send_text(json.dumps({"sub": ["BTCUSDT"]}))
                assert ws.receive_json() == {"t": "subscribed", "n": 1}
            by_user = {c.user_id for c in fresh.clients}
            assert by_user == {normal.id, None}, by_user
            assert tc.portal is not None  # события — в цикле приложения, как от слушателя Redis
            tc.portal.call(fresh.handle_event, live.CHANNEL_STATUS, _event(sig))
            # тики — всем, и гостям
            ticks = {"at": datetime.now(tz=UTC).isoformat(), "p": {"BTCUSDT": "1.5"}}
            tc.portal.call(fresh.on_prices, ticks)
            assert sockets["normal"].receive_json()["t"] == "signal"
            for name, ws in sockets.items():
                if name != "normal":  # событие уже разослано: пришло бы до тика
                    assert ws.receive_json()["t"] == "tick", name
        finally:
            for ws in sockets.values():
                ws.__exit__(None, None, None)


def test_ws_signal_events_follow_plan_like_the_feed(ws_db: Session) -> None:
    """Событие сигнала — тем, кому сигнал виден в ленте: Premium и админ — все; Free — градация A
    старше 12 ч по BTC, ETH и инструментам вотчлиста; гость — ничего. Было: всем вошедшим."""
    db = ws_db
    btc = db.scalar(select(Instrument).where(Instrument.symbol == "BTCUSDT")) or _instrument(
        db, "BTCUSDT"
    )
    other = _instrument(db)
    old_a_btc = _signal(db, btc, "A", timedelta(hours=13))
    fresh_a_btc = _signal(db, btc, "A", timedelta(hours=1))
    old_b_btc = _signal(db, btc, "B", timedelta(hours=13))
    old_a_other = _signal(db, other, "A", timedelta(hours=13))
    premium, free = _user(db, plan="premium"), _user(db)
    admin = _user(db)
    admin.role = "admin"
    db.commit()

    soon = datetime.now(tz=UTC) + timedelta(minutes=15)  # срок access-токена
    viewers = {
        "premium": live.viewer_for(db, premium.id, soon),
        "free": live.viewer_for(db, free.id, soon),
        "admin": live.viewer_for(db, admin.id, soon),
        # сокет открыт до блокировки или смены тарифа: токен истёк — событий нет
        "expired": live.viewer_for(db, premium.id, datetime.now(tz=UTC) - timedelta(seconds=1)),
    }
    assert all(v is not None for v in viewers.values())
    h = live.Hub()
    clients = {k: live.Client(_FakeWs(), v) for k, v in viewers.items()}  # type: ignore[arg-type]
    clients["guest"] = live.Client(_FakeWs(), None)  # type: ignore[arg-type]
    h.clients.update(clients.values())

    async def run() -> None:
        for sig in (old_a_btc, fresh_a_btc, old_b_btc, old_a_other):
            await h.handle_event(live.CHANNEL_STATUS, _event(sig))

    asyncio.run(run())
    got = {k: [json.loads(m)["id"] for m in c.outbox] for k, c in clients.items()}
    everything = [s.public_id for s in (old_a_btc, fresh_a_btc, old_b_btc, old_a_other)]
    assert got["premium"] == got["admin"] == everything
    assert got["free"] == [old_a_btc.public_id]
    assert got["guest"] == got["expired"] == []
    # инструмент из вотчлиста Free открывает и его сигналы — как в ленте (при подключении сокета)
    wl = db.scalar(select(Watchlist).where(Watchlist.user_id == free.id))
    assert wl is not None
    db.add(WatchlistItem(watchlist_id=wl.id, instrument_id=other.id))
    db.commit()
    watcher = live.Client(_FakeWs(), live.viewer_for(db, free.id, soon))  # type: ignore[arg-type]
    h.clients = {watcher}
    asyncio.run(h.handle_event(live.CHANNEL_STATUS, _event(old_a_other)))
    assert [json.loads(m)["id"] for m in watcher.outbox] == [old_a_other.public_id]
    # удалённый, заблокированный, несуществующий — не вошедший
    for gone in (_user(db, deleted=True), _user(db, blocked=True, plan="premium")):
        assert live.viewer_for(db, gone.id, soon) is None
    assert live.viewer_for(db, 2_000_000_000, soon) is None


class _FakeWs:
    async def send_text(self, text_: str) -> None:
        return None

    async def close(self) -> None:
        return None
