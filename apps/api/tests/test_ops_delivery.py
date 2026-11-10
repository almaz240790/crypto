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
    deliver_pending,
    delivery_ready,
    delivery_state,
    trigger,
    trigger_dict,
)
from app.config import PRODUCTION_FRONTEND_URL, Settings, is_local_url, settings
from app.db import SessionLocal, engine
from app.mail import MailError, send_mail
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
from app.notify import mail_key, mail_ready, run_digest

ENV_NAMES = ("APP_ENV", "FRONTEND_URL", "API_PUBLIC_URL", "RAILWAY_ENVIRONMENT_NAME")
VERIFIED = datetime(2026, 1, 1, tzinfo=UTC)
REAL_ALERT_MAIL = alerts_mod._alert_mail
"""Настоящее письмо алерта (через ``send_mail``); фикстура ``outbox`` его подменяет."""


class Outbox:
    """Подмена отправителей: что ушло бы в Resend и Web Push."""

    def __init__(self, *, fail_mail: int | None = None, delay: float = 0.0) -> None:
        self.mails: list[tuple[str, str, str, str | None]] = []
        self.pushes: list[tuple[int, dict[str, Any]]] = []
        self.fail_mail = fail_mail
        """Код ответа Resend, которым «отказывает» почта (None — письма уходят)."""
        self.delay = delay
        self._lock = threading.Lock()

    def mail(self, to: str, subject: str, text: str, idempotency_key: str | None = None) -> None:
        if self.delay:
            time.sleep(self.delay)
        if self.fail_mail is not None:
            raise MailError(self.fail_mail)
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


class _Resp:
    def __init__(self, code: int) -> None:
        self.status_code = code
        self.text = "{}"


def _fake_post(calls: list[dict[str, Any]], code: int) -> Callable[..., _Resp]:
    def post(url: str, **kw: Any) -> _Resp:
        calls.append({"url": url, **kw})
        return _Resp(code)

    return post


def test_send_mail_idempotency_header_and_strict(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, Any]] = []
    monkeypatch.setattr(settings, "resend_api_key", "re_test")
    monkeypatch.setattr(mail_mod.httpx, "post", _fake_post(calls, 200))
    send_mail("a@example.com", "s", "t", idempotency_key="alert-trigger-1")
    assert calls[-1]["headers"]["Idempotency-Key"] == "alert-trigger-1"
    send_mail("a@example.com", "s", "t")
    assert "Idempotency-Key" not in calls[-1]["headers"]
    # отказ провайдера: в строгом режиме — исключение, без него — только лог (как раньше)
    for code, permanent in (
        (401, False),
        (403, False),
        (429, False),
        (500, False),
        (503, False),
        (400, True),
        (422, True),
    ):
        monkeypatch.setattr(mail_mod.httpx, "post", _fake_post(calls, code))
        send_mail("a@example.com", "s", "t")
        with pytest.raises(MailError) as err:
            send_mail("a@example.com", "s", "t", strict=True)
        assert err.value.status_code == code and err.value.permanent is permanent
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
    with pytest.raises(httpx.ConnectError):
        send_mail("a@example.com", "s", "t")


# --- кто может рассылать -------------------------------------------------------------------------


def test_mail_ready_and_delivery_ready(monkeypatch: pytest.MonkeyPatch) -> None:
    for prod in (False, True):
        _production(monkeypatch, prod)
        for mail in (False, True):
            for push in (False, True):
                _keys(monkeypatch, mail=mail, push=push)
                assert mail_ready() is (mail or not prod)
                assert can_deliver_inline() is (mail and push)
                assert delivery_ready() is ((mail and push) or not prod)


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
    out = Outbox()
    assert deliver_pending(db, mail=out.mail, push=out.push) == 1
    db.refresh(trig)
    assert trig.notified and len(out.mails) == 1


