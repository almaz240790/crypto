"""Тестовые сигналы видны зарегистрированным (ADR-0013).

Форвард-сигналы — «тестовые»: гость их не видит нигде, вошедший пользователь видит в ленте,
карточке, анализе, свечах, сводке и слое графика; построчная история форварда в статистике
остаётся только админам. Доступ решает один флаг тарифа ``Entitlements.test_signals``.
Уведомления о тестовых сигналах — только по подписке (по умолчанию выключена) и с пометкой.

Без БД — флаг и тексты. На БД (нужен DATABASE_URL с миграциями до head; без БД тесты
пропускаются) — доступ по каждому адресу и уведомления; каждый тест работает во внешней
транзакции и откатывается в конце.
"""

from __future__ import annotations

import secrets
from collections.abc import Iterator
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError, OperationalError
from sqlalchemy.orm import Session

from app import auth, notify
from app.db import engine
from app.entitlements import (
    ENTITLEMENTS,
    all_plans_have_test_signals,
    forward_visible,
    restrictions_dict,
)
from app.forward import write_candidate
from app.models import (
    Instrument,
    NotificationLog,
    NotificationSettings,
    Signal,
    SignalEvent,
    Strategy,
    StrategyVersion,
    User,
)
from app.notify import (
    TEST_LABEL,
    TEST_NOTE,
    notify_event,
    notify_new_signal,
    settings_dict,
    settings_for,
    signal_text,
    unsubscribe,
)
from app.routers import chart, public
from app.routers import user as user_router
from engine.structure import Direction

T0 = datetime(2026, 10, 26, 8, tzinfo=UTC)
H4 = timedelta(hours=4)
PLANS = ("free", "pro", "premium")


# --- без БД: флаг тарифа ---------------------------------------------------------------------


def test_flag_is_on_for_every_plan_and_exposed_in_restrictions() -> None:
    assert all(ENTITLEMENTS[p].test_signals for p in PLANS)
    assert all_plans_have_test_signals()
    assert all(restrictions_dict(ENTITLEMENTS[p])["test_signals"] is True for p in PLANS)


def test_guest_never_sees_forward_whatever_the_flag() -> None:
    assert not any(forward_visible(None, ENTITLEMENTS[p]) for p in PLANS)


def test_logged_in_user_sees_forward_on_any_plan() -> None:
    u = User(id=1, email="u@example.test", role="user")
    assert all(forward_visible(u, ENTITLEMENTS[p]) for p in PLANS)


def test_flag_off_closes_forward_for_users_but_not_for_admins_or_premium() -> None:
    """Ужесточение одним флагом: без него форвард видят только admin/owner и тариф с
    ``forward_scope`` (Premium) — как было до ADR-0013."""
    u = User(id=1, email="u@example.test", role="user")
    off = {p: replace(ENTITLEMENTS[p], test_signals=False) for p in PLANS}
    assert not forward_visible(u, off["free"])
    assert not forward_visible(u, off["pro"])
    assert forward_visible(u, off["premium"])
    for role in ("admin", "owner"):
        assert forward_visible(User(id=2, email="a@example.test", role=role), off["free"])
    assert restrictions_dict(off["pro"])["test_signals"] is False


