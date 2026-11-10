"""Область сигнала (forward/live) фиксируется при публикации (план 2.11, правило 5; задача 5).

Без БД — правила выбора области. На БД (нужен DATABASE_URL с миграциями до head; без БД тесты
пропускаются) — сценарии из критериев приёмки: перевод версии в live, замена live-версии,
уведомления, триггер, миграция 0022 вверх и вниз. Каждый тест на БД работает во внешней
транзакции и откатывается в конце.
"""

from __future__ import annotations

import importlib.util
import secrets
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError, OperationalError
from sqlalchemy.orm import Session

from app import auth
from app.db import engine
from app.forward import write_candidate
from app.models import (
    AdminAudit,
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
from app.notify import _live_signal, notify_event, notify_new_signal
from app.routers import admin, public
from app.signal_scope import (
    FORWARD_DEFAULT_VERSION_STATUSES,
    scope_at_publication,
    scope_filter,
)
from app.snapshots import recompute
from app.stats import load_trades
from engine.structure import Direction

MIGRATION = (
    Path(__file__).resolve().parents[1] / "alembic" / "versions" / "20261105_0022_signal_scope.py"
)
T0 = datetime(2026, 10, 26, 8, tzinfo=UTC)
H4 = timedelta(hours=4)


# --- без БД ----------------------------------------------------------------------------------


def test_scope_at_publication_follows_version_status() -> None:
    assert scope_at_publication("forward") == "forward"
    assert scope_at_publication("live") == "live"
    assert scope_at_publication("backtest") is None
    assert scope_at_publication("archived") is None


def test_scope_filter_rejects_unknown_scope() -> None:
    with pytest.raises(ValueError, match="неизвестная область"):
        scope_filter("backtest")


def test_forward_default_covers_forward_and_live_versions() -> None:
    assert set(FORWARD_DEFAULT_VERSION_STATUSES) == {"forward", "live"}


def test_notifications_only_for_live_scope() -> None:
    assert _live_signal(Signal(scope="live"))
    assert not _live_signal(Signal(scope="forward"))


# --- на БД -----------------------------------------------------------------------------------


def _db_available() -> bool:
    try:
        with engine.connect() as conn:
            conn.execute(text("select scope from signals limit 0"))
        return True
    except (OperationalError, DBAPIError):
        return False


db_only = pytest.mark.skipif(
    not _db_available(), reason="БД с применёнными миграциями (до 0022) недоступна"
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


def _user(db: Session, role: str = "admin") -> User:
    u = User(
        email=f"scope-{_tag()}@example.test",
        role=role,
        email_verified_at=datetime(2026, 10, 1, tzinfo=UTC),
    )
    db.add(u)
    db.flush()
    return u


def _setup(db: Session, status: str = "forward") -> tuple[Strategy, StrategyVersion, Instrument]:
    tag = _tag()
    inst = Instrument(
        exchange="binance",
        symbol=f"SC{tag.upper()}USDT",
        base=f"SC{tag.upper()}",
        quote="USDT",
        market_type="futures",
        tick_size=Decimal("0.01"),
        lot_size=Decimal("0.001"),
    )
    strat = Strategy(slug=f"scope-{tag}", name="scope test")
    db.add_all([inst, strat])
    db.flush()
    ver = StrategyVersion(
        strategy_id=strat.id, version=f"0.{tag}.0", params={"t": tag}, status=status
    )
    db.add(ver)
    db.flush()
    return strat, ver, inst


def _instrument(db: Session) -> Instrument:
    """Ещё один инструмент. Одна открытая сделка на инструмент и версию (задача 6): второй
    сигнал версии по той же монете не пишется, пока первый открыт."""
    tag = _tag().upper()
    inst = Instrument(
        exchange="binance",
        symbol=f"SC{tag}USDT",
        base=f"SC{tag}",
        quote="USDT",
        market_type="futures",
        tick_size=Decimal("0.01"),
        lot_size=Decimal("0.001"),
    )
    db.add(inst)
    db.flush()
    return inst


def _version(db: Session, strat: Strategy, status: str) -> StrategyVersion:
    ver = StrategyVersion(
        strategy_id=strat.id, version=f"0.{_tag()}.1", params={"t": _tag()}, status=status
    )
    db.add(ver)
    db.flush()
    return ver


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


def _publish(db: Session, ver: StrategyVersion, inst: Instrument, at: datetime) -> Signal:
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


def _close(db: Session, sig: Signal, r: str) -> None:
    """Закрытие трекером: статус и результат (торговые поля и scope не трогаются)."""
    status = "closed_sl" if Decimal(r) < 0 else "closed_tp3"
    closed_at = sig.candle_close_time + 15 * H4
    sig.status = status
    db.add(
        SignalEvent(
            signal_id=sig.id, type="sl" if status == "closed_sl" else "tp3", occurred_at=closed_at
        )
    )
    db.add(
        SignalResult(
            signal_id=sig.id,
            realized_r=Decimal(r),
            duration_hours=Decimal(60),
            max_favorable_r=Decimal(1),
            max_adverse_r=Decimal(-1),
            closed_at=closed_at,
        )
    )
    db.commit()


def _to_live(db: Session, ver: StrategyVersion) -> None:
    """Перевод в live существующей заявкой в админке (четыре глаза: два разных admin)."""
    a, b = _user(db), _user(db)
    created = admin.create_status_request(
        admin.StatusRequestIn(
            strategy_version_id=ver.id, to_status="live", reason="тест области сигнала"
        ),
        user=a,
        db=db,
    )
    out = admin.decide_status_request(created["id"], admin.DecisionIn(approve=True), user=b, db=db)
    assert out["status"] == "live"


def _client(db: Session, holder: dict[str, User | None]) -> TestClient:
    app = FastAPI()
    app.include_router(public.router)
    app.dependency_overrides[auth.get_db] = lambda: db
    app.dependency_overrides[public.optional_user] = lambda: holder["user"]
    return TestClient(app)


def _ids(trades: list[Any]) -> set[str]:
    return {t.facts[0] for t in trades}


@db_only
def test_forward_history_stays_forward_after_version_goes_live(db: Session) -> None:
    """Критерий 1: у версии есть форвард-сигналы → заявка переводит её в live → старые сигналы
    остаются в форвард-статистике и не видны в live-ленте; новые сигналы пишутся как live."""
    _, ver, inst = _setup(db, "forward")
    open_fwd = _publish(db, ver, _instrument(db), T0)  # открыт до конца теста — своя монета
    closed_fwd = _publish(db, ver, inst, T0 + H4)
    _close(db, closed_fwd, "-1")
    assert open_fwd.scope == closed_fwd.scope == "forward"

    _to_live(db, ver)
    new_live = _publish(db, ver, inst, T0 + 20 * H4)
    _close(db, new_live, "2.5")
    assert new_live.scope == "live"
    db.expire_all()
    assert db.get(Signal, open_fwd.id).scope == "forward"  # type: ignore[union-attr]
    assert db.get(Signal, closed_fwd.id).scope == "forward"  # type: ignore[union-attr]

    # статистика: live — только новый сигнал; форвард версии — обе её форвард-записи (форвард
    # считается только по одной версии, задача 2; версия теперь в live)
    assert _ids(load_trades(db, "live", ver.id)) == {new_live.public_id}
    assert _ids(load_trades(db, "forward", ver.id)) == {open_fwd.public_id, closed_fwd.public_id}
    assert not {open_fwd.public_id, closed_fwd.public_id} & _ids(load_trades(db, "live"))

    # снимки статистики пересчитываются по области публикации
    recompute(db)
    holder: dict[str, User | None] = {"user": None}
    client = _client(db, holder)
    live_stats = client.get(f"/v1/stats?scope=live&version={ver.version}").json()
    assert live_stats["source"] == "snapshot"
    assert live_stats["metrics"]["closed"] == 1
    assert live_stats["metrics"]["sum_r"] == 2.5

    # лента и карточка: без входа форвард-сигнал версии, ставшей live, не виден
    feed = client.get("/v1/signals?scope=live").json()
    assert new_live.public_id in {i["id"] for i in feed["items"]}
    assert closed_fwd.public_id not in {i["id"] for i in feed["items"]}
    assert client.get(f"/v1/signals/{closed_fwd.public_id}").status_code == 404
    # анализ и свечи карточки — по тому же правилу, что сама карточка (ревью T5-R4)
    assert client.get(f"/v1/signals/{closed_fwd.public_id}/analysis").status_code == 404
    assert client.get(f"/v1/signals/{closed_fwd.public_id}/candles").status_code == 404
    assert client.get(f"/v1/signals/{new_live.public_id}/candles").status_code == 200
    card = client.get(f"/v1/signals/{new_live.public_id}").json()
    assert card["scope"] == "live"

    # admin видит форвард-историю версии, в том числе по явной версии
    holder["user"] = _user(db)
    fwd_feed = client.get(f"/v1/signals?scope=forward&version={ver.version}").json()
    assert {i["id"] for i in fwd_feed["items"]} == {open_fwd.public_id, closed_fwd.public_id}
    live_feed = client.get("/v1/signals?scope=live&status=open").json()
    assert open_fwd.public_id not in {i["id"] for i in live_feed["items"]}
    summary = client.get("/v1/signals/summary?scope=live").json()
    assert summary["active"] == 0  # открытый форвард-сигнал в live не считается
    assert client.get(f"/v1/signals/{closed_fwd.public_id}").json()["scope"] == "forward"
    assert client.get(f"/v1/signals/{closed_fwd.public_id}/candles").status_code == 200


@db_only
def test_replaced_live_version_keeps_live_history(db: Session) -> None:
    """Критерий 2: замена live-версии другой (прежняя уходит в forward) → её live-сигналы
    остаются в live-статистике; её новые сигналы пишутся как forward."""
    strat, old, inst = _setup(db, "live")
    old_live = _publish(db, old, inst, T0)
    _close(db, old_live, "1.5")
    assert old_live.scope == "live"

    new = _version(db, strat, "forward")
    _to_live(db, new)
    db.refresh(old)
    assert old.status == "forward"
    assert db.scalar(
        select(AdminAudit.id).where(
            AdminAudit.target == f"strategy_version:{old.id}",
            AdminAudit.payload["reason"].astext == "replaced",
        )
    )

    assert _ids(load_trades(db, "live", old.id)) == {old_live.public_id}
    assert old_live.public_id in _ids(load_trades(db, "live"))
    assert _ids(load_trades(db, "forward", old.id)) == set()

    after = _publish(db, old, inst, T0 + 30 * H4)
    assert after.scope == "forward"

    # живая история версии видна и после архивации (полная история, правило 4)
    old.status = "archived"
    db.commit()
    holder: dict[str, User | None] = {"user": None}
    client = _client(db, holder)
    assert client.get(f"/v1/signals/{old_live.public_id}").json()["scope"] == "live"
    stats = client.get(f"/v1/stats?scope=live&version={old.version}").json()
    assert stats["metrics"]["closed"] == 1
    holder["user"] = _user(db)
    fwd = client.get(f"/v1/signals?scope=forward&version={old.version}").json()
    assert {i["id"] for i in fwd["items"]} == {after.public_id}


@db_only
def test_no_notification_for_forward_signal_of_version_now_live(db: Session) -> None:
    """Критерий 3: по открытому форвард-сигналу версии, ставшей live, уведомление о событии
    не отправляется; по live-сигналу той же версии — отправляется."""
    reader = _user(db)
    db.add(
        NotificationSettings(
            user_id=reader.id,
            email_signals=True,
            email_events=True,
            unsubscribe_token=secrets.token_urlsafe(16),
        )
    )
    _, ver, inst = _setup(db, "forward")
    fwd = _publish(db, ver, inst, T0)
    _to_live(db, ver)

    ev = SignalEvent(signal_id=fwd.id, type="activated", occurred_at=T0 + timedelta(minutes=1))
    db.add(ev)
    db.flush()
    assert notify_event(db, ev, now=T0 + timedelta(minutes=2)) == 0
    assert notify_new_signal(db, fwd, now=T0 + timedelta(minutes=2)) == 0

    live = _publish(db, ver, _instrument(db), T0 + 2 * H4)  # монета fwd занята, он открыт
    ev2 = SignalEvent(signal_id=live.id, type="activated", occurred_at=T0 + 2 * H4)
    db.add(ev2)
    db.flush()
    assert notify_event(db, ev2, now=T0 + 2 * H4 + timedelta(minutes=1)) >= 1
    refs = set(
        db.scalars(select(NotificationLog.ref).where(NotificationLog.user_id == reader.id)).all()
    )
    assert refs == {str(ev2.id)}


@db_only
def test_candidate_not_written_when_version_left_forward(db: Session) -> None:
    """Статус читается в момент записи: версия, ушедшая в архив после начала прогона,
    сигнал не пишет."""
    _, ver, inst = _setup(db, "forward")
    db.execute(
        text("update strategy_versions set status = 'archived' where id = :id"), {"id": ver.id}
    )
    assert ver.status == "forward"  # объект в сессии ещё со старым статусом
    assert not write_candidate(db, ver, inst, _candidate(T0))
    assert db.scalar(select(Signal.id).where(Signal.strategy_version_id == ver.id)) is None


@db_only
def test_scope_cannot_change_even_with_status(db: Session) -> None:
    """Критерий 4 (триггер): статус менять можно, область — нет."""
    _, ver, inst = _setup(db, "forward")
    sig = _publish(db, ver, inst, T0)
    sig.status = "active"
    db.flush()
    with pytest.raises(DBAPIError, match="неизменяемы"):
        db.execute(text("update signals set scope = 'live' where id = :id"), {"id": sig.id})


# --- миграция 0022 ---------------------------------------------------------------------------


def _migration() -> ModuleType:
    spec = importlib.util.spec_from_file_location("migration_0022", MIGRATION)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _run(db: Session, step: str) -> None:
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    ctx = MigrationContext.configure(db.connection())
    with Operations.context(ctx):
        getattr(_migration(), step)()


def _has_scope_column(db: Session) -> bool:
    return bool(
        db.execute(
            text(
                "select 1 from information_schema.columns "
                "where table_name = 'signals' and column_name = 'scope'"
            )
        ).first()
    )


def _raw_signal(db: Session, ver: StrategyVersion, inst: Instrument, public_id: str) -> None:
    """Сигнал в схеме до 0022 (без scope) — как строки production до миграции."""
    db.execute(
        text(
            "insert into signals (public_id, strategy_version_id, instrument_id, direction, "
            "candle_close_time, entry_market, stop_loss, tp1, tp2, tp3, rr_tp2, score, grade, "
            "input_hash) values (:p, :v, :i, 'long', :t, 100, 95, 105, 110, 120, 2, 70, 'B', :h)"
        ),
        {"p": public_id, "v": ver.id, "i": inst.id, "t": T0, "h": "m" * 64},
    )


@db_only
def test_migration_down_and_up_backfills_forward(db: Session) -> None:
    _, ver, inst = _setup(db, "archived")  # версия уже в архиве, live у неё не было
    _run(db, "downgrade")
    assert not _has_scope_column(db)
    fn = db.execute(
        text("select prosrc from pg_proc where proname = :n"),
        {"n": "signals_trade_fields_immutable"},
    ).scalar_one()
    assert "scope" not in fn and "stop_loss" in fn
    _raw_signal(db, ver, inst, "mig0022a")

    _run(db, "upgrade")
    assert _has_scope_column(db)
    assert (
        db.execute(text("select scope from signals where public_id = 'mig0022a'")).scalar_one()
        == "forward"
    )
    with pytest.raises(DBAPIError, match="неизменяемы"):
        db.execute(text("update signals set scope = 'live' where public_id = 'mig0022a'"))


@db_only
@pytest.mark.parametrize("trace", ["activated_at", "status", "request", "audit"])
def test_migration_stops_if_any_version_was_live(db: Session, trace: str) -> None:
    _, ver, inst = _setup(db, "forward")
    _run(db, "downgrade")
    _raw_signal(db, ver, inst, "mig0022b")
    actor = _user(db)
    if trace == "activated_at":
        ver.activated_at = T0
        ver.status = "archived"
    elif trace == "status":
        ver.status = "live"
    elif trace == "request":
        db.execute(
            text(
                "insert into status_change_requests (strategy_version_id, from_status, "
                "to_status, reason, requested_by, decision) "
                "values (:v, 'forward', 'live', 'тестовая заявка', :u, 'applied')"
            ),
            {"v": ver.id, "u": actor.id},
        )
    else:
        db.add(
            AdminAudit(
                actor_id=actor.id,
                action="version.status",
                target=f"strategy_version:{ver.id}",
                payload={"from": "forward", "to": "live"},
            )
        )
    db.flush()
    with pytest.raises(RuntimeError, match="Миграция 0022 остановлена"):
        _run(db, "upgrade")
    assert not _has_scope_column(db)


@db_only
def test_migration_downgrade_refuses_with_live_signals(db: Session) -> None:
    _, ver, inst = _setup(db, "live")
    _publish(db, ver, inst, T0)
    with pytest.raises(RuntimeError, match="Откат 0022 остановлен"):
        _run(db, "downgrade")
    assert _has_scope_column(db)
