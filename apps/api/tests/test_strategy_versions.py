"""Новые версии стратегии из кода создаются со статусом backtest и не оцениваются (план 2.9, 3.15).

Чистые части — без БД. Создание строк и прогон scheduler/forward — на реальной БД (нужен
DATABASE_URL с применёнными миграциями); без неё эти тесты пропускаются, а не падают. Каждый
тест идёт во внешней транзакции, которая в конце откатывается: ``commit`` внутри
``sync_strategy_versions`` и ``process_symbol`` закрывает только точку сохранения.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterator
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import Connection, select, text
from sqlalchemy.exc import DBAPIError, OperationalError
from sqlalchemy.orm import Session

import app.forward as forward
import app.workers.scheduler as scheduler
from app.admin_rules import transition_allowed
from app.db import engine
from app.models import Instrument, Strategy, StrategyVersion
from engine.params import StrategyParams
from engine.signal import MarketInputs, NoSignal
from engine.strategies import STRATEGIES

AT = datetime(2026, 11, 5, 8, tzinfo=UTC)
PARAMS_OLD = STRATEGIES["trend-ob-retest@1.1.0"]
PARAMS_NEW = STRATEGIES["trend-ob-retest@1.2.0"]


def _row(status: str) -> StrategyVersion:
    return StrategyVersion(strategy_id=1, version="0.0.0", params={}, status=status)


# --- без БД ------------------------------------------------------------------------------------


def test_only_forward_and_live_are_evaluated() -> None:
    rows = {
        "s@1": _row("backtest"),
        "s@2": _row("forward"),
        "s@3": _row("live"),
        "s@4": _row("archived"),
    }
    assert list(forward.evaluated_versions(rows)) == ["s@2", "s@3"]
    assert forward.skipped_versions(rows) == {"s@1": "backtest", "s@4": "archived"}
    assert forward.NEW_VERSION_STATUS not in forward.EVALUATED_STATUSES


def test_new_version_reaches_forward_only_by_admin_request() -> None:
    # новая версия создаётся в backtest; дальше — существующая заявка в админке, live — только
    # из forward
    assert forward.NEW_VERSION_STATUS == "backtest"
    assert transition_allowed(forward.NEW_VERSION_STATUS, "forward")
    assert not transition_allowed(forward.NEW_VERSION_STATUS, "live")


def test_skipped_version_logged_once_per_process(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(scheduler, "_reported_skips", {})
    caplog.set_level(logging.INFO, logger="scheduler")
    rows = {"s@1.2.0": _row("backtest"), "s@1.0.0": _row("forward")}
    for _ in range(3):  # scheduler зовёт это на каждый инструмент
        scheduler.report_skipped_versions(rows)
    assert [r.getMessage() for r in caplog.records] == [
        "версия s@1.2.0 в статусе backtest — не оценивается"
    ]
    # статус сменился (backtest → archived) — об этом одна новая строка
    scheduler.report_skipped_versions({"s@1.2.0": _row("archived")})
    scheduler.report_skipped_versions({"s@1.2.0": _row("archived")})
    assert [r.getMessage() for r in caplog.records][1:] == [
        "версия s@1.2.0 в статусе archived — не оценивается"
    ]


def test_skipped_version_logged_again_when_it_returns_to_a_skipped_status(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(scheduler, "_reported_skips", {})
    caplog.set_level(logging.INFO, logger="scheduler")
    line = "версия s@1.2.0 в статусе backtest — не оценивается"
    # backtest → forward → backtest: версия снова перестала оцениваться — строка снова
    for status in ("backtest", "backtest", "forward", "forward", "backtest", "backtest"):
        scheduler.report_skipped_versions({"s@1.2.0": _row(status)})
    assert [r.getMessage() for r in caplog.records] == [line, line]
    # backtest → archived → backtest: прежний статус через другой неоцениваемый — тоже строка
    caplog.clear()
    for status in ("archived", "backtest", "backtest"):
        scheduler.report_skipped_versions({"s@1.2.0": _row(status)})
    assert [r.getMessage() for r in caplog.records] == [
        "версия s@1.2.0 в статусе archived — не оценивается",
        line,
    ]
    # версии, которой нет в переданных строках, память не касается
    caplog.clear()
    scheduler.report_skipped_versions({"s@9.9.9": _row("forward")})
    scheduler.report_skipped_versions({"s@1.2.0": _row("backtest")})
    assert caplog.records == []


# --- на БД --------------------------------------------------------------------------------------


def _db_available() -> bool:
    try:
        with engine.connect() as conn:
            conn.execute(text("select 1 from strategy_versions limit 0"))
        return True
    except (OperationalError, DBAPIError):
        return False


db_only = pytest.mark.skipif(not _db_available(), reason="БД с миграциями недоступна")

SLUG = "test-new-version-status"
KEY_OLD = f"{SLUG}@9.0.0"
KEY_NEW = f"{SLUG}@9.1.0"


@pytest.fixture
def conn() -> Iterator[Connection]:
    c = engine.connect()
    outer = c.begin()
    try:
        yield c
    finally:
        outer.rollback()
        c.close()


@pytest.fixture
def make_session(conn: Connection) -> Callable[[], Session]:
    return lambda: Session(bind=conn, join_transaction_mode="create_savepoint")


@pytest.fixture
def code_versions(monkeypatch: pytest.MonkeyPatch) -> dict[str, StrategyParams]:
    """Версии «в коде»: 9.0.0 уже есть в БД в forward, 9.1.0 — новая."""
    strategies = {KEY_OLD: PARAMS_OLD, KEY_NEW: PARAMS_NEW}
    monkeypatch.setattr(forward, "STRATEGY_SLUG", SLUG)
    monkeypatch.setattr(forward, "STRATEGIES", strategies)
    monkeypatch.setattr(scheduler, "STRATEGIES", strategies)
    monkeypatch.setattr(scheduler, "_reported_skips", {})
    return strategies


def _seed(s: Session) -> tuple[StrategyVersion, Instrument]:
    strat = Strategy(slug=SLUG, name="test", description_public="")
    inst = Instrument(
        exchange="binance",
        symbol="NEWVERTESTUSDT",
        base="NEWVERTEST",
        quote="USDT",
        market_type="futures",
        tick_size=Decimal("0.01"),
        lot_size=Decimal("0.001"),
    )
    s.add_all([strat, inst])
    s.flush()
    old = StrategyVersion(
        strategy_id=strat.id,
        version="9.0.0",
        params={"from": "admin"},
        status="forward",
        created_by="owner@example.com",
        approved_by="admin@example.com",
        activated_at=datetime(2026, 10, 26, tzinfo=UTC),
        changelog="переведена в forward заявкой",
    )
    s.add(old)
    s.commit()
    return old, inst


def _columns(v: StrategyVersion) -> dict[str, Any]:
    return {c.key: getattr(v, c.key) for c in StrategyVersion.__table__.columns}


def _versions(s: Session, strategy_id: int) -> dict[str, str]:
    rows = s.scalars(select(StrategyVersion).where(StrategyVersion.strategy_id == strategy_id))
    return {v.version: v.status for v in rows}


@db_only
def test_new_version_created_as_backtest_existing_untouched(
    make_session: Callable[[], Session], code_versions: dict[str, StrategyParams]
) -> None:
    with make_session() as s:
        old, _ = _seed(s)
        before = _columns(old)

        evaluated = forward.ensure_strategy_versions(s)
        assert list(evaluated) == [KEY_OLD]

        new = s.scalar(
            select(StrategyVersion).where(
                StrategyVersion.strategy_id == old.strategy_id, StrategyVersion.version == "9.1.0"
            )
        )
        assert new is not None
        assert new.status == "backtest"
        assert new.approved_by is None and new.activated_at is None
        assert new.params["version"] == PARAMS_NEW.version  # params из кода, как и раньше

        s.expire_all()  # перечитать строку из БД, а не из кэша сессии
        assert _columns(s.get_one(StrategyVersion, old.id)) == before

        # повторный вызов ничего не создаёт и статусов не меняет
        again = forward.sync_strategy_versions(s)
        assert {k: v.status for k, v in again.items()} == {KEY_OLD: "forward", KEY_NEW: "backtest"}
        assert _versions(s, old.strategy_id) == {"9.0.0": "forward", "9.1.0": "backtest"}


@db_only
def test_scheduler_does_not_evaluate_backtest_version(
    monkeypatch: pytest.MonkeyPatch,
    make_session: Callable[[], Session],
    code_versions: dict[str, StrategyParams],
    caplog: pytest.LogCaptureFixture,
) -> None:
    with make_session() as s:
        old, inst = _seed(s)
        symbol, old_id, strategy_id = inst.symbol, old.id, old.strategy_id
        before = _columns(old)

    evaluated: list[StrategyParams] = []

    def fake_evaluate(inputs: MarketInputs, at: datetime, params: StrategyParams) -> NoSignal:
        evaluated.append(params)
        return NoSignal("trigger", "нет слома структуры")

    monkeypatch.setattr(scheduler, "SessionLocal", make_session)
    monkeypatch.setattr(scheduler, "load_inputs", lambda *_: None)
    monkeypatch.setattr(scheduler, "evaluate", fake_evaluate)
    caplog.set_level(logging.INFO, logger="scheduler")

    for _ in range(2):  # два закрытия H4 в одном процессе
        assert scheduler.process_symbol(symbol, AT) == {"signals": 0, "no_signal": 0}

    assert evaluated == [PARAMS_OLD, PARAMS_OLD]  # 9.1.0 (backtest) ни разу не оценена
    skipped = [r.getMessage() for r in caplog.records if "не оценивается" in r.getMessage()]
    assert skipped == [f"версия {KEY_NEW} в статусе backtest — не оценивается"]

    with make_session() as s:
        assert _versions(s, strategy_id) == {"9.0.0": "forward", "9.1.0": "backtest"}
        assert _columns(s.get_one(StrategyVersion, old_id)) == before


@db_only
def test_forward_run_does_not_evaluate_backtest_version(
    monkeypatch: pytest.MonkeyPatch,
    make_session: Callable[[], Session],
    code_versions: dict[str, StrategyParams],
    capsys: pytest.CaptureFixture[str],
) -> None:
    with make_session() as s:
        _, inst = _seed(s)
        symbol = inst.symbol

    evaluated: list[StrategyParams] = []

    def fake_evaluate(inputs: MarketInputs, at: datetime, params: StrategyParams) -> NoSignal:
        evaluated.append(params)
        return NoSignal("trigger", "нет слома структуры")

    monkeypatch.setattr(forward, "SessionLocal", make_session)
    monkeypatch.setattr(forward, "load_inputs", lambda *_: None)
    monkeypatch.setattr(forward, "evaluate", fake_evaluate)

    stats = forward.run_forward([symbol], refresh=False, now=AT, track=False)

    assert stats["instruments"] == 1 and stats["signals"] == 0
    assert evaluated == [PARAMS_OLD]
    assert f"версия {KEY_NEW} в статусе backtest — не оценивается" in capsys.readouterr().out


@db_only
def test_version_with_a_symbol_list_is_evaluated_only_on_its_instruments(
    monkeypatch: pytest.MonkeyPatch,
    make_session: Callable[[], Session],
    code_versions: dict[str, StrategyParams],
) -> None:
    """Версия со своим списком инструментов (``StrategyParams.symbols``, задача 11) — scheduler и
    форвард не оценивают её по инструменту вне списка; инструменты из списка — как обычно."""
    with make_session() as s:
        _, inst = _seed(s)
        symbol = inst.symbol
    elsewhere = replace(PARAMS_OLD, symbols=("BTCUSDT", "ETHUSDT"))
    here = replace(PARAMS_OLD, symbols=(symbol, "ETHUSDT"))
    evaluated: list[StrategyParams] = []

    def fake_evaluate(inputs: MarketInputs, at: datetime, params: StrategyParams) -> NoSignal:
        evaluated.append(params)
        return NoSignal("trigger", "нет слома структуры")

    for module in (scheduler, forward):
        monkeypatch.setattr(module, "SessionLocal", make_session)
        monkeypatch.setattr(module, "load_inputs", lambda *_: None)
        monkeypatch.setattr(module, "evaluate", fake_evaluate)

    code_versions[KEY_OLD] = elsewhere
    assert scheduler.process_symbol(symbol, AT) == {"signals": 0, "no_signal": 0}
    assert forward.run_forward([symbol], refresh=False, now=AT, track=False)["signals"] == 0
    assert evaluated == []  # инструмента нет в списке версии — не оценивается нигде

    code_versions[KEY_OLD] = here
    scheduler.process_symbol(symbol, AT + timedelta(hours=4))
    forward.run_forward([symbol], refresh=False, now=AT + timedelta(hours=4), track=False)
    assert evaluated == [here, here]
