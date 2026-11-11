"""Уведомления владельцу и администраторам о сигналах форварда (письмо и push).

Новый форвард-сигнал и смена его статуса (вход, TP1–TP3, стоп, выход по времени) уходят только
пользователям с ролью owner или admin; обычные пользователи (и support) ничего не получают,
даже с включёнными письмами о сигналах. Повтор по тому же сигналу или событию невозможен.
Исправления исхода (пересчёт форварда, ``source = 'retrack'``) не рассылаются, live-сигналы идут
обычным путём. Тексты — без БД; рассылка — на реальной БД во внешней транзакции.
"""

from __future__ import annotations

import secrets
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import httpx
import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError, OperationalError
from sqlalchemy.orm import Session, sessionmaker

import app.mail as mail
import app.notify as notify
import app.workers.notifier as notifier
from app.config import settings
from app.db import engine
from app.models import (
    Instrument,
    NotificationLog,
    NotificationSettings,
    Signal,
    SignalEvent,
    SignalResult,
    Strategy,
    StrategyVersion,
    User,
)

D = Decimal
T = datetime(2026, 11, 10, 8, tzinfo=UTC)


def _sig(direction: str = "short", scope: str = "forward") -> Signal:
    return Signal(
        id=1,
        public_id="abc123",
        strategy_version_id=1,
        instrument_id=1,
        direction=direction,
        candle_close_time=T,
        entry_market=D("0.2510"),
        entry_limit=None,
        stop_loss=D("0.2600"),
        tp1=D("0.2420"),
        tp2=D("0.2330"),
        tp3=D("0.2150"),
        rr_tp2=D("2.000"),
        score=72,
        grade="B",
        status="pending",
        scope=scope,
    )


def test_staff_signal_text_has_levels_grade_and_link() -> None:
    text_ = notify.staff_signal_text(_sig(), "XLMUSDT", "1.2.0")
    assert text_.startswith("Новый сигнал форварда: XLMUSDT")
    for part in ("SHORT", "B (72)", "0.251", "0.26", "0.242 / 0.233 / 0.215", "1.2.0"):
        assert part in text_, part
    assert "10.11 08:00 UTC" in text_ and "/signals/abc123" in text_
    assert "только владелец и администраторы" in text_
    assert "тест" not in text_.lower()


def test_staff_event_text_with_and_without_result() -> None:
    sig = _sig()
    ev = SignalEvent(id=7, signal_id=1, type="tp1", price=D("0.2420"), occurred_at=T)
    msg = notify.staff_event_text(sig, ev, "XLMUSDT SHORT", None)
    assert msg.startswith("XLMUSDT SHORT · B: достигнут TP1")
    assert "по 0.242" in msg and "Результат" not in msg and "/signals/abc123" in msg
    stop = SignalEvent(id=8, signal_id=1, type="sl", price=D("0.26"), occurred_at=T)
    res = SignalResult(signal_id=1, realized_r=D("-1.043"))
    msg = notify.staff_event_text(sig, stop, "XLMUSDT SHORT", res)
    assert "сработал стоп по 0.26" in msg and "Результат: -1.04 R" in msg
    assert "тест" not in msg.lower()


# --- на БД -------------------------------------------------------------------------------------


def _db_available() -> bool:
    try:
        with engine.connect() as conn:
            conn.execute(text("select 1 from signal_corrections limit 0"))
        return True
    except (OperationalError, DBAPIError):
        return False


db_only = pytest.mark.skipif(not _db_available(), reason="БД с миграцией 0026 недоступна")


@pytest.fixture
def factory() -> Iterator[sessionmaker[Session]]:
    conn = engine.connect()
    outer = conn.begin()
    try:
        yield sessionmaker(
            bind=conn, expire_on_commit=False, join_transaction_mode="create_savepoint"
        )
    finally:
        outer.rollback()
        conn.close()


@pytest.fixture
def mails(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str, str]]:
    sent: list[tuple[str, str, str]] = []
    monkeypatch.setattr(notify, "send_mail", lambda to, subj, body: sent.append((to, subj, body)))
    return sent


