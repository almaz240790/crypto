"""Публичная статистика (план 2.11, 3.10): «худшие периоды» и форвард по одной версии."""

from __future__ import annotations

import random
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy.orm import Session

from app.stats import stats_payload, worst_drawdowns
from engine.backtest import BacktestTrade, TradeResult, TradeStatus, summarize
from engine.scoring import Grade
from engine.structure import Direction

T0 = datetime(2026, 10, 26, tzinfo=UTC)


def _trade(r: str, signal_h: float, exit_h: float, sym: str = "X") -> BacktestTrade:
    status = TradeStatus.CLOSED_TP3 if Decimal(r) > 0 else TradeStatus.CLOSED_SL
    res = TradeResult(status, Decimal(r), None, None, 0, 0, 0, Decimal(0), Decimal(0), Decimal(0))
    t = T0 + timedelta(hours=signal_h)
    return BacktestTrade(
        sym, Direction.UP, t, Grade.A, 80, Decimal(2), Decimal(1), Decimal(0), Decimal(2),
        Decimal(3), Decimal(4), res, T0 + timedelta(hours=exit_h), ("sig", "market"),
    )  # fmt: skip


def test_worst_drawdowns_follow_close_time_not_signal_time() -> None:
    """Сделки закрываются не в порядке открытия: долгая прибыльная открыта первой, а две быстрые
    убыточные после неё закрываются раньше. Дно не может оказаться раньше пика."""
    trades = [
        _trade("2", 0, 48),  # открыта первой, закрыта последней
        _trade("-1", 12, 16),
        _trade("-1", 24, 28),
    ]
    dd = worst_drawdowns(trades)
    assert dd == [
        {
            # до первой сделки итог 0, пик — начало учёта (первый сигнал)
            "start": T0.isoformat(),
            "trough": (T0 + timedelta(hours=28)).isoformat(),
            "depth_r": 2.0,
        }
    ]
    # прежний порядок (по сигналу) давал пик 28.10 00:00 и дно 27.10 04:00 — дно раньше пика
    for d in dd:
        assert d["start"] <= d["trough"]
    # метрики движка не меняются: max_drawdown_r по-прежнему в порядке сигналов
    assert stats_payload(trades)["metrics"]["max_drawdown_r"] == float(
        round(summarize(trades).max_drawdown_r, 4)
    )


def test_worst_drawdowns_same_close_time_counted_together() -> None:
    """Две сделки закрылись одной свечой (+1 и −1): порядок внутри свечи ничего не значит,
    просадки «внутри минуты» нет — итог в этот момент не изменился."""
    a = [_trade("1", 0, 8, "A"), _trade("-1", 4, 8, "B")]
    assert worst_drawdowns(a) == []
    assert worst_drawdowns(list(reversed(a))) == []


def test_worst_drawdowns_random_paths_start_before_trough() -> None:
    rng = random.Random(7)
    for _ in range(300):
        trades = []
        for i in range(rng.randint(1, 25)):
            s = rng.randint(0, 200) * 4
            r = rng.choice(["-1", "-1", "-0.5", "0.4", "1", "2.5"])
            trades.append(_trade(r, s, s + rng.randint(1, 30) * 4, f"S{i}"))
        dd = worst_drawdowns(trades)
        assert len(dd) <= 3
        assert [d["depth_r"] for d in dd] == sorted((d["depth_r"] for d in dd), reverse=True)
        for d in dd:
            assert d["start"] <= d["trough"] and d["depth_r"] > 0
        # перестановка входа не меняет результат (порядок задаёт только время закрытия)
        shuffled = trades[:]
        rng.shuffle(shuffled)
        assert worst_drawdowns(shuffled) == dd


