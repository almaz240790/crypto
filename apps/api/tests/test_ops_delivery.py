"""Уведомления без настроек Railway (ADR-0004 «Доставка через уведомитель», ADR-0002 «Дайджесты»).

- Адреса в production: FRONTEND_URL по умолчанию — сайт, а не localhost; API_PUBLIC_URL не
  подменяется.
- Письма об инцидентах: OWNER_EMAILS ∪ активные владельцы из БД; два монитора бок о бок не
  открывают и не шлют одно и то же дважды.
- Алерты: срабатывание — в очередь (``alert_triggers``, ``queued``); с полным набором ключей
  воркер доставляет сразу, иначе — уведомитель; повторы, предел, устаревание, два уведомителя.
- Дайджест: без ключа почты в production не отмечается отправленным; два процесса не шлют дубль.

Тесты на БД (нужен DATABASE_URL с миграциями до head; без БД пропускаются) по возможности
работают во внешней транзакции и откатываются; тесты параллельной работы фиксируют свои строки
по-настоящему (иначе вторая сессия их не увидит) и удаляют их в конце.
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
import logging
import secrets
import threading
import time
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import httpx
import pytest
from sqlalchemy import delete, select, text
from sqlalchemy.exc import DBAPIError, OperationalError
from sqlalchemy.orm import Session

import app.alerts as alerts_mod
import app.mail as mail_mod
import app.monitor as monitor_mod
import app.notify as notify_mod
import app.workers.notifier as notifier_mod
from app.alerts import (
    CHANNEL_TRIGGERED,
    DELIVERY_MAX_ATTEMPTS,
    EXPIRED,
    FAILED,
    QUEUED,
    SENT,
    SUPPRESSED,
    _fire,
    can_deliver_inline,
    channels_ready,
    deliver_pending,
    delivery_ready,
    delivery_state,
    trigger,
    trigger_dict,
)
from app.config import PRODUCTION_FRONTEND_URL, Settings, is_local_url, settings
from app.db import SessionLocal, engine
from app.mail import MailError, provider_wide, send_mail
from app.models import (
    Alert,
    AlertTrigger,
    Incident,
    Instrument,
    NotificationLog,
    NotificationSettings,
    User,
)
from app.monitor import (
    Component,
    incidents_lock,
    merge_owner_emails,
    owner_recipients,
    send_alerts,
)
from app.notify import mail_key, mail_ready, run_digest, unsubscribe

ENV_NAMES = ("APP_ENV", "FRONTEND_URL", "API_PUBLIC_URL", "RAILWAY_ENVIRONMENT_NAME")
VERIFIED = datetime(2026, 1, 1, tzinfo=UTC)
REAL_ALERT_MAIL = alerts_mod._alert_mail
"""Настоящее письмо алерта (через ``send_mail``); фикстура ``outbox`` его подменяет."""


class Outbox:
    """Подмена отправителей: что ушло бы в Resend и Web Push."""

    def __init__(
        self, *, fail_mail: int | None = None, fail_message: str = "", delay: float = 0.0
    ) -> None:
        self.mails: list[tuple[str, str, str, str | None]] = []
        self.pushes: list[tuple[int, dict[str, Any]]] = []
        self.fail_mail = fail_mail
        """Код ответа Resend, которым «отказывает» почта (None — письма уходят)."""
        self.fail_message = fail_message
        """Сообщение Resend при отказе (по нему видно, постоянный ли отказ)."""
        self.delay = delay
        self._lock = threading.Lock()

    def mail(self, to: str, subject: str, text: str, idempotency_key: str | None = None) -> None:
        if self.delay:
            time.sleep(self.delay)
        if self.fail_mail is not None:
            raise MailError(self.fail_mail, "validation_error", self.fail_message)
        with self._lock:
            self.mails.append((to, subject, text, idempotency_key))

    def push(self, db: Session, user_id: int, payload: dict[str, Any]) -> int:
        with self._lock:
            self.pushes.append((user_id, payload))
        return 1


@pytest.fixture(autouse=True)
def outbox(monkeypatch: pytest.MonkeyPatch) -> Outbox:
    """Ни один тест не ходит в сеть: письма и push алертов по умолчанию — в ``Outbox``, прямой
    запрос к Resend — ошибка теста (тесты ``send_mail`` подменяют ``httpx.post`` сами)."""

    def no_network(*a: Any, **kw: Any) -> None:
        raise AssertionError("тест пытался отправить письмо через Resend")

    box = Outbox()
    monkeypatch.setattr(mail_mod.httpx, "post", no_network)
    monkeypatch.setattr(alerts_mod, "_alert_mail", box.mail)
    monkeypatch.setattr(alerts_mod, "send_to_user", box.push)
    return box


def _production(monkeypatch: pytest.MonkeyPatch, on: bool = True) -> None:
    monkeypatch.setattr(Settings, "is_production", property(lambda self: on))


def _keys(monkeypatch: pytest.MonkeyPatch, *, mail: bool, push: bool) -> None:
    monkeypatch.setattr(settings, "resend_api_key", "re_test" if mail else None)
    monkeypatch.setattr(settings, "vapid_private_key", "priv" if push else None)
    monkeypatch.setattr(settings, "vapid_public_key", "pub" if push else None)


def _as_alerts_service(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ключи как у сервиса alerts на Railway: почта есть, Web Push нет — срабатывание в очередь."""
    _keys(monkeypatch, mail=True, push=False)