@db_only
def test_retries_are_bounded_then_failed(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    _as_alerts_service(monkeypatch)
    _, alert, _ = _alert_setup(db)
    _only(monkeypatch, {alert.id})
    now = datetime.now(tz=UTC)
    trig = _fire_one(db, alert, now.replace(second=0, microsecond=0))
    db.commit()
    _as_notifier(monkeypatch)
    out = Outbox(fail_mail=503)
    t = now
    for attempt in range(1, DELIVERY_MAX_ATTEMPTS + 1):
        assert deliver_pending(db, t, mail=out.mail, push=out.push) == 0
        db.refresh(trig)
        state = delivery_state(trig)
        assert state["attempts"] == attempt and "503" in state["error"]
        if attempt < DELIVERY_MAX_ATTEMPTS:
            assert state["status"] == QUEUED
            retry_at = datetime.fromisoformat(state["retry_at"])
            assert retry_at > t
            # до паузы строка не берётся
            assert deliver_pending(db, t, mail=out.mail, push=out.push) == 0
            assert delivery_state(trig)["attempts"] == attempt
            t = retry_at + timedelta(seconds=1)
    assert delivery_state(trig)["status"] == FAILED and not trig.notified
    # push ушёл с первой попытки и больше не повторялся: каналы независимы
    assert len(out.pushes) == 1 and out.pushes[0][1]["tag"] == f"alert-{trig.id}"
    assert delivery_state(trig)["push_done"] is True and "mail_done" not in delivery_state(trig)
    assert deliver_pending(db, t + timedelta(hours=1), mail=out.mail, push=out.push) == 0


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
    _production(monkeypatch)
    monkeypatch.setattr(alerts_mod, "_not_ready_warned", False)
    _keys(monkeypatch, mail=True, push=False)
    _, alert, _ = _alert_setup(db)
    _only(monkeypatch, {alert.id})
    trig = _fire_one(db, alert, datetime.now(tz=UTC).replace(second=0, microsecond=0))
    db.commit()
    out = Outbox()
    assert deliver_pending(db, mail=out.mail, push=out.push) == 0
    db.refresh(trig)
    assert delivery_state(trig)["status"] == QUEUED and out.mails == []
    _keys(monkeypatch, mail=True, push=True)
    assert deliver_pending(db, mail=out.mail, push=out.push) == 1


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
def test_rejected_address_fails_without_retries(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Постоянный отказ (422 — неверный адрес): повтор не поможет, сразу ``failed``."""
    _as_alerts_service(monkeypatch)
    _, alert, _ = _alert_setup(db)
    _only(monkeypatch, {alert.id})
    now = datetime.now(tz=UTC)
    trig = _fire_one(db, alert, now.replace(second=0, microsecond=0))
    db.commit()
    _as_notifier(monkeypatch)
    out = Outbox(fail_mail=422)
    assert deliver_pending(db, now, mail=out.mail, push=out.push) == 0
    db.refresh(trig)
    state = delivery_state(trig)
    assert state["status"] == FAILED and state["attempts"] == 1 and "422" in state["error"]
    assert not trig.notified
    assert deliver_pending(db, now + timedelta(hours=1), mail=out.mail, push=out.push) == 0


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
            raise MailError(codes[to])
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
    monkeypatch.setattr(monitor_mod, "send_mail", lambda to, s, b: sent.append((to, s, b)))
    comps = [Component("ops_test", "Тестовый компонент", "down", "нет свечей")]
    assert send_alerts(db, comps, now) >= 1
    mine = [m for m in sent if m[0] == owner.email and "Тестовый компонент" in m[1]]
    assert len(mine) == 1 and f"{PRODUCTION_FRONTEND_URL}/status" in mine[0][2]
    assert inc.alerted_at == now
    sent.clear()
    send_alerts(db, comps, now + timedelta(minutes=5))  # раньше 6 часов — не повторяется
    assert not [m for m in sent if "Тестовый компонент" in m[1]]


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

    def once() -> int:
        _as_notifier(monkeypatch)
        with SessionLocal() as s:
            n = deliver_pending(s, mail=out.mail, push=out.push)
        passes.append(n)
        return n

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