def test_all_plans_flag_helper_follows_the_table(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(ENTITLEMENTS, "free", replace(ENTITLEMENTS["free"], test_signals=False))
    assert not all_plans_have_test_signals()


# --- без БД: тексты уведомлений ---------------------------------------------------------------


def _sig(scope: str) -> Signal:
    return Signal(
        public_id="sig_test",
        instrument_id=1,
        direction="short",
        candle_close_time=T0,
        entry_market=Decimal(100),
        entry_limit=None,
        stop_loss=Decimal(105),
        tp1=Decimal(95),
        tp2=Decimal(90),
        tp3=Decimal(80),
        rr_tp2=Decimal(2),
        score=70,
        grade="B",
        scope=scope,
    )


def test_test_signal_text_is_labelled_and_has_no_promises() -> None:
    body = signal_text(_sig("forward"), "BTCUSDT", None)
    assert body.startswith("Новый тестовый сигнал")
    assert TEST_NOTE in body
    assert "проходит проверку на живых данных" in TEST_NOTE
    assert "Результаты не подтверждены" in TEST_NOTE
    assert "Не является инвестиционной рекомендацией" in TEST_NOTE
    assert TEST_LABEL == "Тестовый режим"
    low = (body + TEST_NOTE).lower()
    for banned in ("сигнал на покупку", "сигнал на продажу", "гарантир", "доходност", "прибыл"):
        # «не гарантируют» есть только в общей оговорке о прошлых результатах
        assert banned not in low.replace("прошлые результаты не гарантируют будущих", "")


def test_live_signal_text_is_unchanged() -> None:
    body = signal_text(_sig("live"), "BTCUSDT", None)
    assert body.startswith("Новый сигнал\n")
    assert "естов" not in body


def test_notification_flag_by_scope() -> None:
    assert notify._flag(_sig("live"), "email", "email_signals") == "email_signals"
    assert notify._flag(_sig("live"), "push", "push_events") == "push_events"
    assert notify._flag(_sig("forward"), "email", "email_signals") == "email_test_signals"
    assert notify._flag(_sig("forward"), "push", "push_events") == "push_test_signals"
    assert notify._flag(_sig("backtest"), "email", "email_signals") is None


# --- на БД -----------------------------------------------------------------------------------


def _db_available() -> bool:
    try:
        with engine.connect() as conn:
            conn.execute(text("select email_test_signals from notification_settings limit 0"))
        return True
    except (OperationalError, DBAPIError):
        return False


db_only = pytest.mark.skipif(
    not _db_available(), reason="БД с применёнными миграциями (до 0026) недоступна"
)


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


def _tag() -> str:
    return secrets.token_hex(3)


def _user(db: Session, role: str = "user") -> User:
    u = User(
        email=f"tsig-{_tag()}@example.test",
        role=role,
        email_verified_at=datetime(2026, 10, 1, tzinfo=UTC),
    )
    db.add(u)
    db.flush()
    return u


def _setup(db: Session, status: str = "forward") -> tuple[StrategyVersion, Instrument]:
    tag = _tag()
    inst = Instrument(
        exchange="binance",
        symbol=f"TS{tag.upper()}USDT",
        base=f"TS{tag.upper()}",
        quote="USDT",
        market_type="futures",
        tick_size=Decimal("0.01"),
        lot_size=Decimal("0.001"),
    )
    strat = Strategy(slug=f"tsig-{tag}", name="test signals")
    db.add_all([inst, strat])
    db.flush()
    ver = StrategyVersion(
        strategy_id=strat.id, version=f"0.{tag}.0", params={"t": tag}, status=status
    )
    db.add(ver)
    db.flush()
    return ver, inst


def _candidate(at: datetime) -> Any:
    """Кандидат движка с полями, которые читает ``write_candidate``."""
    return SimpleNamespace(
        candle_close_time=at,
        direction=Direction.UP,
        trade=SimpleNamespace(
            entry_market=Decimal(100),
            entry_limit=None,
            stop_loss=Decimal(95),
            tp1=Decimal(105),
            tp2=Decimal(110),
            tp3=Decimal(120),
            rr_tp2=Decimal(2),
        ),
        score=SimpleNamespace(
            total=80,
            grade=SimpleNamespace(value="A"),
            publishable=True,
            components={"trend": 30},
        ),
        facts=("тест",),
        deferred=False,
        zone=SimpleNamespace(kind="ob", top=Decimal(101), bottom=Decimal(99)),
        filters=SimpleNamespace(flags=[]),
        input_hash="h" * 64,
    )


def _publish(db: Session, ver: StrategyVersion, inst: Instrument, at: datetime = T0) -> Signal:
    assert write_candidate(db, ver, inst, _candidate(at))
    db.commit()
    sig = db.scalar(
        select(Signal).where(
            Signal.strategy_version_id == ver.id,
            Signal.instrument_id == inst.id,
            Signal.candle_close_time == at,
        )
    )
    assert sig is not None
    return sig


def _client(db: Session, holder: dict[str, User | None]) -> TestClient:
    app = FastAPI()
    app.include_router(public.router)
    app.include_router(chart.router)
    app.dependency_overrides[auth.get_db] = lambda: db
    app.dependency_overrides[public.optional_user] = lambda: holder["user"]
    return TestClient(app)


@pytest.fixture
def no_analysis(monkeypatch: pytest.MonkeyPatch) -> None:
    """Анализ карточки требует истории свечей; здесь проверяется только доступ."""
    monkeypatch.setattr(public, "analyze_signal", lambda db, s, inst: {"ok": s.public_id})


def _ids(resp: Any) -> set[str]:
    return {i["id"] for i in resp.json()["items"]}


@db_only
def test_guest_gets_no_forward_data_anywhere(db: Session, no_analysis: None) -> None:
    ver, inst = _setup(db, "forward")
    sig = _publish(db, ver, inst)
    assert sig.scope == "forward"
    client = _client(db, {"user": None})

    assert client.get("/v1/signals?scope=forward").status_code == 403
    assert client.get("/v1/signals?scope=forward&status=all").status_code == 403
    assert client.get("/v1/signals/summary?scope=forward").status_code == 403
    assert client.get(f"/v1/signals/{sig.public_id}").status_code == 404
    assert client.get(f"/v1/signals/{sig.public_id}/analysis").status_code == 404
    assert client.get(f"/v1/signals/{sig.public_id}/candles").status_code == 404
    assert client.get(f"/v1/chart/layers?symbol={inst.symbol}&tf=1m").json()["signals"] == []
    assert client.get("/v1/stats/trades?scope=forward").status_code == 403
    # live-лента гостя форвард не содержит, сводка не обещает тестовых сигналов
    assert sig.public_id not in _ids(client.get("/v1/signals?scope=live&status=all"))
    summary = client.get("/v1/signals/summary").json()
    assert summary["scope"] == "live"
    assert summary["test_available"] is False
    assert summary["default_scope"] == "live"


@db_only
def test_registered_user_sees_test_signals_everywhere_but_row_history(
    db: Session, no_analysis: None
) -> None:
    ver, inst = _setup(db, "forward")
    sig = _publish(db, ver, inst)
    holder: dict[str, User | None] = {"user": _user(db, "user")}
    client = _client(db, holder)

    feed = client.get(f"/v1/signals?scope=forward&status=all&symbol={inst.symbol}")
    assert feed.status_code == 200
    assert feed.json()["scope"] == "forward"
    assert _ids(feed) == {sig.public_id}
    row = feed.json()["items"][0]
    assert row["scope"] == "forward" and row["status"] == "pending"
    assert (row["entry_market"], row["stop_loss"]) == ("100", "95")
    assert (row["tp1"], row["tp2"], row["tp3"], row["grade"]) == ("105", "110", "120", "A")
    assert feed.json()["restrictions"]["test_signals"] is True
    # открытые сигналы — тоже: вкладка «Активные»
    assert sig.public_id in _ids(client.get(f"/v1/signals?scope=forward&symbol={inst.symbol}"))

    summary = client.get("/v1/signals/summary?scope=forward")
    assert summary.status_code == 200
    assert summary.json()["scope"] == "forward"
    assert summary.json()["active"] >= 1
    assert summary.json()["test_available"] is True

    card = client.get(f"/v1/signals/{sig.public_id}")
    assert card.status_code == 200
    assert card.json()["scope"] == "forward"
    assert card.json()["facts"] == ["тест"]
    assert client.get(f"/v1/signals/{sig.public_id}/analysis").json() == {"ok": sig.public_id}
    assert client.get(f"/v1/signals/{sig.public_id}/candles").status_code == 200

    layer = client.get(f"/v1/chart/layers?symbol={inst.symbol}&tf=1m").json()["signals"]
    assert [(s["id"], s["scope"]) for s in layer] == [(sig.public_id, "forward")]

    # построчная история форварда в статистике — только админам
    assert client.get("/v1/stats/trades?scope=forward").status_code == 403
    # форвард не подмешивается в live-ленту
    assert sig.public_id not in _ids(client.get("/v1/signals?scope=live&status=all"))


@db_only
def test_admin_keeps_full_access_including_row_history(db: Session, no_analysis: None) -> None:
    ver, inst = _setup(db, "forward")
    sig = _publish(db, ver, inst)
    client = _client(db, {"user": _user(db, "admin")})

    assert sig.public_id in _ids(
        client.get(f"/v1/signals?scope=forward&status=all&symbol={inst.symbol}")
    )
    assert client.get("/v1/signals/summary?scope=forward").status_code == 200
    assert client.get(f"/v1/signals/{sig.public_id}").json()["scope"] == "forward"
    assert client.get(f"/v1/signals/{sig.public_id}/analysis").status_code == 200
    assert client.get(f"/v1/signals/{sig.public_id}/candles").status_code == 200
    layer = client.get(f"/v1/chart/layers?symbol={inst.symbol}&tf=1m").json()["signals"]
    assert [s["scope"] for s in layer] == ["forward"]
    assert client.get(f"/v1/stats/trades?scope=forward&version={ver.version}").status_code == 200


@db_only
def test_flag_off_hides_forward_from_users_again(
    db: Session, no_analysis: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Ужесточение (ADR-0013): флаг снят с тарифа — пользователь снова не видит форвард ни в одном
    адресе; админ видит."""
    for p in PLANS:
        monkeypatch.setitem(ENTITLEMENTS, p, replace(ENTITLEMENTS[p], test_signals=False))
    ver, inst = _setup(db, "forward")
    sig = _publish(db, ver, inst)
    holder: dict[str, User | None] = {"user": _user(db, "user")}
    client = _client(db, holder)

    assert client.get("/v1/signals?scope=forward").status_code == 403
    assert client.get("/v1/signals/summary?scope=forward").status_code == 403
    assert client.get(f"/v1/signals/{sig.public_id}").status_code == 404
    assert client.get(f"/v1/signals/{sig.public_id}/analysis").status_code == 404
    assert client.get(f"/v1/signals/{sig.public_id}/candles").status_code == 404
    assert client.get(f"/v1/chart/layers?symbol={inst.symbol}&tf=1m").json()["signals"] == []
    summary = client.get("/v1/signals/summary").json()
    assert summary["test_available"] is False and summary["default_scope"] == "live"

    holder["user"] = _user(db, "admin")
    assert client.get(f"/v1/signals/{sig.public_id}").status_code == 200


@db_only
def test_feed_default_scope_is_test_until_something_is_live(db: Session) -> None:
    """Лента без явного выбора открывает тестовые сигналы, пока нет ни live-версии, ни
    live-сигналов; с появлением live — live (тестовые остаются второй вкладкой)."""
    db.execute(text("update strategy_versions set status = 'archived' where status = 'live'"))
    live_before = bool(db.scalar(select(Signal.id).where(Signal.scope == "live").limit(1)))
    ver, inst = _setup(db, "forward")
    _publish(db, ver, inst)
    holder: dict[str, User | None] = {"user": _user(db, "user")}
    client = _client(db, holder)

    s = client.get("/v1/signals/summary").json()
    assert s["scope"] == "live"  # сам запрос — по live, как и раньше
    assert s["test_available"] is True
    assert s["live_available"] is live_before
    assert s["default_scope"] == ("live" if live_before else "forward")

    live_ver, live_inst = _setup(db, "live")
    s = client.get("/v1/signals/summary").json()
    assert s["live_available"] is True and s["test_available"] is True
    assert s["default_scope"] == "live"
    live_sig = _publish(db, live_ver, live_inst, T0 + H4)
    assert live_sig.scope == "live"
    assert live_sig.public_id in _ids(client.get("/v1/signals?scope=live&status=all"))
    assert live_sig.public_id not in _ids(client.get("/v1/signals?scope=forward&status=all"))


# --- уведомления -----------------------------------------------------------------------------


class Outbox:
    def __init__(self) -> None:
        self.mails: list[tuple[str, str, str]] = []
        self.pushes: list[tuple[int, dict[str, Any]]] = []


@pytest.fixture
def outbox(monkeypatch: pytest.MonkeyPatch) -> Outbox:
    box = Outbox()

    def mail(to: str, subject: str, body: str) -> None:
        box.mails.append((to, subject, body))

    def push(db: Session, user_id: int, payload: dict[str, Any]) -> int:
        box.pushes.append((user_id, payload))
        return 1

    monkeypatch.setattr(notify, "send_mail", mail)
    monkeypatch.setattr(notify, "send_to_user", push)
    return box


def _settings(db: Session, user: User, **kw: Any) -> NotificationSettings:
    """Как у нового пользователя (``settings_for``), с явными отличиями в ``kw``."""
    ns = settings_for(db, user)
    for k, v in kw.items():
        setattr(ns, k, v)
    db.flush()
    return ns


def _mails_to(box: Outbox, user: User) -> list[tuple[str, str]]:
    return [(subj, body) for to, subj, body in box.mails if to == user.email]


def _pushes_to(box: Outbox, user: User) -> list[dict[str, Any]]:
    return [p for uid, p in box.pushes if uid == user.id]


@db_only
def test_test_signal_notifications_are_off_by_default(db: Session, outbox: Outbox) -> None:
    """Новый пользователь ничего не включал: о тестовых сигналах ему не приходит ни письмо, ни
    push — хотя push о live-сигналах у него по умолчанию включён."""
    u = _user(db)
    ns = _settings(db, u)
    d = settings_dict(ns)
    assert d["email_test_signals"] is False and d["push_test_signals"] is False
    assert d["push_signals"] is True

    ver, inst = _setup(db, "forward")
    sig = _publish(db, ver, inst)
    ev = SignalEvent(signal_id=sig.id, type="activated", occurred_at=T0 + H4)
    db.add(ev)
    db.flush()
    notify_new_signal(db, sig, now=T0 + timedelta(minutes=1))
    notify_event(db, ev, now=T0 + H4)
    assert _mails_to(outbox, u) == [] and _pushes_to(outbox, u) == []
    assert db.scalars(select(NotificationLog).where(NotificationLog.user_id == u.id)).all() == []


@db_only
def test_live_only_subscriber_gets_nothing_about_test_signals(db: Session, outbox: Outbox) -> None:
    u = _user(db)
    _settings(db, u, email_signals=True, email_events=True, push_signals=True, push_events=True)
    ver, inst = _setup(db, "forward")
    sig = _publish(db, ver, inst)
    ev = SignalEvent(signal_id=sig.id, type="tp1", occurred_at=T0 + H4, price=Decimal(105))
    db.add(ev)
    db.flush()
    notify_new_signal(db, sig, now=T0 + timedelta(minutes=1))
    notify_event(db, ev, now=T0 + H4)
    assert _mails_to(outbox, u) == [] and _pushes_to(outbox, u) == []


@db_only
def test_opt_in_brings_labelled_mail_and_push_for_new_test_signal_and_its_events(
    db: Session, outbox: Outbox
) -> None:
    u = _user(db)
    ns = _settings(db, u, email_test_signals=True, push_test_signals=True)
    ver, inst = _setup(db, "forward")
    sig = _publish(db, ver, inst)

    assert notify_new_signal(db, sig, now=T0 + timedelta(minutes=1)) >= 2
    [(subject, body)] = _mails_to(outbox, u)
    assert subject == f"[Тестовый режим] Сигнал {inst.symbol} LONG A"
    assert body.startswith("Новый тестовый сигнал")
    assert TEST_NOTE in body
    assert f"/signals/{sig.public_id}" in body
    assert f"/unsubscribe?token={ns.unsubscribe_token}" in body  # ссылка отписки на месте
    [push] = _pushes_to(outbox, u)
    assert push["title"].startswith("[Тестовый режим] ")
    assert push["url"] == f"/signals/{sig.public_id}"

    # повтор по тому же сигналу невозможен
    notify_new_signal(db, sig, now=T0 + timedelta(minutes=2))
    assert len(_mails_to(outbox, u)) == 1 and len(_pushes_to(outbox, u)) == 1

    ev = SignalEvent(signal_id=sig.id, type="tp1", occurred_at=T0 + H4, price=Decimal(105))
    db.add(ev)
    db.flush()
    assert notify_event(db, ev, now=T0 + H4) >= 2
    subject, body = _mails_to(outbox, u)[1]
    assert subject == f"[Тестовый режим] {inst.symbol}: достигнут TP1"
    assert TEST_NOTE in body and "/unsubscribe?token=" in body
    assert _pushes_to(outbox, u)[1]["title"].startswith("[Тестовый режим] ")

    kinds = db.execute(
        select(NotificationLog.channel, NotificationLog.kind).where(NotificationLog.user_id == u.id)
    ).all()
    assert sorted(tuple(k) for k in kinds) == [
        ("email", "event"),
        ("email", "signal"),
        ("push", "event"),
        ("push", "signal"),
    ]


@db_only
def test_email_and_push_opt_ins_are_independent(db: Session, outbox: Outbox) -> None:
    only_mail, only_push = _user(db), _user(db)
    _settings(db, only_mail, email_test_signals=True)
    _settings(db, only_push, push_test_signals=True)
    ver, inst = _setup(db, "forward")
    sig = _publish(db, ver, inst)
    notify_new_signal(db, sig, now=T0 + timedelta(minutes=1))
    assert len(_mails_to(outbox, only_mail)) == 1 and _pushes_to(outbox, only_mail) == []
    assert _mails_to(outbox, only_push) == [] and len(_pushes_to(outbox, only_push)) == 1


@db_only
def test_test_signal_notifications_respect_grades_quiet_hours_and_flag(
    db: Session, outbox: Outbox, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Тот же путь, что у live-уведомлений: градации и тихие часы действуют; снятый флаг тарифа
    ``test_signals`` выключает рассылку и подписавшимся."""
    other_grade, quiet, closed = _user(db), _user(db), _user(db)
    _settings(db, other_grade, email_test_signals=True, grades=["B", "C"])
    _settings(db, quiet, email_test_signals=True, quiet_from=8, quiet_to=10)
    _settings(db, closed, email_test_signals=True)
    ver, inst = _setup(db, "forward")
    sig = _publish(db, ver, inst)  # градация A, 08:00 UTC
    with monkeypatch.context() as m:
        m.setitem(ENTITLEMENTS, "pro", replace(ENTITLEMENTS["pro"], test_signals=False))
        assert notify_new_signal(db, sig, now=T0 + timedelta(minutes=1)) == 0
    assert outbox.mails == []
    notify_new_signal(db, sig, now=T0 + timedelta(minutes=1))
    assert _mails_to(outbox, other_grade) == [] and _mails_to(outbox, quiet) == []
    assert len(_mails_to(outbox, closed)) == 1


@db_only
def test_live_notifications_are_unchanged(db: Session, outbox: Outbox) -> None:
    """Live-сигнал: письмо и push тем, у кого включены прежние настройки, без пометки; подписка
    только на тестовые сигналы live-уведомлений не даёт."""
    live_reader, test_reader = _user(db), _user(db)
    _settings(db, live_reader, email_signals=True, email_events=True)
    _settings(
        db,
        test_reader,
        email_test_signals=True,
        push_test_signals=True,
        push_signals=False,
        push_events=False,
    )
    ver, inst = _setup(db, "live")
    sig = _publish(db, ver, inst)
    assert sig.scope == "live"
    notify_new_signal(db, sig, now=T0 + timedelta(minutes=1))
    ev = SignalEvent(signal_id=sig.id, type="activated", occurred_at=T0 + H4)
    db.add(ev)
    db.flush()
    notify_event(db, ev, now=T0 + H4)

    subjects = [s for s, _ in _mails_to(outbox, live_reader)]
    assert subjects == [f"Сигнал {inst.symbol} LONG A", f"{inst.symbol}: вход исполнен"]
    assert all("естов" not in s + b for s, b in _mails_to(outbox, live_reader))
    pushes = _pushes_to(outbox, live_reader)
    assert len(pushes) == 2 and all("Тестовый" not in p["title"] for p in pushes)
    assert _mails_to(outbox, test_reader) == [] and _pushes_to(outbox, test_reader) == []


@db_only
def test_settings_api_toggles_and_unsubscribe_link_turns_test_mail_off(db: Session) -> None:
    u = _user(db)
    assert user_router.get_notifications(user=u, db=db)["email_test_signals"] is False
    out = user_router.update_notifications(
        user_router.NotificationsIn(email_test_signals=True, push_test_signals=True),
        user=u,
        db=db,
    )
    assert out["email_test_signals"] is True and out["push_test_signals"] is True
    assert out["email_signals"] is False  # соседние настройки не тронуты

    ns = settings_for(db, u)
    assert unsubscribe(db, ns.unsubscribe_token) is True
    after = user_router.get_notifications(user=u, db=db)
    assert after["email_test_signals"] is False  # отписка по ссылке из письма снимает и это
    assert after["push_test_signals"] is True  # push выключается в настройках, не ссылкой
    out = user_router.update_notifications(
        user_router.NotificationsIn(push_test_signals=False), user=u, db=db
    )
    assert out["push_test_signals"] is False