def test_worst_drawdowns_open_and_expired_ignored() -> None:
    open_res = TradeResult(
        TradeStatus.OPEN, Decimal(0), None, None, 0, 0, None, Decimal(0), Decimal(0), Decimal(0)
    )
    t = _trade("-1", 0, 4)
    still_open = BacktestTrade(
        "Y", Direction.UP, T0, Grade.B, 60, Decimal(2), Decimal(1), Decimal(0), Decimal(2),
        Decimal(3), Decimal(4), open_res, None, ("sig2", "market"),
    )  # fmt: skip
    assert worst_drawdowns([still_open]) == []
    assert worst_drawdowns([still_open, t]) == [
        {"start": T0.isoformat(), "trough": (T0 + timedelta(hours=4)).isoformat(), "depth_r": 1.0}
    ]


def test_forward_notice_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    """По умолчанию плашка включена и без даты; пустая дата в окружении — тоже «без даты»."""
    from datetime import date

    from app.config import Settings

    monkeypatch.delenv("FORWARD_NOTICE", raising=False)
    monkeypatch.delenv("FORWARD_NOTICE_UNTIL", raising=False)
    s = Settings(_env_file=None)  # type: ignore[call-arg]
    assert s.forward_notice is True and s.forward_notice_until is None
    monkeypatch.setenv("FORWARD_NOTICE_UNTIL", "")
    assert Settings(_env_file=None).forward_notice_until is None  # type: ignore[call-arg]
    monkeypatch.setenv("FORWARD_NOTICE_UNTIL", "2026-11-06")
    monkeypatch.setenv("FORWARD_NOTICE", "false")
    s = Settings(_env_file=None)  # type: ignore[call-arg]
    assert s.forward_notice is False and s.forward_notice_until == date(2026, 11, 6)


def test_load_trades_forward_requires_version() -> None:
    """Агрегата «все версии» у форварда нет даже на уровне выборки (план 2.11)."""
    from app.stats import load_trades

    with pytest.raises(ValueError):
        load_trades(None, "forward")  # type: ignore[arg-type]  # до запроса к БД не доходит


# --- контракт /v1/stats на реальной БД (в CI — Postgres с миграциями) ---------------------------


def _db_available() -> bool:
    from sqlalchemy import text
    from sqlalchemy.exc import DBAPIError, OperationalError

    from app.db import engine

    try:
        with engine.connect() as conn:
            conn.execute(text("select 1 from stats_snapshots limit 0"))
        return True
    except (OperationalError, DBAPIError):
        return False


db_only = pytest.mark.skipif(not _db_available(), reason="БД с миграциями недоступна")


@dataclass
class Fixture:
    db: Session
    v_old: Any  # форвард, раньше — больше сделок
    v_new: Any  # форвард, наибольший id — версия по умолчанию
    v_live: Any