class People:
    def __init__(self, db: Session) -> None:
        tag = secrets.token_hex(3)
        verified = datetime(2026, 10, 1, tzinfo=UTC)

        def user(name: str, role: str, **kw: object) -> User:
            u = User(email=f"{name}-{tag}@example.test", role=role, **kw)
            db.add(u)
            db.flush()
            return u

        self.owner = user("owner", "owner", email_verified_at=verified)
        self.admin = user("admin", "admin", email_verified_at=verified)
        self.admin_unverified = user("admin2", "admin")
        self.user = user("reader", "user", email_verified_at=verified)
        self.support = user("support", "support", email_verified_at=verified)
        self.blocked = user("blocked", "admin", email_verified_at=verified, blocked_at=verified)
        self.deleted = user("gone", "owner", email_verified_at=verified, deleted_at=verified)
        # обычный пользователь хочет все письма и push о сигналах — форвард ему всё равно не идёт
        db.add(
            NotificationSettings(
                user_id=self.user.id,
                email_signals=True,
                email_events=True,
                push_signals=True,
                push_events=True,
                unsubscribe_token=secrets.token_urlsafe(16),
            )
        )
        strat = Strategy(slug=f"staff-{tag}", name="staff test")
        db.add(strat)
        db.flush()
        self.ver = StrategyVersion(
            strategy_id=strat.id, version=f"9.{tag}.0", params={"t": tag}, status="forward"
        )
        db.add(self.ver)
        self.inst = Instrument(
            exchange="binance",
            symbol=f"ST{tag.upper()}USDT",
            base=f"ST{tag.upper()}",
            quote="USDT",
            market_type="futures",
            tick_size=D("0.0001"),
            lot_size=D("1"),
        )
        db.add(self.inst)
        db.flush()
        self.tag = tag

    def signal(self, db: Session, scope: str = "forward", hours: int = 0) -> Signal:
        sig = _sig(scope=scope)
        sig.id = None  # type: ignore[assignment]
        sig.public_id = f"{scope[:3]}{hours}{self.tag}"
        sig.strategy_version_id = self.ver.id
        sig.instrument_id = self.inst.id
        sig.candle_close_time = T + timedelta(hours=4 * hours)
        sig.input_hash = "h" * 64
        db.add(sig)
        db.flush()
        return sig

    def staff_ids(self) -> set[int]:
        return {self.owner.id, self.admin.id, self.admin_unverified.id}


def _log(db: Session, kind: str) -> set[tuple[int, str, str]]:
    return {
        (u, ch, ref)
        for u, ch, ref in db.execute(
            select(NotificationLog.user_id, NotificationLog.channel, NotificationLog.ref).where(
                NotificationLog.kind == kind
            )
        ).all()
    }


@db_only
def test_new_forward_signal_goes_to_owner_and_admins_only(
    factory: sessionmaker[Session], mails: list[tuple[str, str, str]]
) -> None:
    db = factory()
    p = People(db)
    sig = p.signal(db)
    db.commit()

    notify.notify_staff_signal(db, sig)
    assert {to for to, _, _ in mails} == {p.owner.email, p.admin.email}
    subject, body = mails[0][1], mails[0][2]
    assert subject == f"Новый сигнал: {p.inst.symbol} SHORT · B"
    assert p.inst.symbol in body and p.ver.version in body and f"/signals/{sig.public_id}" in body
    log = _log(db, notify.STAFF_SIGNAL)
    assert {u for u, ch, _ in log if ch == "email"} == {p.owner.id, p.admin.id}
    assert {u for u, ch, _ in log if ch == "push"} == p.staff_ids()  # push — без подтверждения
    assert not {p.user.id, p.support.id, p.blocked.id, p.deleted.id} & {u for u, _, _ in log}
    # обычный путь (live) форвард-сигнал не рассылает никому
    assert notify.notify_new_signal(db, sig) == 0

    mails.clear()
    assert notify.notify_staff_signal(db, sig) == 0  # повтор не отправляется
    assert mails == []


@db_only
def test_status_changes_of_forward_signal_with_result_and_no_corrections(
    factory: sessionmaker[Session], mails: list[tuple[str, str, str]]
) -> None:
    db = factory()
    p = People(db)
    sig = p.signal(db)
    entry = SignalEvent(signal_id=sig.id, type="activated", price=sig.entry_market, occurred_at=T)
    tp1 = SignalEvent(signal_id=sig.id, type="tp1", price=sig.tp1, occurred_at=T + timedelta(1))
    fix = SignalEvent(
        signal_id=sig.id, type="sl", price=sig.stop_loss, occurred_at=T, source="retrack"
    )
    note = SignalEvent(signal_id=sig.id, type="corrected", occurred_at=T, source="retrack")
    db.add_all([entry, tp1, fix, note])
    db.commit()

    for ev in (entry, tp1):
        notify.notify_staff_event(db, ev)
    subjects = sorted({s for _, s, _ in mails})
    head = f"{p.inst.symbol} SHORT"
    assert subjects == [f"{head}: вход исполнен", f"{head}: достигнут TP1"]
    assert {to for to, _, _ in mails} == {p.owner.email, p.admin.email}
    assert all(notify.notify_staff_event(db, ev) == 0 for ev in (fix, note))

    mails.clear()
    stop = SignalEvent(
        signal_id=sig.id, type="be", price=sig.entry_market, occurred_at=T + timedelta(2)
    )
    db.add(stop)
    db.add(
        SignalResult(
            signal_id=sig.id,
            realized_r=D("0.357"),
            closed_at=T + timedelta(2),
            cost_r=D("0.043"),
        )
    )
    sig.status = "closed_be"
    db.commit()
    notify.notify_staff_event(db, stop)
    assert len(mails) == 2 and "Результат: +0.36 R" in mails[0][2]
    assert mails[0][1] == f"{head}: закрыт в безубыток"

    # live-сигнал — не путём владельца
    live = p.signal(db, scope="live", hours=1)
    ev = SignalEvent(signal_id=live.id, type="activated", occurred_at=T + timedelta(hours=4))
    db.add(ev)
    db.commit()
    mails.clear()
    assert notify.notify_staff_signal(db, live) == 0 and notify.notify_staff_event(db, ev) == 0
    assert mails == []


