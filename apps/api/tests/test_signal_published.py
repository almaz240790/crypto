"""Кандидаты, которые не публикуются: ниже порога публикации и отложенные (миграция 0026).

Движок отдаёт кандидата с ``Grade.NONE`` («сохраняется для анализа, но не показывается») и
отложенного из-за новостей (план 2.5). ``forward.write_candidate`` пишет их с пометками в
``rationale_facts``; БД вычисляет из них ``signals.published``. Здесь проверяется, что такой
кандидат хранится, но его не видит ни один читатель: лента, карточка, счётчики, слой графика,
статистика, письма и push, дайджест, трекер, правило одной открытой сделки, сверка.

Тесты на БД (нужен DATABASE_URL с миграциями до head; без БД пропускаются) идут во внешней
транзакции и откатываются в конце.
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

import app.forward as forward
import app.notify as notify
import app.workers.tracker as worker
from app import auth
from app.chart_data import signal_layer
from app.db import engine
from app.forward import open_trade_blocker, write_candidate
from app.models import Instrument, Signal, SignalResult, Strategy, StrategyVersion, User
from app.models.signals import PUBLISHED_SQL
from app.reconcile import load_open_trades
from app.retrack import load_signals
from app.routers import public
from app.stats import load_trades
from engine.structure import Direction

T0 = datetime(2026, 11, 2, 8, tzinfo=UTC)
H4 = timedelta(hours=4)
MIGRATION = (
    Path(__file__).resolve().parents[1]
    / "alembic"
    / "versions"
    / "20261112_0026_signal_published.py"
)


def _migration() -> ModuleType:
    spec = importlib.util.spec_from_file_location("migration_0026", MIGRATION)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_model_and_migration_compute_published_the_same_way() -> None:
    assert _migration().PUBLISHED_SQL == PUBLISHED_SQL


def test_notifications_skip_unpublished_candidates() -> None:
    assert notify._live_signal(Signal(scope="live", published=True))
    assert notify._live_signal(Signal(scope="live"))  # строка не из БД: признака ещё нет
    assert not notify._live_signal(Signal(scope="live", published=False))
    assert not notify._live_signal(Signal(scope="forward", published=True))


# --- на БД -------------------------------------------------------------------------------------


def _db_available() -> bool:
    try:
        with engine.connect() as conn:
            conn.execute(text("select published from signals limit 0"))
        return True
    except (OperationalError, DBAPIError):
        return False


db_only = pytest.mark.skipif(not _db_available(), reason="БД с миграцией 0026 недоступна")


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


def _setup(db: Session, status: str = "live") -> tuple[StrategyVersion, Instrument]:
    tag = secrets.token_hex(3)
    inst = Instrument(
        exchange="binance",
        symbol=f"PB{tag.upper()}USDT",
        base=f"PB{tag.upper()}",
        quote="USDT",
        market_type="futures",
        tick_size=Decimal("0.01"),
        lot_size=Decimal("0.001"),
    )
    strat = Strategy(slug=f"published-{tag}", name="published test")
    db.add_all([inst, strat])
    db.flush()
    ver = StrategyVersion(strategy_id=strat.id, version=f"0.{tag}.0", params={}, status=status)
    db.add(ver)
    db.flush()
    return ver, inst


def _candidate(at: datetime, publishable: bool = True, deferred: bool = False) -> Any:
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
            total=80 if publishable else 30,
            grade=SimpleNamespace(value="A" if publishable else "-"),
            publishable=publishable,
            components={"trend": 30},
        ),
        facts=("тест",),
        deferred=deferred,
        zone=SimpleNamespace(kind="ob", top=Decimal(101), bottom=Decimal(99)),
        filters=SimpleNamespace(flags=[]),
        input_hash="h" * 64,
    )


def _write(db: Session, ver: StrategyVersion, inst: Instrument, at: datetime, **kw: Any) -> Signal:
    assert write_candidate(db, ver, inst, _candidate(at, **kw))
    db.flush()
    sig = db.scalar(
        select(Signal).where(
            Signal.strategy_version_id == ver.id,
            Signal.instrument_id == inst.id,
            Signal.candle_close_time == at,
        )
    )
    assert sig is not None
    db.refresh(sig)
    return sig


@pytest.fixture
def three(db: Session) -> tuple[StrategyVersion, Instrument, Signal, Signal, Signal]:
    """Опубликованный сигнал, кандидат ниже порога и отложенный — одной версии, одного инструмента.
    Опубликованный — последним: первые два инструмент не занимают (правило задачи 6)."""
    ver, inst = _setup(db)
    below = _write(db, ver, inst, T0, publishable=False)
    deferred = _write(db, ver, inst, T0 + H4, deferred=True)
    shown = _write(db, ver, inst, T0 + H4 * 2)
    return ver, inst, shown, below, deferred


@db_only
def test_published_is_computed_from_the_written_facts(db: Session, three: Any) -> None:
    _, _, shown, below, deferred = three
    assert (shown.published, below.published, deferred.published) == (True, False, False)
    assert below.grade == "C" and below.rationale_facts["publishable"] is False
    assert deferred.rationale_facts["deferred"] is True


@db_only
def test_published_cannot_be_written(db: Session, three: Any) -> None:
    _, _, _, below, _ = three
    with pytest.raises(DBAPIError, match=r"generated|сгенерир"), db.begin_nested():
        db.execute(text("update signals set published = true where id = :i"), {"i": below.id})


def _client(db: Session, user: User | None) -> TestClient:
    app = FastAPI()
    app.include_router(public.router)
    app.dependency_overrides[auth.get_db] = lambda: db
    app.dependency_overrides[public.optional_user] = lambda: user
    return TestClient(app)


def _admin(db: Session) -> User:
    u = User(
        email=f"published-{secrets.token_hex(3)}@example.test",
        role="admin",
        email_verified_at=datetime(2026, 10, 1, tzinfo=UTC),
    )
    db.add(u)
    db.flush()
    return u


@db_only
def test_feed_card_and_counters_show_only_published(db: Session, three: Any) -> None:
    _, inst, shown, below, deferred = three
    client = _client(db, _admin(db))
    feed = client.get(f"/v1/signals?scope=live&symbol={inst.symbol}").json()
    rows = feed["items"] if isinstance(feed, dict) else feed
    assert [r["id"] for r in rows] == [shown.public_id]
    for hidden in (below, deferred):
        for suffix in ("", "/analysis", "/candles"):
            assert client.get(f"/v1/signals/{hidden.public_id}{suffix}").status_code == 404
    assert client.get(f"/v1/signals/{shown.public_id}").status_code == 200
    layer = signal_layer(db, inst, ["live"])
    assert [s["id"] for s in layer] == [shown.public_id]


@db_only
def test_stats_count_only_published(db: Session, three: Any) -> None:
    _, inst, shown, below, deferred = three
    for sig in (shown, below, deferred):
        sig.status = "closed_sl"
        db.add(SignalResult(signal_id=sig.id, realized_r=Decimal(-1), closed_at=T0 + H4 * 20))
    db.flush()
    trades = load_trades(db, "live", instrument=inst.symbol)
    assert len(trades) == 1


@db_only
def test_new_signal_mail_and_digest_skip_unpublished(
    db: Session, three: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, _, shown, below, deferred = three
    asked: list[str] = []
    monkeypatch.setattr(notify, "_recipients", lambda *_: asked.append("x") or [])
    assert notify.notify_new_signal(db, below) == 0
    assert notify.notify_new_signal(db, deferred) == 0
    assert asked == []  # до получателей дело не дошло
    notify.notify_new_signal(db, shown)
    assert asked  # опубликованный идёт к получателям как обычно


@db_only
def test_trackers_and_one_trade_rule_ignore_unpublished(
    db: Session, three: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    ver, inst, shown, _, _ = three
    seen: list[int] = []
    monkeypatch.setattr(worker, "SessionLocal", lambda: _Borrowed(db))
    monkeypatch.setattr(worker, "_advance", lambda session, sig, tf: seen.append(sig.id) or 0)
    monkeypatch.setattr(worker, "_publish_status", lambda changes: None)
    worker.catch_up(instrument_id=inst.id)
    assert seen == [shown.id]
    # H4-сопровождение форварда (cron forward без --no-track) тоже ведёт только опубликованные
    tracked: list[int] = []
    real_setup = forward._setup_from_row
    monkeypatch.setattr(
        forward, "_setup_from_row", lambda sig: tracked.append(sig.id) or real_setup(sig)
    )
    forward.track_open_signals(db, {"trend-ob-retest@1.2.0": ver})
    assert tracked == [shown.id]
    # правило одной открытой сделки видит только опубликованный сигнал
    blocker = open_trade_blocker(db, ver, inst, T0 + H4 * 3)
    assert blocker is not None and blocker.ref == shown.public_id


class _Borrowed:
    """Контекст-менеджер вокруг сессии теста: ``with SessionLocal() as s`` не закрывает её."""

    def __init__(self, s: Session) -> None:
        self.s = s

    def __enter__(self) -> Session:
        return self.s

    def __exit__(self, *_: object) -> None:
        return None


@db_only
def test_reconcile_reads_only_published(db: Session, three: Any) -> None:
    _, inst, shown, _, _ = three
    db.flush()
    conn = db.connection()
    rows = load_signals(conn, T0 - H4, T0 + H4 * 10, scopes=("live",))
    assert [r.public_id for r in rows if r.instrument_id == inst.id] == [shown.public_id]
    opened = [t.public_id for t in load_open_trades(conn) if t.instrument_id == inst.id]
    assert opened == [shown.public_id]