@pytest.fixture
def fx() -> Iterator[Fixture]:
    """Две форвард-версии и одна live в одной транзакции; ``recompute`` коммитит только точку
    сохранения, всё откатывается в конце теста."""
    from app import auth
    from app.db import engine
    from app.main import app
    from app.models import Instrument, Signal, SignalResult, Strategy, StrategyVersion

    conn = engine.connect()
    outer = conn.begin()
    db = Session(bind=conn, join_transaction_mode="create_savepoint")
    tag = datetime.now(tz=UTC).strftime("%H%M%S%f")
    strat = Strategy(slug=f"t-stats-{tag}", name="Тест статистики")
    db.add(strat)
    db.flush()

    def version(v: str, status: str) -> StrategyVersion:
        sv = StrategyVersion(strategy_id=strat.id, version=f"{v}-{tag}", params={}, status=status)
        db.add(sv)
        db.flush()
        return sv

    v_old = version("9.0", "forward")
    v_live = version("9.1", "live")
    v_new = version("9.2", "forward")
    insts = []
    for base in ("ZEC", "PEPE", "XLM"):  # свои символы, чтобы не пересечься с данными в БД
        sym = f"{base}{tag[-6:]}USDT"
        inst = Instrument(
            exchange="binance", symbol=sym, base=base, quote="USDT",
            market_type="futures", tick_size=Decimal("0.001"), lot_size=Decimal(1),
        )  # fmt: skip
        db.add(inst)
        insts.append(inst)
    db.flush()
    n = 0

    def signal(sv: StrategyVersion, inst: Instrument, h: int, r: str, close_h: int) -> None:
        nonlocal n
        n += 1
        t = T0 + timedelta(hours=h)
        s = Signal(
            public_id=f"t{tag[-9:]}{n:03d}", strategy_version_id=sv.id, instrument_id=inst.id,
            direction="short", candle_close_time=t, entry_market=Decimal(100),
            stop_loss=Decimal(101), tp1=Decimal(99), tp2=Decimal(98), tp3=Decimal(97),
            rr_tp2=Decimal(2), score=70, grade="B", input_hash="x" * 64,
            status="closed_tp3" if Decimal(r) > 0 else "closed_sl",
        )  # fmt: skip
        db.add(s)
        db.flush()
        db.add(
            SignalResult(
                signal_id=s.id, realized_r=Decimal(r), closed_at=T0 + timedelta(hours=close_h),
                duration_hours=Decimal(close_h - h), max_favorable_r=Decimal(1),
                max_adverse_r=Decimal(-1),
            )
        )  # fmt: skip

    zec, pepe, xlm = insts
    # старая форвард-версия: 4 сделки; ZEC и PEPE те же, что у новой (как 1.0 и 1.1 на production)
    signal(v_old, zec, 0, "-1", 4)
    signal(v_old, pepe, 4, "2", 40)
    signal(v_old, xlm, 8, "-1", 12)
    signal(v_old, xlm, 16, "-1", 20)
    # новая форвард-версия: 2 сделки
    signal(v_new, zec, 0, "-1", 4)
    signal(v_new, pepe, 4, "2", 40)
    # live: 1 сделка
    signal(v_live, xlm, 24, "1.5", 30)
    db.flush()
    app.dependency_overrides[auth.get_db] = lambda: db
    try:
        yield Fixture(db, v_old, v_new, v_live)
    finally:
        app.dependency_overrides.pop(auth.get_db, None)
        db.close()
        outer.rollback()
        conn.close()


def _get(path: str, status: int = 200) -> dict[str, Any]:
    from fastapi.testclient import TestClient

    from app.main import app

    r = TestClient(app).get(path)
    assert r.status_code == status, r.text
    return dict(r.json())


@db_only
def test_forward_without_version_is_one_version_not_sum(fx: Fixture) -> None:
    """Контракт: /v1/stats?scope=forward без версии — сводка по форвард-версии по умолчанию
    (наибольший id в статусе forward), а не сумма по версиям; версия названа в ответе."""
    from app.patterns import LOW_N

    default = _get("/v1/stats?scope=forward")
    old = _get(f"/v1/stats?scope=forward&version={fx.v_old.version}")
    new = _get(f"/v1/stats?scope=forward&strategy_version_id={fx.v_new.id}")
    assert old["metrics"]["closed"] == 4 and new["metrics"]["closed"] == 2
    assert default["metrics"] == new["metrics"]
    total = old["metrics"]["closed"] + new["metrics"]["closed"]
    assert default["metrics"]["closed"] != total
    assert default["strategy_version"] == {
        "id": fx.v_new.id,
        "strategy": f"t-stats-{fx.v_new.version.split('-')[-1]}",
        "name": "Тест статистики",
        "version": fx.v_new.version,
        "status": "forward",
    }
    assert old["strategy_version"]["id"] == fx.v_old.id
    # пометка «мало данных» — порог из patterns.LOW_N, числа не скрыты
    assert default["low_n_threshold"] == LOW_N and default["low_data"] is True
    assert default["metrics"]["sum_r"] == 1.0
    # live не получает полей форварда и не смешивается с ним
    live = _get("/v1/stats?scope=live")
    assert not {"strategy_version", "notice", "low_data", "low_n_threshold"} & set(live)
    assert _get(f"/v1/stats?scope=live&version={fx.v_live.version}")["metrics"]["closed"] == 1