@db_only
def test_notifier_sends_forward_to_staff_and_skips_corrections(
    factory: sessionmaker[Session],
    mails: list[tuple[str, str, str]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = factory()
    last_signal = db.scalar(text("select coalesce(max(id), 0) from signals"))
    last_event = db.scalar(text("select coalesce(max(id), 0) from signal_events"))
    p = People(db)
    sig = p.signal(db)
    db.add_all(
        [
            SignalEvent(signal_id=sig.id, type="created", occurred_at=T, source="engine"),
            SignalEvent(signal_id=sig.id, type="activated", price=sig.entry_market, occurred_at=T),
            SignalEvent(signal_id=sig.id, type="time_stop", occurred_at=T, source="retrack"),
        ]
    )
    db.commit()
    monkeypatch.setattr(notifier, "SessionLocal", factory)
    new_signal, new_event, sent, closed = notifier.process(last_signal, last_event)
    assert new_signal == sig.id and new_event > last_event and closed
    subjects = [s for to, s, _ in mails if to == p.owner.email]
    assert subjects == [
        f"Новый сигнал: {p.inst.symbol} SHORT · B",
        f"{p.inst.symbol} SHORT: вход исполнен",
    ]
    assert not [m for m in mails if m[0] in (p.user.email, p.support.email)]
    assert sent == 4  # письма владельцу и админу о сигнале и о входе; push без ключей не уходит


def test_staff_retry_backs_off_and_gives_up(caplog: pytest.LogCaptureFixture) -> None:
    """Повтор неушедшего: через ``STAFF_RETRY_FIRST``, интервал удваивается до
    ``STAFF_RETRY_MAX``; через ``STAFF_RETRY_FOR`` после первой неудачи — ошибка в лог, без
    повтора; ушедшее — из очереди."""
    clock = [0.0]
    retry = notifier.StaffRetry(clock=lambda: clock[0])
    key = ("event", 7)
    retry.failed(key)
    assert retry.due() == []
    attempts = []
    while key in retry.items:
        clock[0] = retry.items[key].due
        assert retry.due() == [key]
        attempts.append(clock[0])
        retry.failed(key)
    gaps = [b - a for a, b in zip([0.0, *attempts], attempts, strict=False)]
    assert gaps[:6] == [60, 120, 240, 480, 960, 1800] and set(gaps[6:]) == {1800}
    assert attempts[-1] >= notifier.STAFF_RETRY_FOR > attempts[-2]
    assert "без повтора" in caplog.records[-1].getMessage()
    retry.failed(("signal", 1))
    retry.done(("signal", 1))
    assert retry.items == {}


@db_only
def test_one_failed_mail_does_not_stop_other_staff_and_is_retried(
    factory: sessionmaker[Session], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Сетевая ошибка письма владельцу (таймаут Resend) не мешает остальным: админ получает
    письмо, все — push, ушедшее отмечено. Письмо владельцу не отмечено и повторяется уведомителем
    с растущим интервалом, пока не уйдёт; ушедшее другим не повторяется."""
    db = factory()
    last_signal = db.scalar(text("select coalesce(max(id), 0) from signals"))
    last_event = db.scalar(text("select coalesce(max(id), 0) from signal_events"))
    p = People(db)
    sig = p.signal(db)
    ev = SignalEvent(signal_id=sig.id, type="tp1", price=sig.tp1, occurred_at=T)
    db.add(ev)
    db.commit()

    down = [True]
    delivered: list[tuple[str, str]] = []
    attempts: list[str] = []

    def post(_url: str, **kw: object) -> httpx.Response:
        body = kw["json"]
        assert isinstance(body, dict)
        to = body["to"][0]
        attempts.append(to)
        if to == p.owner.email and down[0]:
            raise httpx.ConnectTimeout("timed out")
        delivered.append((to, body["subject"]))
        return httpx.Response(200, json={"id": "x"})

    pushes: list[int] = []

    def push(_db: Session, user_id: int, _payload: dict[str, str]) -> int:
        pushes.append(user_id)
        return 1

    monkeypatch.setattr(settings, "resend_api_key", "dummy")
    monkeypatch.setattr(mail.httpx, "post", post)
    monkeypatch.setattr(notify, "send_to_user", push)
    monkeypatch.setattr(notifier, "SessionLocal", factory)
    clock = [1000.0]
    retry = notifier.StaffRetry(clock=lambda: clock[0])

    def emails(kind: str) -> set[int]:
        return {u for u, ch, _ in _log(db, kind) if ch == "email"}

    new_signal, new_event, sent, _ = notifier.process(last_signal, last_event, retry)
    assert (new_signal, new_event) == (sig.id, ev.id)
    head = f"{p.inst.symbol} SHORT"
    assert sorted(delivered) == sorted(
        [(p.admin.email, f"Новый сигнал: {head} · B"), (p.admin.email, f"{head}: достигнут TP1")]
    )
    assert sorted(pushes) == sorted([*p.staff_ids(), *p.staff_ids()])
    assert sent == 2 + 6
    assert emails(notify.STAFF_SIGNAL) == emails(notify.STAFF_EVENT) == {p.admin.id}
    assert {u for u, ch, _ in _log(db, notify.STAFF_EVENT) if ch == "push"} == p.staff_ids()
    assert set(retry.items) == {("signal", sig.id), ("event", ev.id)}

    # срок повтора не подошёл — ничего; подошёл, а почта ещё лежит — повтор позже
    attempts.clear()
    assert notifier.process(sig.id, ev.id, retry)[2] == 0 and attempts == []
    clock[0] += notifier.STAFF_RETRY_FIRST
    assert notifier.process(sig.id, ev.id, retry)[2] == 0
    assert attempts == [p.owner.email, p.owner.email]  # только неушедшее, админу не повторно
    assert set(retry.items) == {("signal", sig.id), ("event", ev.id)}

    # почта поднялась: на следующем сроке письма владельцу уходят, очередь пуста
    down[0] = False
    clock[0] += 2 * notifier.STAFF_RETRY_FIRST
    pushes.clear()
    delivered.clear()
    assert notifier.process(sig.id, ev.id, retry)[2] == 2
    assert sorted(delivered) == sorted(
        [(p.owner.email, f"Новый сигнал: {head} · B"), (p.owner.email, f"{head}: достигнут TP1")]
    )
    assert pushes == [] and retry.items == {}
    assert emails(notify.STAFF_SIGNAL) == emails(notify.STAFF_EVENT) == {p.owner.id, p.admin.id}


@db_only
def test_staff_delivery_error_reports_what_was_sent(
    factory: sessionmaker[Session], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Прямой вызов: сбой одной отправки — ``StaffDeliveryError`` после попытки всем, с числом
    ушедших и списком неушедших; повтор того же вызова отправляет только неушедшее."""
    db = factory()
    p = People(db)
    sig = p.signal(db)
    db.commit()
    sent_to: list[str] = []

    def flaky(to: str, _subject: str, _body: str) -> None:
        if to == p.owner.email and not sent_to:
            raise httpx.ReadTimeout("timed out")
        sent_to.append(to)

    def broken_push(_db: Session, user_id: int, _payload: dict[str, str]) -> int:
        if user_id == p.admin_unverified.id:
            raise RuntimeError("push-сервис недоступен")
        return 1

    monkeypatch.setattr(notify, "send_mail", flaky)
    monkeypatch.setattr(notify, "send_to_user", broken_push)
    with pytest.raises(notify.StaffDeliveryError) as err:
        notify.notify_staff_signal(db, sig)
    assert err.value.sent == 1 + 2  # письмо админу, push владельцу и админу
    assert err.value.failed == [
        f"email пользователю {p.owner.id}",
        f"push пользователю {p.admin_unverified.id}",
    ]
    assert sent_to == [p.admin.email]
    monkeypatch.setattr(notify, "send_to_user", lambda *_a: 1)
    assert notify.notify_staff_signal(db, sig) == 2  # письмо владельцу и push третьему
    assert sent_to == [p.admin.email, p.owner.email]
    assert notify.notify_staff_signal(db, sig) == 0