def _as_notifier(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ключи как у уведомителя на Railway: и почта, и Web Push."""
    _keys(monkeypatch, mail=True, push=True)


# --- адреса в production (A) -------------------------------------------------------------------


def _settings(monkeypatch: pytest.MonkeyPatch, **env: str) -> Settings:
    for name in ENV_NAMES:
        monkeypatch.delenv(name, raising=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    return Settings(_env_file=None)  # type: ignore[call-arg]


def test_production_frontend_url_defaults_to_site(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.WARNING, logger="app.config"):
        s = _settings(monkeypatch, APP_ENV="production")
    assert s.is_production
    assert s.frontend_url == PRODUCTION_FRONTEND_URL == "https://platformsol.com"
    assert "FRONTEND_URL не задан" in caplog.text
    # пустая переменная — то же самое
    assert _settings(monkeypatch, APP_ENV="production", FRONTEND_URL=" ").frontend_url == (
        PRODUCTION_FRONTEND_URL
    )


def test_production_keeps_explicit_frontend_url_and_warns_on_localhost(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    s = _settings(monkeypatch, APP_ENV="production", FRONTEND_URL="https://staging.example.com")
    assert s.frontend_url == "https://staging.example.com"
    with caplog.at_level(logging.WARNING, logger="app.config"):
        s = _settings(monkeypatch, APP_ENV="production", FRONTEND_URL="http://localhost:3000")
    assert s.frontend_url == "http://localhost:3000"
    assert "ведут на localhost" in caplog.text


def test_local_and_staging_keep_localhost_without_warning(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.WARNING, logger="app.config"):
        local = _settings(monkeypatch)
        staging = _settings(monkeypatch, APP_ENV="staging")
    assert not local.is_production and not staging.is_production
    assert local.frontend_url == staging.frontend_url == "http://localhost:3000"
    assert caplog.text == ""


def test_api_public_url_is_not_invented(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    s = _settings(monkeypatch, APP_ENV="production")
    assert s.api_public_url == "http://localhost:8000"  # прежнее значение по умолчанию
    s = _settings(monkeypatch, APP_ENV="production", API_PUBLIC_URL="https://api.example.com")
    assert s.api_public_url == "https://api.example.com"


def test_is_production_falls_back_to_railway_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    s = _settings(monkeypatch, RAILWAY_ENVIRONMENT_NAME="production")
    assert s.is_production and s.frontend_url == PRODUCTION_FRONTEND_URL
    # явный APP_ENV важнее окружения Railway
    assert not _settings(
        monkeypatch, APP_ENV="staging", RAILWAY_ENVIRONMENT_NAME="production"
    ).is_production
    assert not _settings(monkeypatch, RAILWAY_ENVIRONMENT_NAME="staging").is_production


def test_is_local_url() -> None:
    assert is_local_url("http://localhost:3000")
    assert is_local_url("http://127.0.0.1:8000/x")
    assert is_local_url("")
    assert not is_local_url("https://platformsol.com")


# --- письмо: ключ идемпотентности и строгий режим ------------------------------------------------


BAD_TO = "Invalid `to` field. The email address needs to follow the `email@example.com` format."
BAD_FROM = "Invalid `from` field. The email address needs to follow the `email@example.com` format."


class _Resp:
    def __init__(self, code: int, name: str = "", message: str = "") -> None:
        self.status_code = code
        self.text = json.dumps({"statusCode": code, "name": name, "message": message})


def _fake_post(
    calls: list[dict[str, Any]], code: int, name: str = "", message: str = ""
) -> Callable[..., _Resp]:
    def post(url: str, **kw: Any) -> _Resp:
        calls.append({"url": url, **kw})
        return _Resp(code, name, message)

    return post


def test_send_mail_idempotency_header_and_strict(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, Any]] = []
    monkeypatch.setattr(settings, "resend_api_key", "re_test")
    monkeypatch.setattr(mail_mod.httpx, "post", _fake_post(calls, 200))
    send_mail("a@example.com", "s", "t", idempotency_key="alert-trigger-1")
    assert calls[-1]["headers"]["Idempotency-Key"] == "alert-trigger-1"
    send_mail("a@example.com", "s", "t")
    assert "Idempotency-Key" not in calls[-1]["headers"]
    # отказ провайдера: в строгом режиме — исключение, без него — только лог (как раньше).
    # Постоянный — только отказ по адресу получателя; неверный ключ, MAIL_FROM, пропущенное поле,
    # лимит и сбой провайдера касаются всех писем — их повторяют (provider_wide)
    for code, name, message, permanent in (
        (401, "validation_error", "API key is invalid", False),
        (403, "validation_error", "The example.com domain is not verified.", False),
        (429, "rate_limit_exceeded", "Too many requests.", False),
        (500, "application_error", "", False),
        (503, "service_unavailable", "", False),
        (400, "validation_error", "API key is invalid", False),
        (400, "validation_error", BAD_FROM, False),
        (422, "missing_required_field", "Missing `from` field.", False),
        (422, "invalid_from_address", BAD_FROM, False),
        (422, "", "", False),
        (400, "validation_error", BAD_TO, True),
        (422, "validation_error", BAD_TO, True),
    ):
        monkeypatch.setattr(mail_mod.httpx, "post", _fake_post(calls, code, name, message))
        send_mail("a@example.com", "s", "t")
        with pytest.raises(MailError) as err:
            send_mail("a@example.com", "s", "t", strict=True)
        assert err.value.status_code == code and err.value.permanent is permanent, message
        assert err.value.name == name and provider_wide(err.value) is not permanent
    # 409 по ключу идемпотентности — письмо с этим ключом уже отправлено: это успех
    monkeypatch.setattr(mail_mod.httpx, "post", _fake_post(calls, 409))
    send_mail("a@example.com", "s", "t", idempotency_key="digest-1-daily-2031-03-04", strict=True)
    with pytest.raises(MailError):
        send_mail("a@example.com", "s", "t", strict=True)  # без ключа 409 — отказ


def test_send_mail_without_key_only_logs(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*a: Any, **kw: Any) -> None:
        raise AssertionError("без ключа запросов к Resend нет")

    monkeypatch.setattr(settings, "resend_api_key", None)
    monkeypatch.setattr(mail_mod.httpx, "post", boom)
    send_mail("a@example.com", "s", "t", idempotency_key="k", strict=True)


def test_send_mail_network_error_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    def down(*a: Any, **kw: Any) -> None:
        raise httpx.ConnectError("нет сети")

    monkeypatch.setattr(settings, "resend_api_key", "re_test")
    monkeypatch.setattr(mail_mod.httpx, "post", down)
    with pytest.raises(httpx.ConnectError) as err:
        send_mail("a@example.com", "s", "t")
    assert provider_wide(err.value)
    assert not provider_wide(RuntimeError("ошибка в коде"))


# --- кто может рассылать -------------------------------------------------------------------------


def test_mail_ready_and_delivery_ready(monkeypatch: pytest.MonkeyPatch) -> None:
    for prod in (False, True):
        _production(monkeypatch, prod)
        for mail in (False, True):
            for push in (False, True):
                _keys(monkeypatch, mail=mail, push=push)
                assert mail_ready() is (mail or not prod)
                assert can_deliver_inline() is (mail and push)
                assert delivery_ready() is (mail or push or not prod)
                assert channels_ready() == (
                    {"mail": mail, "push": push} if prod else {"mail": True, "push": True}
                )


def test_mail_key_has_no_colons() -> None:
    assert mail_key("digest", 7, "daily:2026-11-10") == "digest-7-daily-2026-11-10"


def test_merge_owner_emails() -> None:
    assert merge_owner_emails({" Owner@Example.com ", ""}, ["owner@example.com", "b@x.io", ""]) == [
        "b@x.io",
        "owner@example.com",
    ]


def test_trigger_dict_hides_delivery_state() -> None:
    t = AlertTrigger(
        id=1,
        alert_id=2,
        triggered_at=VERIFIED,
        price=None,
        details={"tf": "1m", "delivery": {"status": "sent"}},
        notified=True,
    )
    assert trigger_dict(t)["details"] == {"tf": "1m"}


def test_notifier_wakes_on_alerts_message() -> None:
    from app.workers.notifier import Notifier

    async def go() -> float:
        n = Notifier()
        try:

            async def nudge() -> None:
                await asyncio.sleep(0.05)
                n.alerts_wake.set()

            task = asyncio.create_task(nudge())
            t0 = time.monotonic()
            await n._wait_alerts(10)
            await task
            return time.monotonic() - t0
        finally:
            await n.redis.aclose()

    assert asyncio.run(go()) < 2


def test_digests_once_runs_every_mailing_and_reports_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Сбой ежедневного дайджеста не отменяет недельный и отчёт по журналу, но проход не
    считается завершённым — уведомитель его повторит."""
    calls: list[str] = []

    def digest(db: Session, period: str, now: datetime) -> int:
        calls.append(period)
        if period == "daily":
            raise MailError(503)
        return 2

    def journal(db: Session, now: datetime) -> int:
        calls.append("journal")
        return 1

    monkeypatch.setattr(notifier_mod, "run_digest", digest)
    monkeypatch.setattr(notifier_mod, "run_journal_reports", journal)
    monday = datetime(2031, 3, 3, 6, 1, tzinfo=UTC)
    with pytest.raises(RuntimeError, match="daily"):
        notifier_mod.digests_once(monday)
    assert calls == ["daily", "weekly", "journal"]
    calls.clear()
    monkeypatch.setattr(notifier_mod, "run_digest", lambda db, period, now: 3)
    assert notifier_mod.digests_once(monday + timedelta(days=1)) == {"daily": 3}


class _FakeRedis:
    def __init__(self) -> None:
        self.sets: list[tuple[str, str, int | None]] = []

    async def set(self, key: str, value: str, ex: int | None = None) -> None:
        self.sets.append((key, value, ex))


def test_digest_mark_is_a_lease_until_success(monkeypatch: pytest.MonkeyPatch) -> None:
    """Отметка «дайджесты за дату отправлены» на трое суток — только после успешного прохода.
    До него — аренда на ``DIGEST_RETRY_AFTER``: упал или убит посреди прохода (выкладка) — через
    15 минут проход повторит этот или новый экземпляр."""
    key = notifier_mod.KEY_DIGEST + "date"
    lease = notifier_mod.DIGEST_RETRY_AFTER

    def run(fail: bool) -> list[tuple[str, str, int | None]]:
        def once(now: datetime) -> dict[str, int]:
            if fail:
                raise RuntimeError("рассылки не завершены: daily")
            return {"daily": 1}

        monkeypatch.setattr(notifier_mod, "digests_once", once)

        async def go() -> list[tuple[str, str, int | None]]:
            n = notifier_mod.Notifier()
            real, fake = n.redis, _FakeRedis()
            n.redis = fake  # type: ignore[assignment]
            try:
                await n.digests(datetime(2031, 3, 4, 6, 1, tzinfo=UTC))
            finally:
                await real.aclose()
            return fake.sets

        return asyncio.run(go())

    assert run(False) == [(key, "2031-03-04", lease), (key, "2031-03-04", 3 * 86400)]
    assert run(True) == [(key, "2031-03-04", lease)]


# --- на реальной БД ------------------------------------------------------------------------------


def _db_available() -> bool:
    try:
        with engine.connect() as conn:
            conn.execute(text("select 1 from alert_triggers limit 1"))
        return True
    except (OperationalError, DBAPIError):
        return False


db_only = pytest.mark.skipif(not _db_available(), reason="БД с миграциями недоступна")


@pytest.fixture
def db() -> Iterator[Session]:
    """Сессия во внешней транзакции: commit в коде — это savepoint, в конце всё откатывается."""
    conn = engine.connect()
    outer = conn.begin()
    s = Session(bind=conn, join_transaction_mode="create_savepoint", expire_on_commit=False)
    try:
        yield s
    finally:
        s.close()
        outer.rollback()
        conn.close()


def _user(db: Session, *, role: str = "user", **kw: Any) -> User:
    u = User(
        email=f"ops-{secrets.token_hex(4)}@example.com",
        password_hash="x",
        role=role,
        email_verified_at=kw.pop("email_verified_at", VERIFIED),
        **kw,
    )
    db.add(u)
    db.flush()
    return u


def _alert_setup(db: Session, **ns_kw: Any) -> tuple[User, Alert, NotificationSettings]:
    user = _user(db)
    ns = NotificationSettings(
        user_id=user.id,
        unsubscribe_token=secrets.token_urlsafe(24),
        email_alerts=ns_kw.pop("email_alerts", True),
        push_alerts=ns_kw.pop("push_alerts", True),
        **ns_kw,
    )
    tag = secrets.token_hex(3).upper()
    inst = Instrument(
        exchange="binance",
        symbol=f"OPS{tag}USDT",
        base=f"OPS{tag}",
        quote="USDT",
        market_type="futures",
        tick_size=Decimal("0.01"),
        lot_size=Decimal("0.001"),
    )
    db.add_all([ns, inst])
    db.flush()
    alert = Alert(
        user_id=user.id,
        instrument_id=inst.id,
        type="price",
        condition={"op": "cross_up", "price": "100"},
        frequency="every",
        status="active",
    )
    db.add(alert)
    db.flush()
    return user, alert, ns


def _fire_one(db: Session, alert: Alert, at: datetime) -> AlertTrigger:
    assert _fire(db, alert, at, Decimal("100.5"), {"close": "100.5", "tf": "1m"}) == 1
    trig = db.scalar(
        select(AlertTrigger).where(
            AlertTrigger.alert_id == alert.id, AlertTrigger.triggered_at == at
        )
    )
    assert trig is not None
    return trig


def _only(monkeypatch: pytest.MonkeyPatch, alert_ids: set[int]) -> None:
    """Очередь в тесте — только наши срабатывания (в общей БД могут быть чужие строки)."""
    original = alerts_mod.pending_ids

    def mine(db: Session, now: datetime, limit: int = alerts_mod.DELIVERY_BATCH) -> list[int]:
        ids = original(db, now, 10_000)
        own = set(
            db.scalars(
                select(AlertTrigger.id).where(
                    AlertTrigger.id.in_(ids), AlertTrigger.alert_id.in_(alert_ids)
                )
            ).all()
        )
        return [i for i in ids if i in own][:limit]

    monkeypatch.setattr(alerts_mod, "pending_ids", mine)


@db_only
def test_trigger_without_keys_is_queued_and_notifier_delivers(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    _keys(monkeypatch, mail=True, push=False)  # как у сервиса alerts на Railway
    monkeypatch.setattr(settings, "frontend_url", PRODUCTION_FRONTEND_URL)
    user, alert, _ = _alert_setup(db)
    _only(monkeypatch, {alert.id})
    now = datetime.now(tz=UTC)
    trig = _fire_one(db, alert, now.replace(second=0, microsecond=0))
    db.commit()
    assert not trig.notified and delivery_state(trig) == {"status": QUEUED}

    _keys(monkeypatch, mail=True, push=True)  # как у уведомителя
    out = Outbox()
    assert deliver_pending(db, now, mail=out.mail, push=out.push) == 1
    db.refresh(trig)
    assert trig.notified and delivery_state(trig)["status"] == SENT
    assert len(out.mails) == 1 and len(out.pushes) == 1
    to, subject, body, key = out.mails[0]
    assert subject.startswith("Алерт: ")
    assert to == user.email and key == f"alert-trigger-{trig.id}"
    assert f"{PRODUCTION_FRONTEND_URL}/chart/" in body and "localhost" not in body
    assert "Отписаться" in body or "unsubscribe" in body.lower()
    assert out.pushes[0][1]["tag"] == f"alert-{trig.id}"
    assert "сработал" not in out.pushes[0][1]["body"]  # доставлено сразу — без пометки
    # повторный проход ничего не шлёт
    assert deliver_pending(db, now, mail=out.mail, push=out.push) == 0
    assert len(out.mails) == 1 and len(out.pushes) == 1


@db_only
def test_inline_delivery_with_all_keys_is_unchanged(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    _keys(monkeypatch, mail=True, push=True)  # локально с полным .env
    out = Outbox()
    monkeypatch.setattr(alerts_mod, "_alert_mail", out.mail)
    monkeypatch.setattr(alerts_mod, "send_to_user", out.push)
    _, alert, _ = _alert_setup(db)
    _only(monkeypatch, {alert.id})
    trig = _fire_one(db, alert, datetime.now(tz=UTC).replace(second=0, microsecond=0))
    assert trig.notified and delivery_state(trig)["status"] == SENT
    assert len(out.mails) == 1 and len(out.pushes) == 1
    db.commit()
    other = Outbox()
    assert deliver_pending(db, mail=other.mail, push=other.push) == 0
    assert other.mails == [] and other.pushes == []


@db_only
def test_inline_failure_stays_queued_for_notifier(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    _keys(monkeypatch, mail=True, push=True)
    broken = Outbox(fail_mail=503)
    monkeypatch.setattr(alerts_mod, "_alert_mail", broken.mail)
    monkeypatch.setattr(alerts_mod, "send_to_user", broken.push)
    _, alert, _ = _alert_setup(db)
    _only(monkeypatch, {alert.id})
    trig = _fire_one(db, alert, datetime.now(tz=UTC).replace(second=0, microsecond=0))
    db.commit()
    db.refresh(trig)
    assert not trig.notified and delivery_state(trig)["status"] == QUEUED
    assert alert.triggers_count == 1  # срабатывание само по себе записано
    state = delivery_state(trig)
    assert state["attempts"] == 1 and state["push_done"] is True and "mail_done" not in state
    assert len(broken.pushes) == 1
    out = Outbox()
    later = datetime.fromisoformat(state["retry_at"]) + timedelta(seconds=1)
    assert deliver_pending(db, later, mail=out.mail, push=out.push) == 1
    db.refresh(trig)
    assert trig.notified and len(out.mails) == 1 and out.pushes == []  # push уже ушёл


@db_only
def test_retries_are_bounded_then_failed(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    """Сбой не почты (push падает с ошибкой) — не больше ``DELIVERY_MAX_ATTEMPTS`` попыток, затем
    ``failed``; письмо ушло с первой попытки и не повторялось: каналы независимы."""
    _as_alerts_service(monkeypatch)
    _, alert, _ = _alert_setup(db)
    _only(monkeypatch, {alert.id})
    now = datetime.now(tz=UTC)
    trig = _fire_one(db, alert, now.replace(second=0, microsecond=0))
    db.commit()
    _as_notifier(monkeypatch)
    out = Outbox()

    def broken_push(s: Session, user_id: int, payload: dict[str, Any]) -> int:
        raise RuntimeError("push: ошибка в данных подписки")

    t = now
    for attempt in range(1, DELIVERY_MAX_ATTEMPTS + 1):
        assert deliver_pending(db, t, mail=out.mail, push=broken_push) == 0
        db.refresh(trig)
        state = delivery_state(trig)
        assert state["attempts"] == attempt and "push" in state["error"]
        if attempt < DELIVERY_MAX_ATTEMPTS:
            assert state["status"] == QUEUED
            retry_at = datetime.fromisoformat(state["retry_at"])
            assert retry_at > t
            # до паузы строка не берётся
            assert deliver_pending(db, t, mail=out.mail, push=broken_push) == 0
            assert delivery_state(trig)["attempts"] == attempt
            t = retry_at + timedelta(seconds=1)
    assert delivery_state(trig)["status"] == FAILED and not trig.notified
    assert len(out.mails) == 1 and out.mails[0][3] == f"alert-trigger-{trig.id}"
    assert delivery_state(trig)["mail_done"] is True and "push_done" not in delivery_state(trig)
    assert deliver_pending(db, t + timedelta(hours=1), mail=out.mail, push=broken_push) == 0


@db_only
def test_provider_wide_mail_refusal_retries_until_fixed_or_stale(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Отказ почты не из-за письма (неверный MAIL_FROM — 422, сбой провайдера — 503) не делает
    срабатывание ``failed`` ни с первой, ни с шестой попытки: письмо ждёт, пока настройки
    исправят (повтор не реже раза в 8 минут), и уходит; не исправили за сутки — ``expired``.
    Push уходит с первой попытки."""
    _as_alerts_service(monkeypatch)
    _, alert, _ = _alert_setup(db)
    _only(monkeypatch, {alert.id})
    now = datetime.now(tz=UTC)
    fixed = _fire_one(db, alert, now.replace(second=0, microsecond=0))
    stale = _fire_one(db, alert, (now - timedelta(minutes=1)).replace(second=0, microsecond=0))
    db.commit()
    _as_notifier(monkeypatch)
    out = Outbox()
    bad_from = Outbox(fail_mail=422, fail_message=BAD_FROM)
    down = Outbox(fail_mail=503)
    t = now
    for attempt in range(1, DELIVERY_MAX_ATTEMPTS + 4):
        box = bad_from if attempt % 2 else down
        deliver_pending(db, t, mail=box.mail, push=out.push)
        db.refresh(fixed)
        db.refresh(stale)
        for trig in (fixed, stale):
            state = delivery_state(trig)
            assert state["status"] == QUEUED and not trig.notified, state
            assert state["push_done"] is True and "mail_done" not in state
        retry_at = max(
            datetime.fromisoformat(delivery_state(r)["retry_at"]) for r in (fixed, stale)
        )
        assert retry_at - t <= timedelta(minutes=8, seconds=1)
        t = retry_at + timedelta(seconds=1)
    assert len(out.pushes) == 2  # push — по разу, письма ждут
    assert delivery_state(fixed)["attempts"] > DELIVERY_MAX_ATTEMPTS
    # MAIL_FROM исправили: свежее срабатывание доставлено, суточное — устарело
    stale.created_at = now - timedelta(hours=25)
    db.commit()
    assert deliver_pending(db, t, mail=out.mail, push=out.push) == 2
    db.refresh(fixed)
    db.refresh(stale)
    assert fixed.notified and delivery_state(fixed)["status"] == SENT
    assert [m[3] for m in out.mails] == [f"alert-trigger-{fixed.id}"]
    assert delivery_state(stale)["status"] == EXPIRED
    assert stale.notified  # push по нему дошёл — пользователь уведомлён


@db_only
def test_stale_trigger_expires_and_late_push_is_marked(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    _as_alerts_service(monkeypatch)
    _, alert, _ = _alert_setup(db)
    _only(monkeypatch, {alert.id})
    now = datetime.now(tz=UTC)
    stale = _fire_one(db, alert, now - timedelta(hours=30))
    late = _fire_one(db, alert, now - timedelta(minutes=20))
    stale.created_at = now - timedelta(hours=25)
    late.created_at = now - timedelta(minutes=20)
    db.commit()
    _as_notifier(monkeypatch)
    out = Outbox()
    assert deliver_pending(db, now, mail=out.mail, push=out.push) == 2
    db.refresh(stale)
    db.refresh(late)
    assert delivery_state(stale)["status"] == EXPIRED and not stale.notified
    assert delivery_state(late)["status"] == SENT and late.notified
    assert len(out.pushes) == 1 and "(сработал " in out.pushes[0][1]["body"]


@db_only
def test_quiet_hours_and_legacy_rows(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    _as_alerts_service(monkeypatch)
    now = datetime.now(tz=UTC)
    _, alert, _ = _alert_setup(db, quiet_from=now.hour, quiet_to=(now.hour + 1) % 24)
    _only(monkeypatch, {alert.id})
    quiet = _fire_one(db, alert, now.replace(second=0, microsecond=0))
    # строки, записанные прежним воркером (без отметки доставки), уведомителю не нужны: он их
    # либо доставил сам (notified), либо подавил тихими часами — второй доставки нет
    legacy = trigger(db, alert, now - timedelta(minutes=1), Decimal("100"), {"tf": "1m"})
    old_sent = trigger(db, alert, now - timedelta(minutes=2), Decimal("100"), {"tf": "1m"})
    assert legacy is not None and old_sent is not None
    old_sent.notified = True
    db.commit()
    _as_notifier(monkeypatch)
    out = Outbox()
    assert deliver_pending(db, now, mail=out.mail, push=out.push) == 1
    db.refresh(quiet)
    assert delivery_state(quiet) == {"status": SUPPRESSED, "reason": "quiet_hours"}
    assert not quiet.notified and out.mails == [] and out.pushes == []
    assert delivery_state(legacy) == {} and not legacy.notified
    assert delivery_state(old_sent) == {} and old_sent.notified
    assert deliver_pending(db, now, mail=out.mail, push=out.push) == 0


@db_only
def test_production_notifier_without_keys_leaves_queue(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """В production без ключей обоих каналов очередь не трогается."""
    _production(monkeypatch)
    monkeypatch.setattr(alerts_mod, "_not_ready_warned", False)
    _keys(monkeypatch, mail=True, push=False)
    _, alert, _ = _alert_setup(db)
    _only(monkeypatch, {alert.id})
    trig = _fire_one(db, alert, datetime.now(tz=UTC).replace(second=0, microsecond=0))
    db.commit()
    _keys(monkeypatch, mail=False, push=False)
    out = Outbox()
    assert deliver_pending(db, mail=out.mail, push=out.push) == 0
    db.refresh(trig)
    assert delivery_state(trig) == {"status": QUEUED} and out.mails == [] and out.pushes == []
    _keys(monkeypatch, mail=True, push=True)
    assert deliver_pending(db, mail=out.mail, push=out.push) == 1
    assert len(out.mails) == 1 and len(out.pushes) == 1


@db_only
def test_production_without_vapid_sends_mail_and_holds_push(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """У уведомителя есть ключ почты, а VAPID пуст: письмо уходит сразу (и тем, кто выбрал только
    письма), push ждёт ключей, не засчитывая попыток и не задерживая очередь; ключи вернулись —
    push уходит с пометкой времени срабатывания. Без ключей до конца суток — ``expired``, но
    письмо уже дошло (``notified``)."""
    _production(monkeypatch)
    _as_alerts_service(monkeypatch)
    _, both, _ = _alert_setup(db)
    _, mail_only, _ = _alert_setup(db, push_alerts=False)
    _, push_only, _ = _alert_setup(db, email_alerts=False)
    _only(monkeypatch, {both.id, mail_only.id, push_only.id})
    now = datetime.now(tz=UTC)
    at = now.replace(second=0, microsecond=0)
    t_both, t_mail, t_push = (_fire_one(db, a, at) for a in (both, mail_only, push_only))
    t_late = _fire_one(db, both, at - timedelta(minutes=1))
    db.commit()
    _keys(monkeypatch, mail=True, push=False)  # уведомитель без VAPID
    out = Outbox()
    assert deliver_pending(db, now, mail=out.mail, push=out.push) == 1  # только письмо-only
    for r in (t_both, t_mail, t_push, t_late):
        db.refresh(r)
    assert t_mail.notified and delivery_state(t_mail)["status"] == SENT
    for r in (t_both, t_late):
        state = delivery_state(r)
        assert state["status"] == QUEUED and state["mail_done"] is True
        assert state["waiting"] == ["push"] and "attempts" not in state
    assert delivery_state(t_push)["waiting"] == ["push"] and not t_push.notified
    assert sorted(m[3] or "" for m in out.mails) == sorted(
        f"alert-trigger-{r.id}" for r in (t_both, t_mail, t_late)
    )
    assert out.pushes == []
    # до паузы строки не берутся — новые срабатывания ими не задерживаются
    assert deliver_pending(db, now + timedelta(minutes=1), mail=out.mail, push=out.push) == 0
    # VAPID вернули через 20 минут: push уходит, письма не повторяются
    _keys(monkeypatch, mail=True, push=True)
    t_late.created_at = now - timedelta(hours=25)  # а это срабатывание за сутки устарело
    db.commit()
    later = now + timedelta(minutes=20)
    assert deliver_pending(db, later, mail=out.mail, push=out.push) == 3
    for r in (t_both, t_push, t_late):
        db.refresh(r)
    assert t_both.notified and delivery_state(t_both)["status"] == SENT
    assert t_push.notified and delivery_state(t_push)["status"] == SENT
    assert delivery_state(t_late)["status"] == EXPIRED and t_late.notified
    assert len(out.mails) == 3 and len(out.pushes) == 2
    assert all("(сработал " in p[1]["body"] for p in out.pushes)


@db_only
def test_provider_refusal_is_not_marked_delivered(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Resend отклонил ключ (401): срабатывание не отмечается доставленным, а ждёт повтора;
    ключ исправили — следующая попытка доставляет (тем же ключом идемпотентности)."""
    _as_alerts_service(monkeypatch)
    _, alert, _ = _alert_setup(db, push_alerts=False)
    _only(monkeypatch, {alert.id})
    now = datetime.now(tz=UTC)
    trig = _fire_one(db, alert, now.replace(second=0, microsecond=0))
    db.commit()
    _as_notifier(monkeypatch)
    calls: list[dict[str, Any]] = []
    monkeypatch.setattr(mail_mod.httpx, "post", _fake_post(calls, 401))
    assert deliver_pending(db, now, mail=REAL_ALERT_MAIL) == 0
    db.refresh(trig)
    state = delivery_state(trig)
    assert not trig.notified and state["status"] == QUEUED and state["attempts"] == 1
    assert calls[-1]["headers"]["Idempotency-Key"] == f"alert-trigger-{trig.id}"
    monkeypatch.setattr(mail_mod.httpx, "post", _fake_post(calls, 200))
    later = datetime.fromisoformat(state["retry_at"]) + timedelta(seconds=1)
    assert deliver_pending(db, later, mail=REAL_ALERT_MAIL) == 1
    db.refresh(trig)
    assert trig.notified and delivery_state(trig)["status"] == SENT
    assert len(calls) == 2 and calls[-1]["headers"]["Idempotency-Key"] == f"alert-trigger-{trig.id}"


@db_only
def test_push_failure_does_not_block_mail_and_retry_sends_only_push(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Push-сервис недоступен: письмо всё равно уходит; повтор шлёт только push, письмо — нет."""
    _as_alerts_service(monkeypatch)
    _, alert, _ = _alert_setup(db)
    _only(monkeypatch, {alert.id})
    now = datetime.now(tz=UTC)
    trig = _fire_one(db, alert, now.replace(second=0, microsecond=0))
    db.commit()
    _as_notifier(monkeypatch)
    out = Outbox()
    push_down = True

    def push(s: Session, user_id: int, payload: dict[str, Any]) -> int:
        if push_down:
            raise ConnectionError("push-сервис недоступен")
        return out.push(s, user_id, payload)

    assert deliver_pending(db, now, mail=out.mail, push=push) == 0
    db.refresh(trig)
    state = delivery_state(trig)
    assert state["status"] == QUEUED and state["mail_done"] is True and "push_done" not in state
    assert "push-сервис" in state["error"]
    assert len(out.mails) == 1 and out.pushes == []
    push_down = False
    later = datetime.fromisoformat(state["retry_at"]) + timedelta(seconds=1)
    assert deliver_pending(db, later, mail=out.mail, push=push) == 1
    db.refresh(trig)
    assert trig.notified and delivery_state(trig)["status"] == SENT
    assert len(out.mails) == 1 and len(out.pushes) == 1


@db_only
def test_daily_limit_counts_mail_of_partly_failed_attempt(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Лимит 1 письмо в день. Письмо по первому срабатыванию ушло, push упал: попытка
    откатилась, но письмо в лимите засчитано — второе срабатывание подавлено, а push первого на
    повторе уходит (лимит, исчерпанный его же письмом, его не подавляет)."""
    _as_alerts_service(monkeypatch)
    _, alert, ns = _alert_setup(db, daily_limit=1)
    _only(monkeypatch, {alert.id})
    now = datetime.now(tz=UTC)
    first = _fire_one(db, alert, (now - timedelta(minutes=2)).replace(second=0, microsecond=0))
    second = _fire_one(db, alert, (now - timedelta(minutes=1)).replace(second=0, microsecond=0))
    db.commit()
    _as_notifier(monkeypatch)
    out = Outbox()
    push_fails = [True]

    def flaky_push(s: Session, user_id: int, payload: dict[str, Any]) -> int:
        if push_fails and push_fails.pop():
            raise ConnectionError("push-сервис недоступен")
        return out.push(s, user_id, payload)

    assert deliver_pending(db, now, mail=out.mail, push=flaky_push) == 1
    for r in (first, second, ns):
        db.refresh(r)
    assert [m[3] for m in out.mails] == [f"alert-trigger-{first.id}"]
    assert ns.sent_today == 1
    assert delivery_state(first)["mail_done"] is True and delivery_state(first)["status"] == QUEUED
    assert delivery_state(second) == {"status": SUPPRESSED, "reason": "daily_limit"}
    later = datetime.fromisoformat(delivery_state(first)["retry_at"]) + timedelta(seconds=1)
    assert deliver_pending(db, later, mail=out.mail, push=flaky_push) == 1
    db.refresh(first)
    db.refresh(ns)
    assert first.notified and delivery_state(first)["status"] == SENT
    assert len(out.mails) == 1 and [p[1]["tag"] for p in out.pushes] == [f"alert-{first.id}"]
    assert ns.sent_today == 1


@db_only
def test_mail_retry_respects_limit_used_by_other_triggers(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Push ушёл, письмо упало (503); пока оно ждало повтора, лимит исчерпало письмо другого
    срабатывания — повтор письмо не шлёт (``mail_skipped``), срабатывание доставлено push."""
    _as_alerts_service(monkeypatch)
    _, alert, ns = _alert_setup(db, daily_limit=1)
    _only(monkeypatch, {alert.id})
    now = datetime.now(tz=UTC)
    first = _fire_one(db, alert, (now - timedelta(minutes=2)).replace(second=0, microsecond=0))
    db.commit()
    _as_notifier(monkeypatch)
    out = Outbox()
    assert deliver_pending(db, now, mail=Outbox(fail_mail=503).mail, push=out.push) == 0
    db.refresh(first)
    assert delivery_state(first)["push_done"] is True
    _as_alerts_service(monkeypatch)
    second = _fire_one(db, alert, (now - timedelta(minutes=1)).replace(second=0, microsecond=0))
    db.commit()
    _as_notifier(monkeypatch)
    assert deliver_pending(db, now, mail=out.mail, push=out.push) == 1
    later = datetime.fromisoformat(delivery_state(first)["retry_at"]) + timedelta(seconds=1)
    assert deliver_pending(db, later, mail=out.mail, push=out.push) == 1
    for r in (first, second, ns):
        db.refresh(r)
    assert [m[3] for m in out.mails] == [f"alert-trigger-{second.id}"] and ns.sent_today == 1
    assert first.notified and delivery_state(first)["status"] == SENT
    assert delivery_state(first)["mail_skipped"] == "daily_limit"
    assert len(out.pushes) == 2


@db_only
def test_mail_outage_does_not_stall_the_pass(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    """Почта недоступна (таймаут сети): в проходе одна попытка письма, остальные письма ждут
    ``DELIVERY_RETRY_AFTER`` без попыток, push по всем срабатываниям уходит сразу; почта ожила —
    письма уходят по одному на срабатывание."""
    _as_alerts_service(monkeypatch)
    _, alert, _ = _alert_setup(db)
    _only(monkeypatch, {alert.id})
    now = datetime.now(tz=UTC)
    trigs = [
        _fire_one(db, alert, (now - timedelta(minutes=i)).replace(second=0, microsecond=0))
        for i in range(3)
    ]
    db.commit()
    _as_notifier(monkeypatch)
    out = Outbox()
    tries: list[str | None] = []

    def timeout(to: str, subject: str, text: str, idempotency_key: str | None = None) -> None:
        tries.append(idempotency_key)
        raise httpx.ConnectTimeout("timed out")

    assert deliver_pending(db, now, mail=timeout, push=out.push) == 0
    assert len(tries) == 1 and len(out.pushes) == 3
    for r in trigs:
        db.refresh(r)
    states = sorted((delivery_state(r) for r in trigs), key=lambda st: "attempts" in st)
    assert [st.get("attempts") for st in states] == [None, None, 1]
    assert all(st["push_done"] is True and st["status"] == QUEUED for st in states)
    assert [st.get("waiting") for st in states[:2]] == [["mail"], ["mail"]]
    later = now + alerts_mod.DELIVERY_RETRY_AFTER + timedelta(seconds=1)
    assert deliver_pending(db, later, mail=out.mail, push=out.push) == 3
    assert sorted(m[3] or "" for m in out.mails) == sorted(f"alert-trigger-{r.id}" for r in trigs)
    assert len(out.pushes) == 3


@db_only
def test_expected_refusals_are_logged_without_traceback(
    db: Session, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Отказ провайдера (неверный MAIL_FROM) — предупреждение без трассировки: при сбое почты
    такие строки идут на каждую попытку. Непредвиденная ошибка (в коде, в данных подписки) —
    с трассировкой, как и раньше."""
    _as_alerts_service(monkeypatch)
    _, alert, _ = _alert_setup(db)
    _only(monkeypatch, {alert.id})
    now = datetime.now(tz=UTC)
    _fire_one(db, alert, (now - timedelta(minutes=1)).replace(second=0, microsecond=0))
    db.commit()
    _as_notifier(monkeypatch)
    out = Outbox()

    def delivery_logs() -> list[logging.LogRecord]:
        return [r for r in caplog.records if r.name == "alerts" and "срабатывание" in r.msg]

    with caplog.at_level(logging.WARNING, logger="alerts"):
        bad_from = Outbox(fail_mail=400, fail_message=BAD_FROM)
        assert deliver_pending(db, now, mail=bad_from.mail, push=out.push) == 0
    [rec] = delivery_logs()
    assert rec.levelno == logging.WARNING and rec.exc_info is None
    assert "Resend 400" in rec.getMessage()
    caplog.clear()
    _as_alerts_service(monkeypatch)
    _fire_one(db, alert, now.replace(second=0, microsecond=0))
    db.commit()
    _as_notifier(monkeypatch)

    def broken_push(s: Session, user_id: int, payload: dict[str, Any]) -> int:
        raise RuntimeError("push: ошибка в данных подписки")

    with caplog.at_level(logging.WARNING, logger="alerts"):
        assert deliver_pending(db, now, mail=out.mail, push=broken_push) == 0
    errors = [r for r in delivery_logs() if r.levelno == logging.ERROR]
    assert len(errors) == 1 and errors[0].exc_info is not None


@db_only
def test_rejected_address_fails_without_retries(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Постоянный отказ (422 по полю ``to`` — неверный адрес), а push пользователь не выбрал:
    доставить нечем, повтор не поможет — сразу ``failed``, письмо больше не пробуем."""
    _as_alerts_service(monkeypatch)
    _, alert, _ = _alert_setup(db, push_alerts=False)
    _only(monkeypatch, {alert.id})
    now = datetime.now(tz=UTC)
    trig = _fire_one(db, alert, now.replace(second=0, microsecond=0))
    db.commit()
    _as_notifier(monkeypatch)
    tries: list[str | None] = []

    def refused(to: str, subject: str, text: str, idempotency_key: str | None = None) -> None:
        tries.append(idempotency_key)
        raise MailError(422, "validation_error", BAD_TO)

    assert deliver_pending(db, now, mail=refused) == 1
    db.refresh(trig)
    state = delivery_state(trig)
    assert state["status"] == FAILED and "422" in state["error"] and "422" in state["mail_refused"]
    assert not trig.notified
    assert deliver_pending(db, now + timedelta(hours=1), mail=refused) == 0
    assert len(tries) == 1


@db_only
def test_rejected_address_does_not_drop_push(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    """Регрессия: постоянный отказ почты делал ``failed`` всё срабатывание, и push, ещё не
    дошедший до пользователя, пропадал навсегда. Теперь отказ решает только судьбу письма.

    - push упал в той же попытке (сеть) — уходит на повторе, письмо не повторяется;
    - push ушёл, письмо отклонено — срабатывание доставлено (``sent``, ``notified``).
    """
    _as_alerts_service(monkeypatch)
    _, flaky, _ = _alert_setup(db)
    _, ok, _ = _alert_setup(db)
    _only(monkeypatch, {flaky.id, ok.id})
    now = datetime.now(tz=UTC)
    at = now.replace(second=0, microsecond=0)
    t_flaky, t_ok = _fire_one(db, flaky, at), _fire_one(db, ok, at)
    db.commit()
    _as_notifier(monkeypatch)
    out = Outbox()
    refused = Outbox(fail_mail=422, fail_message=BAD_TO)
    down = {flaky.user_id}

    def push(s: Session, user_id: int, payload: dict[str, Any]) -> int:
        if user_id in down:
            raise ConnectionError("push-сервис недоступен")
        return out.push(s, user_id, payload)

    assert deliver_pending(db, now, mail=refused.mail, push=push) == 1  # t_ok решено
    for r in (t_flaky, t_ok):
        db.refresh(r)
    st_ok = delivery_state(t_ok)
    assert t_ok.notified and st_ok["status"] == SENT and st_ok["push_done"] is True
    assert "422" in st_ok["mail_refused"]
    st = delivery_state(t_flaky)
    assert st["status"] == QUEUED and st["attempts"] == 1 and "422" in st["mail_refused"]
    assert "push_done" not in st and not t_flaky.notified
    down.clear()  # push-сервис ожил
    later = datetime.fromisoformat(st["retry_at"]) + timedelta(seconds=1)
    assert deliver_pending(db, later, mail=out.mail, push=push) == 1
    db.refresh(t_flaky)
    assert t_flaky.notified and delivery_state(t_flaky)["status"] == SENT
    assert sorted(p[1]["tag"] for p in out.pushes) == sorted(
        f"alert-{r.id}" for r in (t_flaky, t_ok)
    )
    assert out.mails == []  # отклонённое письмо не повторялось
    assert deliver_pending(db, later + timedelta(hours=1), mail=out.mail, push=push) == 0


@db_only
def test_rejected_address_while_push_waits_for_vapid(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Регрессия: у уведомителя в production нет VAPID, push ждёт ключей, а письмо отклонено по
    адресу. Раньше срабатывание становилось ``failed``, и push не уходил и после возврата ключей.
    Теперь оно ждёт push: ключи вернулись — push уходит, письмо не повторяется."""
    _production(monkeypatch)
    _as_alerts_service(monkeypatch)
    _, alert, _ = _alert_setup(db)
    _only(monkeypatch, {alert.id})
    now = datetime.now(tz=UTC)
    trig = _fire_one(db, alert, now.replace(second=0, microsecond=0))
    db.commit()
    _keys(monkeypatch, mail=True, push=False)  # уведомитель без VAPID
    out = Outbox()
    refused = Outbox(fail_mail=422, fail_message=BAD_TO)
    assert deliver_pending(db, now, mail=refused.mail, push=out.push) == 0
    db.refresh(trig)
    state = delivery_state(trig)
    assert state["status"] == QUEUED and state["waiting"] == ["push"]
    assert "422" in state["mail_refused"] and "attempts" not in state
    _keys(monkeypatch, mail=True, push=True)
    later = now + timedelta(minutes=20)
    assert deliver_pending(db, later, mail=out.mail, push=out.push) == 1
    db.refresh(trig)
    assert trig.notified and delivery_state(trig)["status"] == SENT
    assert [p[1]["tag"] for p in out.pushes] == [f"alert-{trig.id}"] and out.mails == []


@db_only
def test_inline_rejected_address_still_pushes(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    """Воркер с полным набором ключей доставляет сам: отказ по адресу не мешает push, срабатывание
    доставлено, уведомитель его больше не трогает."""
    _as_notifier(monkeypatch)
    _, alert, _ = _alert_setup(db)
    _only(monkeypatch, {alert.id})
    out = Outbox()
    refused = Outbox(fail_mail=422, fail_message=BAD_TO)
    monkeypatch.setattr(alerts_mod, "_alert_mail", refused.mail)
    monkeypatch.setattr(alerts_mod, "send_to_user", out.push)
    now = datetime.now(tz=UTC)
    trig = _fire_one(db, alert, now.replace(second=0, microsecond=0))
    db.commit()
    db.refresh(trig)
    state = delivery_state(trig)
    assert trig.notified and state["status"] == SENT and "422" in state["mail_refused"]
    assert len(out.pushes) == 1
    assert deliver_pending(db, now + timedelta(minutes=5), mail=out.mail, push=out.push) == 0


@db_only
def test_unsubscribe_link_stops_alert_emails(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    """Ссылка «Отписаться от писем» стоит и в письмах алертов, а страница обещает отписку «от всех
    писем»: после неё письма алертов не уходят (срабатывание из очереди тоже), push остаётся."""
    _production(monkeypatch)
    _as_alerts_service(monkeypatch)
    _, alert, ns = _alert_setup(db)
    _only(monkeypatch, {alert.id})
    now = datetime.now(tz=UTC)
    queued = _fire_one(db, alert, now.replace(second=0, microsecond=0))
    db.commit()
    assert unsubscribe(db, ns.unsubscribe_token)
    db.refresh(ns)
    assert ns.email_digest == "off" and not ns.email_signals and not ns.email_events
    assert ns.email_alerts is False and ns.push_alerts is True
    _as_notifier(monkeypatch)
    out = Outbox()
    assert deliver_pending(db, now, mail=out.mail, push=out.push) == 1
    db.refresh(queued)
    assert out.mails == [] and len(out.pushes) == 1
    assert queued.notified and delivery_state(queued)["status"] == SENT
    assert "mail_done" not in delivery_state(queued)


# --- параллельная работа: настоящие транзакции ----------------------------------------------------


def _cleanup(user_ids: list[int], inst_ids: list[int], log_ref: str | None = None) -> None:
    with SessionLocal() as s:
        if log_ref is not None:
            s.execute(delete(NotificationLog).where(NotificationLog.ref == log_ref))
        s.execute(delete(NotificationLog).where(NotificationLog.user_id.in_(user_ids)))
        s.execute(delete(Alert).where(Alert.user_id.in_(user_ids)))
        s.execute(delete(NotificationSettings).where(NotificationSettings.user_id.in_(user_ids)))
        s.execute(delete(User).where(User.id.in_(user_ids)))
        s.execute(delete(Instrument).where(Instrument.id.in_(inst_ids)))
        s.commit()


@db_only
def test_two_notifiers_never_deliver_twice(monkeypatch: pytest.MonkeyPatch) -> None:
    """Выкладка без простоя: два уведомителя разбирают одну очередь. Строку, занятую одним,
    другой пропускает (SKIP LOCKED); каждое срабатывание — ровно одно письмо и один push."""
    _as_alerts_service(monkeypatch)
    with SessionLocal() as s:
        user, alert, _ = _alert_setup(s)
        user_id, inst_id, alert_id = user.id, alert.instrument_id, alert.id
        now = datetime.now(tz=UTC).replace(second=0, microsecond=0)
        ids = [_fire_one(s, alert, now - timedelta(minutes=i)).id for i in range(8)]
        s.commit()
    assert inst_id is not None
    _as_notifier(monkeypatch)
    _only(monkeypatch, {alert_id})
    try:
        # 1) строка занята другим экземпляром — пропускается, потом доставляется
        out = Outbox()
        with SessionLocal() as holder, SessionLocal() as worker:
            assert holder.get(AlertTrigger, ids[0], with_for_update=True) is not None
            assert deliver_pending(worker, mail=out.mail, push=out.push, limit=3) == 2
            holder.rollback()
            assert deliver_pending(worker, mail=out.mail, push=out.push, limit=1) == 1
        assert sorted(m[3] or "" for m in out.mails) == sorted(
            f"alert-trigger-{i}" for i in ids[:3]
        )
        # 2) два экземпляра одновременно, письмо «отправляется» 50 мс
        slow = Outbox(delay=0.05)
        start = threading.Barrier(2)
        done: list[int] = []

        def notifier() -> None:
            with SessionLocal() as s:
                start.wait()
                done.append(deliver_pending(s, mail=slow.mail, push=slow.push))

        threads = [threading.Thread(target=notifier) for _ in range(2)]
        for th in threads:
            th.start()
        for th in threads:
            th.join(30)
        keys = [m[3] for m in slow.mails]
        assert sorted(keys) == sorted(f"alert-trigger-{i}" for i in ids[3:])
        assert len(slow.pushes) == 5 and sum(done) == 5
        with SessionLocal() as s:
            rows = s.scalars(select(AlertTrigger).where(AlertTrigger.id.in_(ids))).all()
            assert all(r.notified and delivery_state(r)["status"] == SENT for r in rows)
    finally:
        _cleanup([user_id], [inst_id])


@db_only
def test_digest_without_mail_key_in_production_marks_nothing(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Cron-сервис digest на Railway без RESEND_API_KEY: ничего не шлёт и не отмечает."""
    _production(monkeypatch)
    _keys(monkeypatch, mail=False, push=False)
    user = _user(db)
    db.add(
        NotificationSettings(
            user_id=user.id, unsubscribe_token=secrets.token_urlsafe(24), email_digest="daily"
        )
    )
    db.flush()
    sent: list[str] = []
    monkeypatch.setattr(notify_mod, "digest_text", lambda *a: "дайджест")
    monkeypatch.setattr(notify_mod, "send_mail", lambda to, *a, **kw: sent.append(to))
    now = datetime(2031, 3, 4, 7, tzinfo=UTC)
    assert run_digest(db, "daily", now) == 0
    assert sent == []
    assert db.scalar(select(NotificationLog).where(NotificationLog.user_id == user.id)) is None


@db_only
def test_digest_refused_by_provider_is_not_marked(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Письмо, которое Resend не принял, не отмечается отправленным. Временный отказ (503)
    прерывает проход — его повторит уведомитель; отправленным повтор дубля не шлёт."""
    _keys(monkeypatch, mail=True, push=False)
    users = [_user(db) for _ in range(3)]
    for u in users:
        db.add(
            NotificationSettings(
                user_id=u.id, unsubscribe_token=secrets.token_urlsafe(24), email_digest="daily"
            )
        )
    db.flush()
    ids = {u.id for u in users}
    emails = [u.email for u in users]
    codes = {emails[0]: 200, emails[1]: 422, emails[2]: 503}
    sent: list[str] = []

    def fake_send(
        to: str, subject: str, body: str, idempotency_key: str | None = None, strict: bool = False
    ) -> None:
        assert strict and idempotency_key
        if codes[to] >= 300:
            raise MailError(codes[to], "validation_error", BAD_TO if codes[to] == 422 else "")
        sent.append(to)

    def marked() -> set[int]:
        return set(
            db.scalars(
                select(NotificationLog.user_id).where(
                    NotificationLog.user_id.in_(ids), NotificationLog.ref == "daily:2031-03-06"
                )
            ).all()
        )

    monkeypatch.setattr(
        notify_mod, "digest_text", lambda db, user, *a: "дайджест" if user.id in ids else None
    )
    monkeypatch.setattr(notify_mod, "send_mail", fake_send)
    now = datetime(2031, 3, 6, 6, 5, tzinfo=UTC)
    with pytest.raises(MailError):
        run_digest(db, "daily", now)
    assert sent == [emails[0]] and marked() == {users[0].id}
    codes[emails[2]] = 200  # провайдер ожил
    assert run_digest(db, "daily", now) == 1
    assert sent == [emails[0], emails[2]] and marked() == {users[0].id, users[2].id}


@db_only
def test_two_digest_runs_send_once(monkeypatch: pytest.MonkeyPatch) -> None:
    """Уведомитель и cron-скрипт (или два уведомителя при выкладке) в одну минуту: каждому
    пользователю — одно письмо и одна отметка; повторный проход ничего не шлёт."""
    _keys(monkeypatch, mail=True, push=False)
    now = datetime(2031, 3, 5, 6, 5, tzinfo=UTC)
    with SessionLocal() as s:
        users = [_user(s) for _ in range(4)]
        for u in users:
            s.add(
                NotificationSettings(
                    user_id=u.id, unsubscribe_token=secrets.token_urlsafe(24), email_digest="daily"
                )
            )
        s.commit()
        ids = {u.id for u in users}
        emails = {u.email for u in users}
    sent: list[tuple[str, str | None]] = []
    lock = threading.Lock()

    def text_for(db: Session, user: User, period: str, at: datetime) -> str | None:
        return "дайджест" if user.id in ids else None  # чужих пользователей общей БД не трогаем

    def fake_send(
        to: str, subject: str, body: str, idempotency_key: str | None = None, **kw: Any
    ) -> None:
        assert kw == {"strict": True}  # отказ провайдера не должен отмечаться отправленным
        time.sleep(0.05)
        with lock:
            sent.append((to, idempotency_key))

    monkeypatch.setattr(notify_mod, "digest_text", text_for)
    monkeypatch.setattr(notify_mod, "send_mail", fake_send)
    start = threading.Barrier(2)
    counts: list[int] = []

    def run() -> None:
        with SessionLocal() as s:
            start.wait()
            counts.append(run_digest(s, "daily", now))

    try:
        threads = [threading.Thread(target=run) for _ in range(2)]
        for th in threads:
            th.start()
        for th in threads:
            th.join(30)
        assert sorted(to for to, _ in sent) == sorted(emails)
        assert sum(counts) == 4
        assert all(k and k.startswith("digest-") and ":" not in k for _, k in sent)
        with SessionLocal() as s:
            assert run_digest(s, "daily", now) == 0
            logs = s.scalars(
                select(NotificationLog).where(
                    NotificationLog.user_id.in_(ids), NotificationLog.ref == "daily:2031-03-05"
                )
            ).all()
        assert len(logs) == 4 and len(sent) == 4
    finally:
        _cleanup(sorted(ids), [])


@db_only
@pytest.mark.parametrize(
    ("code", "name", "message"),
    [
        (422, "missing_required_field", "Missing `from` field."),
        (400, "validation_error", BAD_FROM),
        (401, "validation_error", "API key is invalid"),
    ],
)
def test_digest_config_refusal_keeps_the_day_for_retry(
    monkeypatch: pytest.MonkeyPatch, code: int, name: str, message: str
) -> None:
    """Неверный MAIL_FROM или ключ: Resend отказывает всем (400/422/401), а не одному адресу.
    Проход прерывается, ничего не отмечено, отметка дня в Redis — только аренда; настройки
    исправили — повтор в тот же день доставляет всем по одному письму."""
    _keys(monkeypatch, mail=True, push=True)
    now = datetime(2031, 3, 10, 7, 0, tzinfo=UTC)  # понедельник
    with SessionLocal() as s:
        users = [_user(s) for _ in range(3)]
        for u in users:
            s.add(
                NotificationSettings(
                    user_id=u.id, unsubscribe_token=secrets.token_urlsafe(24), email_digest="daily"
                )
            )
        s.commit()
        ids = {u.id for u in users}
    monkeypatch.setattr(
        notify_mod, "digest_text", lambda db, user, *a: "дайджест" if user.id in ids else None
    )
    monkeypatch.setattr(notify_mod, "journal_report_text", lambda *a: None)
    calls: list[dict[str, Any]] = []
    key = notifier_mod.KEY_DIGEST + "date"

    def run() -> list[tuple[str, str, int | None]]:
        async def go() -> list[tuple[str, str, int | None]]:
            n = notifier_mod.Notifier()
            real, fake = n.redis, _FakeRedis()
            n.redis = fake  # type: ignore[assignment]
            try:
                await n.digests(now)
            finally:
                await real.aclose()
            return fake.sets

        return asyncio.run(go())

    def marked() -> int:
        with SessionLocal() as s:
            return len(
                s.scalars(
                    select(NotificationLog).where(
                        NotificationLog.user_id.in_(ids), NotificationLog.kind == "digest"
                    )
                ).all()
            )

    try:
        monkeypatch.setattr(mail_mod.httpx, "post", _fake_post(calls, code, name, message))
        assert run() == [(key, "2031-03-10", notifier_mod.DIGEST_RETRY_AFTER)]
        assert marked() == 0 and len(calls) == 1  # первый же отказ прерывает проход
        monkeypatch.setattr(mail_mod.httpx, "post", _fake_post(calls, 200))
        assert run()[-1] == (key, "2031-03-10", 3 * 86400)
        assert marked() == 3
        mailed = [c for c in calls[1:] if c["json"]["to"][0].startswith("ops-")]
        assert len({c["headers"]["Idempotency-Key"] for c in mailed}) == 3
    finally:
        _cleanup(sorted(ids), [])


@db_only
def test_owner_recipients_union_of_env_and_db(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    now = datetime.now(tz=UTC)
    active = _user(db, role="owner")
    unverified = _user(db, role="owner", email_verified_at=None)
    blocked = _user(db, role="owner", blocked_at=now)
    deleted = _user(db, role="owner", deleted_at=now)
    plain = _user(db, role="admin")
    monkeypatch.setattr(settings, "owner_emails", " Env-Owner@Example.com ,")
    got = owner_recipients(db)
    assert "env-owner@example.com" in got and active.email in got
    for u in (unverified, blocked, deleted, plain):
        assert u.email not in got
    # у уведомителя на Railway OWNER_EMAILS нет — владелец из БД всё равно получает письмо
    monkeypatch.setattr(settings, "owner_emails", "")
    assert active.email in owner_recipients(db)


@db_only
def test_incident_mail_goes_to_db_owner_without_owner_emails(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "owner_emails", "")
    monkeypatch.setattr(settings, "frontend_url", PRODUCTION_FRONTEND_URL)
    owner = _user(db, role="owner")
    now = datetime.now(tz=UTC)
    inc = Incident(component="ops_test", severity="down", message="нет свечей", opened_at=now)
    db.add(inc)
    db.flush()
    sent: list[tuple[str, str, str]] = []
    monkeypatch.setattr(
        monitor_mod, "send_mail", lambda to, s, b, *a, **kw: sent.append((to, s, b))
    )
    comps = [Component("ops_test", "Тестовый компонент", "down", "нет свечей")]
    assert send_alerts(db, comps, now) >= 1
    mine = [m for m in sent if m[0] == owner.email and "Тестовый компонент" in m[1]]
    assert len(mine) == 1 and f"{PRODUCTION_FRONTEND_URL}/status" in mine[0][2]
    assert inc.alerted_at == now
    sent.clear()
    send_alerts(db, comps, now + timedelta(minutes=5))  # раньше 6 часов — не повторяется
    assert not [m for m in sent if "Тестовый компонент" in m[1]]


@db_only
def test_incident_mail_network_error_does_not_resend_sent_ones(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Таймаут сети на втором письме прогона: прогон не падает, открытые инциденты и отметка
    первого письма зафиксированы; следующий прогон шлёт только неотправленные — недошедшее с тем
    же ключом идемпотентности (если Resend его всё-таки принял, второго письма не будет)."""
    monkeypatch.setattr(settings, "resend_api_key", "re_test")
    monkeypatch.setattr(settings, "owner_emails", "")  # как у уведомителя на Railway
    tag = secrets.token_hex(3)
    comps = [Component(f"ops_{tag}_{i}", f"Тест {tag} {i}", "down", "нет данных") for i in range(4)]
    keys = [c.key for c in comps]
    with SessionLocal() as s:
        owner = _user(s, role="owner")
        s.commit()
        owner_id, owner_email = owner.id, owner.email
    calls: list[tuple[str, str]] = []
    fail_on = [2]  # номер нашего письма, на котором сеть «падает» (только в первом прогоне)

    def post(url: str, **kw: Any) -> _Resp:
        subject = kw["json"]["subject"]
        if tag not in subject or kw["json"]["to"] != [owner_email]:
            return _Resp(200)  # инциденты и владельцы общей БД — не наши
        calls.append((subject, kw["headers"]["Idempotency-Key"]))
        if fail_on and len(calls) == fail_on[0]:
            fail_on.clear()
            raise httpx.ReadTimeout("read timed out")
        return _Resp(200)

    monkeypatch.setattr(mail_mod.httpx, "post", post)
    now = datetime(2031, 3, 7, 12, 0, tzinfo=UTC)
    clock = [now]
    snap = monitor_mod.Snapshot(
        now=now,
        heartbeats={},
        m1_age_sec=None,
        h4_stale=0,
        h4_total=0,
        engine_last_h4=None,
        api_db_ok=True,
        redis_ok=False,
    )
    monkeypatch.setattr(
        monitor_mod, "collect", lambda db, r: dataclasses.replace(snap, now=clock[0])
    )
    monkeypatch.setattr(monitor_mod, "evaluate", lambda sn: comps)

    def rows() -> list[Incident]:
        with SessionLocal() as s:
            return list(
                s.scalars(
                    select(Incident).where(Incident.component.in_(keys)).order_by(Incident.id)
                ).all()
            )

    try:
        with SessionLocal() as s:
            monitor_mod.run_monitor(s, None)  # не падает
        first = rows()
        assert len(first) == 4  # инциденты открыты и зафиксированы, несмотря на сбой письма
        assert [r.alerted_at is not None for r in first] == [True, False, False, False]
        assert len(calls) == 2
        clock[0] = now + timedelta(minutes=1)
        with SessionLocal() as s:
            monitor_mod.run_monitor(s, None)
        assert all(r.alerted_at is not None for r in rows())
        clock[0] = now + timedelta(minutes=2)
        with SessionLocal() as s:
            monitor_mod.run_monitor(s, None)
        per_subject: dict[str, list[str]] = {}
        for subject, key in calls:
            per_subject.setdefault(subject, []).append(key)
        assert len(per_subject) == 4 and len(calls) == 5
        retried = [k for k in per_subject.values() if len(k) > 1]
        assert len(retried) == 1 and retried[0][0] == retried[0][1]  # тот же ключ
        assert len({k for k, *_ in per_subject.values()}) == 4
    finally:
        with SessionLocal() as s:
            s.execute(delete(Incident).where(Incident.component.in_(keys)))
            s.commit()
        _cleanup([owner_id], [])


@db_only
def test_incidents_lock_lets_only_one_monitor_in() -> None:
    with SessionLocal() as a, SessionLocal() as b:
        assert incidents_lock(a)
        assert not incidents_lock(b)  # второй экземпляр пропускает инциденты
        a.commit()  # блокировка — на транзакцию
        assert incidents_lock(b)
        b.rollback()


def _redis_available() -> bool:
    import redis as sync_redis

    try:
        r = sync_redis.from_url(settings.redis_url, socket_timeout=1)
        try:
            return bool(r.ping())
        finally:
            r.close()
    except Exception:
        return False


redis_only = pytest.mark.skipif(not _redis_available(), reason="Redis недоступен")


@db_only
@redis_only
def test_worker_message_wakes_notifier_through_redis(monkeypatch: pytest.MonkeyPatch) -> None:
    """Настоящие Redis и PostgreSQL: срабатывание записано в очередь, воркер алертов публикует в
    ``alerts.triggered`` — уведомитель доставляет сразу, не дожидаясь опроса очереди (60 с)."""
    from app.workers.alerts import AlertsWorker

    _as_alerts_service(monkeypatch)
    with SessionLocal() as s:
        user, alert, _ = _alert_setup(s)
        user_id, inst_id, alert_id = user.id, alert.instrument_id, alert.id
        s.commit()
    assert inst_id is not None
    _only(monkeypatch, {alert_id})
    out = Outbox()
    passes: list[int] = []

    def once() -> alerts_mod.DeliveryPass:
        _as_notifier(monkeypatch)
        with SessionLocal() as s:
            res = alerts_mod.deliver_batch(s, mail=out.mail, push=out.push)
        passes.append(res.decided)
        return res

    def fire() -> None:
        with SessionLocal() as s:
            a = s.get(Alert, alert_id)
            assert a is not None
            at = datetime.now(tz=UTC).replace(second=0, microsecond=0)
            assert _fire(s, a, at, Decimal("100.5"), {"close": "100.5", "tf": "1m"}) == 1
            s.commit()

    monkeypatch.setattr(notifier_mod, "alerts_once", once)
    monkeypatch.setattr(notifier_mod, "ALERTS_POLL", 60)

    async def go() -> float:
        n = notifier_mod.Notifier()
        w = AlertsWorker()
        tasks = [asyncio.create_task(n.alerts_listener()), asyncio.create_task(n.alerts_loop())]
        try:
            for _ in range(200):  # подписка уведомителя на месте и первый (пустой) проход прошёл
                subs = dict(await n.redis.pubsub_numsub(CHANNEL_TRIGGERED))
                if subs.get(CHANNEL_TRIGGERED.encode(), 0) >= 1 and passes:
                    break
                await asyncio.sleep(0.05)
            assert passes == [0]
            _as_alerts_service(monkeypatch)
            await asyncio.to_thread(fire)
            t0 = time.monotonic()
            await w._nudge(1)
            while not out.mails and time.monotonic() - t0 < 10:
                await asyncio.sleep(0.05)
            return time.monotonic() - t0
        finally:
            n.stop.set()
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await n.redis.aclose()
            await w.redis.aclose()

    try:
        elapsed = asyncio.run(go())
        assert len(out.mails) == 1 and len(out.pushes) == 1, (out.mails, out.pushes)
        assert elapsed < 10 and passes[-1] == 1
        with SessionLocal() as s:
            rows = s.scalars(select(AlertTrigger).where(AlertTrigger.alert_id == alert_id)).all()
            assert len(rows) == 1 and rows[0].notified
            assert delivery_state(rows[0])["status"] == SENT
    finally:
        _cleanup([user_id], [inst_id])


# --- уведомитель: всплеск срабатываний и перезапуск Redis ----------------------------------------


def test_alerts_loop_continues_on_full_batch(monkeypatch: pytest.MonkeyPatch) -> None:
    """Полная выборка, в которой этот экземпляр что-то обработал, — следующий проход сразу (даже
    если часть строк решить не удалось или их забрал второй уведомитель); полная, но целиком
    занятая другим экземпляром — короткая пауза; неполная — обычный опрос."""
    dp = alerts_mod.DeliveryPass
    passes = iter(
        [dp(150, 190, True), dp(0, 3, True), dp(0, 0, True), dp(40, 40, False), dp(0, 0, False)]
    )
    monkeypatch.setattr(notifier_mod, "alerts_once", lambda: next(passes))
    waits: list[float] = []

    async def go() -> None:
        n = notifier_mod.Notifier()

        async def wait(timeout: float) -> None:
            waits.append(timeout)
            if len(waits) == 3:
                n.stop.set()

        n._wait_alerts = wait  # type: ignore[method-assign]
        try:
            await n.alerts_loop()
        finally:
            await n.redis.aclose()

    asyncio.run(go())
    assert waits == [notifier_mod.ALERTS_BUSY, notifier_mod.ALERTS_POLL, notifier_mod.ALERTS_POLL]


def test_supervised_loop_restarts_after_crash(monkeypatch: pytest.MonkeyPatch) -> None:
    """Необработанная ошибка цикла не завершает процесс и не останавливает другие циклы."""
    monkeypatch.setattr(notifier_mod, "RESTART_AFTER", 0.01)
    runs: list[int] = []

    async def go() -> None:
        n = notifier_mod.Notifier()

        async def flaky() -> None:
            runs.append(1)
            if len(runs) < 3:
                raise ConnectionError("Connection closed by server")
            n.stop.set()

        try:
            await asyncio.wait_for(n._supervised("тест", flaky), 5)
        finally:
            await n.redis.aclose()

    asyncio.run(go())
    assert len(runs) == 3


@db_only
def test_two_notifiers_drain_burst_without_poll_waits(monkeypatch: pytest.MonkeyPatch) -> None:
    """Всплеск: 60 срабатываний, проход по 10, два уведомителя бок о бок (выкладка). Очередь
    разбирается без ожидания опроса (он здесь 60 с), каждое срабатывание решено один раз, и
    дневной лимит писем (20 по умолчанию) соблюдён, хотя счётчик увеличивают оба экземпляра."""
    _as_alerts_service(monkeypatch)
    with SessionLocal() as s:
        user, alert, _ = _alert_setup(s)
        user_id, inst_id, alert_id = user.id, alert.instrument_id, alert.id
        now = datetime.now(tz=UTC).replace(second=0, microsecond=0)
        ids = [_fire_one(s, alert, now - timedelta(minutes=i)).id for i in range(60)]
        s.commit()
    assert inst_id is not None
    _as_notifier(monkeypatch)
    _only(monkeypatch, {alert_id})
    out = Outbox(delay=0.005)
    decided: list[int] = []

    def once() -> alerts_mod.DeliveryPass:
        with SessionLocal() as s:
            res = alerts_mod.deliver_batch(s, mail=out.mail, push=out.push, limit=10)
        decided.append(res.decided)
        return res

    monkeypatch.setattr(notifier_mod, "alerts_once", once)
    monkeypatch.setattr(notifier_mod, "ALERTS_POLL", 60)

    async def go() -> float:
        ns = [notifier_mod.Notifier(), notifier_mod.Notifier()]
        tasks = [asyncio.create_task(n.alerts_loop()) for n in ns]
        t0 = time.monotonic()
        try:
            while sum(decided) < 60 and time.monotonic() - t0 < 30:
                await asyncio.sleep(0.05)
            return time.monotonic() - t0
        finally:
            for n in ns:
                n.stop.set()
            await asyncio.gather(*tasks, return_exceptions=True)
            for n in ns:
                await n.redis.aclose()

    try:
        elapsed = asyncio.run(go())
        assert sum(decided) == 60 and elapsed < 20, (decided, elapsed)
        keys = [m[3] for m in out.mails]
        assert len(keys) == 20 and len(set(keys)) == 20  # лимит — 20 писем в день
        with SessionLocal() as s:
            rows = s.scalars(select(AlertTrigger).where(AlertTrigger.id.in_(ids))).all()
            sent = {f"alert-trigger-{r.id}" for r in rows if delivery_state(r)["status"] == SENT}
            limited = [r for r in rows if delivery_state(r).get("reason") == "daily_limit"]
            assert sent == set(keys) and len(limited) == 40
            assert sorted(p[1]["tag"] for p in out.pushes) == sorted(
                f"alert-{r.id}" for r in rows if r.notified
            )
            assert s.get(NotificationSettings, user_id).sent_today == 20  # type: ignore[union-attr]
    finally:
        _cleanup([user_id], [inst_id])


def _free_port() -> int:
    import socket

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _start_redis(port: int, workdir: str) -> Any:
    import subprocess

    proc = subprocess.Popen(
        [
            "redis-server",
            "--port",
            str(port),
            "--bind",
            "127.0.0.1",
            "--save",
            "",
            "--appendonly",
            "no",
            "--dir",
            workdir,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    import redis as sync_redis

    for _ in range(100):
        try:
            if sync_redis.from_url(f"redis://127.0.0.1:{port}/0", socket_timeout=0.5).ping():
                return proc
        except Exception:
            time.sleep(0.05)
    proc.kill()
    raise RuntimeError("redis-server не запустился")


@pytest.mark.skipif(__import__("shutil").which("redis-server") is None, reason="нет redis-server")
def test_notifier_survives_redis_restart(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> None:
    """Настоящий redis-server перезапускается под работающим уведомителем: процесс не падает,
    доставка алертов (ей нужен только PostgreSQL) не прерывается, после возврата Redis heartbeat
    снова пишется."""
    import redis as sync_redis

    port = _free_port()
    url = f"redis://127.0.0.1:{port}/0"
    monkeypatch.setattr(settings, "redis_url", url)
    for name, value in (("ranks_once", "fresh"), ("billing_once", {}), ("monitor_once", "ok")):
        monkeypatch.setattr(notifier_mod, name, lambda v=value: v)
    monkeypatch.setattr(notifier_mod, "stats_once", lambda: 0)
    monkeypatch.setattr(notifier_mod, "process", lambda a, b: (max(a, 0), max(b, 0), 0, False))
    monkeypatch.setattr(notifier_mod, "digest_due", lambda now, done: False)
    monkeypatch.setattr(notifier_mod, "POLL", 0.1)
    monkeypatch.setattr(notifier_mod, "ALERTS_POLL", 0.1)
    monkeypatch.setattr(notifier_mod, "RESTART_AFTER", 0.1)
    passes: list[float] = []

    def once() -> alerts_mod.DeliveryPass:
        passes.append(time.monotonic())
        return alerts_mod.DeliveryPass(0, 0, False)

    monkeypatch.setattr(notifier_mod, "alerts_once", once)
    proc = _start_redis(port, str(tmp_path))
    client = sync_redis.from_url(url, socket_timeout=1)

    def heartbeat() -> bytes | None:
        try:
            v = client.get(notifier_mod.HEARTBEAT_KEY)
            return v if isinstance(v, bytes) else None
        except Exception:
            return None

    async def go() -> None:
        nonlocal proc
        n = notifier_mod.Notifier()
        task = asyncio.create_task(n.run())
        try:
            for _ in range(100):
                if heartbeat():
                    break
                await asyncio.sleep(0.05)
            assert heartbeat(), "heartbeat до перезапуска"
            proc.terminate()
            proc.wait(10)
            down_at = time.monotonic()
            await asyncio.sleep(1.0)  # Redis лежит: несколько итераций основного цикла
            assert not task.done(), task
            assert sum(t > down_at for t in passes) >= 3  # доставка алертов идёт
            proc = _start_redis(port, str(tmp_path))  # пустой: heartbeat старого нет
            for _ in range(100):
                if heartbeat():
                    break
                await asyncio.sleep(0.05)
            assert heartbeat(), "heartbeat после перезапуска Redis"
            assert not task.done()
        finally:
            n.stop.set()
            await asyncio.wait_for(task, 10)

    try:
        asyncio.run(go())
    finally:
        client.close()
        proc.terminate()
        proc.wait(10)


@pytest.mark.skipif(__import__("shutil").which("redis-server") is None, reason="нет redis-server")
def test_alerts_worker_resubscribes_after_redis_restart(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    """Настоящий redis-server перезапускается под воркером алертов. Раньше процесс оставался жив,
    но подписка на ``candles.closed`` и цикл с heartbeat молча завершались: алерты по ценам
    больше не срабатывали, а платформа процесс не перезапускала. Теперь воркер подписывается
    снова, событие после перезапуска обрабатывается, heartbeat пишется."""
    import redis as sync_redis

    import app.workers.alerts as worker_mod

    port = _free_port()
    url = f"redis://127.0.0.1:{port}/0"
    monkeypatch.setattr(settings, "redis_url", url)
    monkeypatch.setattr(worker_mod, "patterns_once", lambda cursor: (cursor, 0))
    monkeypatch.setattr(worker_mod, "figures_once", lambda cursor: (cursor, 0))
    monkeypatch.setattr(worker_mod, "expire_once", lambda: 0)
    monkeypatch.setattr(worker_mod, "process_bars", lambda *a: 0)
    monkeypatch.setattr(worker_mod, "LOOP_EVERY", 0.1)
    monkeypatch.setattr(worker_mod, "LISTEN_RETRY", 0.1)
    seen: list[tuple[str, datetime]] = []
    monkeypatch.setattr(
        worker_mod, "process_price", lambda symbol, at: seen.append((symbol, at)) or 0
    )
    proc = _start_redis(port, str(tmp_path))
    client = sync_redis.from_url(url, socket_timeout=1)

    def subscribed() -> bool:
        try:
            subs = dict(client.pubsub_numsub(worker_mod.CHANNEL_CLOSED))
            return int(subs.get(worker_mod.CHANNEL_CLOSED.encode(), 0)) >= 1
        except Exception:
            return False

    def heartbeat() -> bool:
        try:
            return client.get(worker_mod.HEARTBEAT_KEY) is not None
        except Exception:
            return False

    async def until(cond: Callable[[], bool]) -> bool:
        for _ in range(200):
            if cond():
                return True
            await asyncio.sleep(0.05)
        return False

    def close_event(minute: int) -> datetime:
        at = datetime(2031, 3, 7, 12, minute, tzinfo=UTC)
        client.publish(
            worker_mod.CHANNEL_CLOSED,
            json.dumps({"symbol": "OPSUSDT", "tf": "1m", "close_time": at.isoformat()}),
        )
        return at

    async def go() -> None:
        nonlocal proc
        w = worker_mod.AlertsWorker()
        task = asyncio.create_task(w.run())
        try:
            assert await until(subscribed) and await until(heartbeat), "до перезапуска"
            first = close_event(7)
            assert await until(lambda: len(seen) == 1) and seen[0] == ("OPSUSDT", first)
            proc.terminate()
            proc.wait(10)
            await asyncio.sleep(1.0)  # Redis лежит: несколько итераций цикла и переподключений
            assert not task.done(), task
            proc = _start_redis(port, str(tmp_path))  # пустой: ни подписки, ни heartbeat
            assert await until(subscribed), "подписка после перезапуска Redis"
            assert await until(heartbeat), "heartbeat после перезапуска Redis"
            second = close_event(8)
            assert await until(lambda: len(seen) == 2) and seen[1] == ("OPSUSDT", second)
            assert not task.done()
        finally:
            w.stop.set()
            await asyncio.wait_for(task, 10)

    try:
        asyncio.run(go())
    finally:
        client.close()
        proc.terminate()
        proc.wait(10)