@db_only
def test_forward_unknown_version_404(fx: Fixture) -> None:
    _get("/v1/stats?scope=forward&version=нет-такой", 404)
    _get("/v1/stats?scope=forward&strategy_version_id=999999999", 404)


@db_only
def test_forward_notice_setting(fx: Fixture, monkeypatch: pytest.MonkeyPatch) -> None:
    """Плашка включена по умолчанию; дата и выключение — настройки."""
    from datetime import date

    from app.config import settings

    monkeypatch.setattr(settings, "forward_notice", True)
    monkeypatch.setattr(settings, "forward_notice_until", None)
    assert _get("/v1/stats?scope=forward")["notice"] == {"invalid_until": None}
    monkeypatch.setattr(settings, "forward_notice_until", date(2026, 11, 6))
    assert _get("/v1/stats?scope=forward")["notice"] == {"invalid_until": "2026-11-06"}
    monkeypatch.setattr(settings, "forward_notice", False)
    assert _get("/v1/stats?scope=forward")["notice"] is None


@db_only
def test_forward_snapshots_per_version_only(fx: Fixture) -> None:
    """Снимки (ADR-0002): у форварда нет снимка «все версии»; ответ из снимка совпадает с
    расчётом на лету и тоже называет версию."""
    from sqlalchemy import select

    from app.models import StatsSnapshot
    from app.snapshots import recompute

    computed = _get("/v1/stats?scope=forward")
    assert computed["source"] == "live"
    recompute(fx.db)
    fwd_ids = set(
        fx.db.scalars(
            select(StatsSnapshot.strategy_version_id).where(StatsSnapshot.scope == "forward")
        ).all()
    )
    assert None not in fwd_ids and {fx.v_old.id, fx.v_new.id} <= fwd_ids
    live_ids = set(
        fx.db.scalars(
            select(StatsSnapshot.strategy_version_id).where(StatsSnapshot.scope == "live")
        ).all()
    )
    assert None in live_ids  # live по-прежнему и целиком, и по версиям
    snap = _get("/v1/stats?scope=forward")
    assert snap["source"] == "snapshot"
    assert snap["strategy_version"]["id"] == fx.v_new.id
    for k in ("metrics", "worst_drawdowns", "by_symbol", "equity", "low_data", "notice"):
        assert snap[k] == computed[k]


@db_only
def test_forward_trades_and_no_forward_versions(fx: Fixture) -> None:
    """Построчная история форварда (только admin) — тоже по одной версии. Если форвард-версий нет,
    ответ пустой и без версии, а не сумма по чему-либо."""
    from types import SimpleNamespace

    from app.main import app
    from app.routers.public import optional_user

    _get("/v1/stats/trades?scope=forward", 403)
    app.dependency_overrides[optional_user] = lambda: SimpleNamespace(role="admin")
    try:
        rows = _get("/v1/stats/trades?scope=forward")
        assert rows["total"] == 2 and rows["strategy_version"]["id"] == fx.v_new.id
        rows = _get(f"/v1/stats/trades?scope=forward&version={fx.v_old.version}")
        assert rows["total"] == 4
    finally:
        app.dependency_overrides.pop(optional_user, None)
    # все форвард-версии ушли из forward → сводка пустая, версии нет
    from sqlalchemy import update

    from app.models import StrategyVersion

    fx.db.execute(
        update(StrategyVersion).where(StrategyVersion.status == "forward").values(status="archived")
    )
    fx.db.flush()
    empty = _get("/v1/stats?scope=forward")
    assert empty["strategy_version"] is None and empty["metrics"]["closed"] == 0
