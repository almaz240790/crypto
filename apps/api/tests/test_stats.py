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


def _main_worst_drawdowns(closed: list[BacktestTrade], n: int = 3) -> list[dict[str, Any]]:
    """Расчёт «худших периодов» из origin/main слово в слово, кроме порядка сделок: порядок
    задаёт вызывающий. Эталон для проверки, что правка меняет только порядок (п. 4 задачи)."""
    eq = peak = Decimal(0)
    peak_t: datetime | None = None
    cur: dict[str, Any] | None = None
    out: list[dict[str, Any]] = []
    for t in closed:
        eq += t.realized_r
        when = t.exit_time or t.signal_time
        if eq >= peak:
            if cur is not None:
                out.append(cur)
                cur = None
            peak, peak_t = eq, when
        else:
            depth = peak - eq
            if cur is None or depth > cur["depth_r"]:
                cur = {
                    "start": (peak_t or when).isoformat(),
                    "trough": when.isoformat(),
                    "depth_r": float(round(depth, 2)),
                }
    if cur is not None:
        out.append(cur)
    return sorted(out, key=lambda d: -d["depth_r"])[:n]


def test_worst_drawdowns_follow_close_time_not_signal_time() -> None:
    """Сделки закрываются не в порядке открытия: долгая прибыльная открыта первой, а две быстрые
    убыточные после неё закрываются раньше. Дно не может оказаться раньше пика."""
    trades = [
        _trade("2", 0, 48),  # открыта первой, закрыта последней
        _trade("-1", 12, 16),
        _trade("-1", 24, 28),
    ]
    dd = worst_drawdowns(trades)
    # в порядке закрытия: −1 (16 ч), −1 (28 ч), +2 (48 ч) → одна просадка 2 R с дном в 28 ч;
    # до первой прибыльной сделки пика ещё не было — начало периода подписано, как и раньше,
    # временем дна
    at_28h = (T0 + timedelta(hours=28)).isoformat()
    assert dd == [{"start": at_28h, "trough": at_28h, "depth_r": 2.0}]
    # прежний порядок (по сигналу) давал пик 28.10 00:00 и дно 27.10 04:00 — дно раньше пика
    by_signal = _main_worst_drawdowns(sorted(trades, key=lambda t: t.signal_time))
    assert by_signal[0]["start"] > by_signal[0]["trough"]
    # метрики движка не меняются: max_drawdown_r по-прежнему в порядке сигналов
    assert stats_payload(trades)["metrics"]["max_drawdown_r"] == float(
        round(summarize(trades).max_drawdown_r, 4)
    )


def test_worst_drawdowns_peak_then_losses_closed_out_of_order() -> None:
    """Пик уже был: период начинается временем закрытия сделки, давшей пик, и идёт до дна."""
    trades = [
        _trade("1", 0, 4, "A"),  # пик +1 в 4 ч
        _trade("-1", 8, 40, "B"),  # открыта раньше, закрыта позже следующей
        _trade("-1", 12, 16, "C"),
        _trade("3", 44, 48, "D"),
    ]
    assert worst_drawdowns(trades) == [
        {
            "start": (T0 + timedelta(hours=4)).isoformat(),
            "trough": (T0 + timedelta(hours=40)).isoformat(),
            "depth_r": 2.0,
        }
    ]


def test_worst_drawdowns_same_close_time_keeps_input_order() -> None:
    """Две сделки закрылись одной свечой: каждая — свой шаг итога, как и раньше. Их взаимный
    порядок — порядок входного списка (``load_trades`` и ``trades_from_run`` отдают сделки в
    порядке сигналов), сортировка по закрытию его не трогает."""
    at_4h, at_8h = ((T0 + timedelta(hours=h)).isoformat() for h in (4, 8))
    first = _trade("1", 0, 4, "A")  # пик +1 в 4 ч
    loss, win = _trade("-1", 4, 8, "B"), _trade("3", 4, 8, "C")  # обе закрыты в 8 ч
    assert worst_drawdowns([first, loss, win]) == [
        {"start": at_4h, "trough": at_8h, "depth_r": 1.0}
    ]
    assert worst_drawdowns([first, win, loss]) == [
        {"start": at_8h, "trough": at_8h, "depth_r": 1.0}
    ]


def test_worst_drawdowns_differ_from_main_only_by_order() -> None:
    """Критерий приёмки задачи: блок «худшие периоды» меняется только из-за порядка (п. 4).

    На наборах, похожих на бэктест H4 (60 инструментов, выходы на закрытиях H4, много сделок с
    одним временем закрытия), результат равен прежнему расчёту, которому сделки поданы в порядке
    закрытия, — на любом входе, в том числе не упорядоченном по сигналу.
    """
    rng = random.Random(11)
    reordered = 0
    for _ in range(200):
        trades = []
        for i in range(rng.randint(1, 240)):
            s = rng.randint(0, 2000) * 4
            r = rng.choice(["-1.05", "-1.05", "-0.6", "0.35", "0.9", "2.4"])
            trades.append(_trade(r, s, s + rng.randint(1, 15) * 4, f"S{i % 60}"))
        dd = worst_drawdowns(trades)
        by_close = sorted(trades, key=lambda t: t.exit_time or t.signal_time)  # устойчивая
        assert dd == _main_worst_drawdowns(by_close)
        by_signal = sorted(trades, key=lambda t: t.signal_time)
        reordered += dd != _main_worst_drawdowns(by_signal)
        for d in dd:
            assert d["start"] <= d["trough"] and d["depth_r"] > 0
    assert reordered > 100  # порядок закрытия действительно отличается от порядка сигналов


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


def test_worst_drawdowns_open_and_expired_ignored() -> None:
    open_res = TradeResult(
        TradeStatus.OPEN, Decimal(0), None, None, 0, 0, None, Decimal(0), Decimal(0), Decimal(0)
    )
    t = _trade("-1", 0, 4)
    still_open = BacktestTrade(
        "Y", Direction.UP, T0, Grade.B, 60, Decimal(2), Decimal(1), Decimal(0), Decimal(2),
        Decimal(3), Decimal(4), open_res, None, ("sig2", "market"),
    )  # fmt: skip
    at_4h = (T0 + timedelta(hours=4)).isoformat()
    assert worst_drawdowns([still_open]) == []
    assert worst_drawdowns([still_open, t]) == [{"start": at_4h, "trough": at_4h, "depth_r": 1.0}]


def test_without_costs_counts_closed_results_recorded_before_fees() -> None:
    """Задача 3: закрытые сделки, записанные до вычета комиссий (``cost_r`` NULL), считаются
    отдельно — подпись «с учётом комиссии» на /stats их оговаривает. Открытые и истёкшие не в
    счёт; у сделок прогона бэктеста пометки нет."""
    from dataclasses import replace

    from app.stats import WITHOUT_COSTS, without_costs

    net = replace(_trade("-1", 0, 4), facts=("a", "market", ""))
    gross = replace(_trade("2", 4, 8), facts=("b", "market", WITHOUT_COSTS))
    open_res = TradeResult(
        TradeStatus.OPEN, Decimal(0), None, None, 0, 0, None, Decimal(0), Decimal(0), Decimal(0)
    )
    still_open = replace(gross, result=open_res, exit_time=None)
    expired = replace(gross, result=replace(open_res, status=TradeStatus.EXPIRED))
    assert without_costs([net, gross, still_open, expired]) == 1
    assert stats_payload([net, gross, gross])["without_costs"] == 2
    # сделки прогона бэктеста (facts без пометки) и пустой список
    assert stats_payload([_trade("-1", 0, 4)])["without_costs"] == 0
    assert stats_payload([])["without_costs"] == 0


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


def _notice_settings(monkeypatch: pytest.MonkeyPatch, **env: str) -> Any:
    """Настройки плашки, как их прочитает сервис при старте с такими переменными окружения."""
    from app.config import Settings

    monkeypatch.delenv("FORWARD_NOTICE", raising=False)
    monkeypatch.delenv("FORWARD_NOTICE_UNTIL", raising=False)
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    return Settings(_env_file=None)  # type: ignore[call-arg]


@pytest.mark.parametrize(
    "raw",
    [
        "2026-11-06",
        "06.11.2026",  # так дата написана на самой плашке
        "6.11.2026",
        "2026-11-6",
        " 2026-11-06 ",  # пробелы по краям при вставке
        "2026-11-06\n",
        '"2026-11-06"',  # кавычки из .env
        "'06.11.2026'",
        "2026-11-06T00:00:00Z",
    ],
)
def test_forward_notice_until_accepts_how_people_write_dates(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, raw: str
) -> None:
    from datetime import date

    with caplog.at_level("WARNING", logger="app.config"):
        s = _notice_settings(monkeypatch, FORWARD_NOTICE_UNTIL=raw)
    assert s.forward_notice_until == date(2026, 11, 6) and s.forward_notice is True
    assert not caplog.records  # распознано — предупреждать не о чем


def test_forward_notice_until_timestamp_is_taken_in_utc(monkeypatch: pytest.MonkeyPatch) -> None:
    from datetime import date

    s = _notice_settings(monkeypatch, FORWARD_NOTICE_UNTIL="2026-11-06T01:00:00+03:00")
    assert s.forward_notice_until == date(2026, 11, 5)  # 05.11 22:00 UTC


@pytest.mark.parametrize(
    "raw", ["6 ноября", "завтра", "2026-13-45", "31.02.2026", "06/11/2026", "2026.11.06", "-"]
)
def test_forward_notice_until_typo_does_not_stop_the_service(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, raw: str
) -> None:
    """Опечатка в дате не роняет сервис при старте: плашка остаётся включённой и выводится без
    даты («результаты недействительны» без срока — не преуменьшает), в журнале — предупреждение
    с тем, что было задано."""
    with caplog.at_level("WARNING", logger="app.config"):
        s = _notice_settings(monkeypatch, FORWARD_NOTICE_UNTIL=raw)
    assert s.forward_notice is True and s.forward_notice_until is None
    assert len(caplog.records) == 1 and caplog.records[0].levelname == "WARNING"
    msg = caplog.records[0].getMessage()
    assert "FORWARD_NOTICE_UNTIL" in msg and raw in msg and "без даты" in msg


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("true", True), ("True", True), ("1", True), ("yes", True), ("on", True), ("да", True),
        ("false", False), ("FALSE", False), ("0", False), ("no", False), ("off", False),
        ("нет", False), (" false ", False), ('"false"', False), ("off\n", False),
        ("", True),  # пустое значение — как незаданное: по умолчанию плашка включена
    ],
)  # fmt: skip
def test_forward_notice_flag_values(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, raw: str, expected: bool
) -> None:
    with caplog.at_level("WARNING", logger="app.config"):
        s = _notice_settings(monkeypatch, FORWARD_NOTICE=raw)
    assert s.forward_notice is expected
    assert not caplog.records


@pytest.mark.parametrize("raw", ["fasle", "выкл", "disabled", "2", "-"])
def test_forward_notice_flag_typo_keeps_the_plaque_on(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, raw: str
) -> None:
    """Опечатка при выключении не роняет сервис и не снимает плашку молча: она остаётся
    включённой (лишнее предупреждение безопаснее недействительных чисел без него), а в журнале
    сказано, что значение не распознано."""
    with caplog.at_level("WARNING", logger="app.config"):
        s = _notice_settings(monkeypatch, FORWARD_NOTICE=raw, FORWARD_NOTICE_UNTIL="06.11.2026")
    assert s.forward_notice is True and s.forward_notice_until is not None
    assert len(caplog.records) == 1
    msg = caplog.records[0].getMessage()
    assert "FORWARD_NOTICE=" in msg and raw in msg and "включённой" in msg


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
            scope="live" if sv.status == "live" else "forward",
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
    assert empty["notice"] is not None and empty["low_data"] is True
    # …но записанная форвард-история ушедших версий остаётся доступной: они перечислены для
    # селектора и открываются по явной версии
    assert _own_versions(fx, empty) == [(fx.v_old.id, "archived"), (fx.v_new.id, "archived")]
    assert _get(f"/v1/stats?scope=forward&version={fx.v_old.version}")["metrics"]["closed"] == 4


def _own_versions(fx: Fixture, payload: dict[str, Any]) -> list[tuple[int, str]]:
    """``versions`` из ответа — только версии стратегии этого теста (в БД могут быть и другие)."""
    slug = _get(f"/v1/stats?scope=forward&strategy_version_id={fx.v_old.id}")["strategy_version"][
        "strategy"
    ]
    return [(v["id"], v["status"]) for v in payload["versions"] if v["strategy"] == slug]


def _set_version(fx: Fixture, sv: Any, **values: Any) -> None:
    from sqlalchemy import update

    from app.models import StrategyVersion

    fx.db.execute(update(StrategyVersion).where(StrategyVersion.id == sv.id).values(**values))
    fx.db.flush()


@db_only
def test_forward_versions_listed_for_selector(fx: Fixture) -> None:
    """``versions`` — что можно выбрать на вкладке форварда: версии в статусе forward по
    возрастанию id, в том же виде, что ``strategy_version``; live-версии среди них нет."""
    d = _get("/v1/stats?scope=forward")
    assert _own_versions(fx, d) == [(fx.v_old.id, "forward"), (fx.v_new.id, "forward")]
    assert d["strategy_version"] in d["versions"]
    assert [v["id"] for v in d["versions"]] == sorted(v["id"] for v in d["versions"])
    # тот же список при любой выбранной версии и при фильтрах
    for q in (f"version={fx.v_old.version}", "grade=B", "days=30"):
        assert _own_versions(fx, _get(f"/v1/stats?scope=forward&{q}")) == _own_versions(fx, d)


@db_only
def test_forward_archived_version_keeps_recorded_history(fx: Fixture) -> None:
    """Версию перевели из форварда в архив (решение владельца по 1.0.0). Её форвард-сделки
    записаны и никуда не делись: по явной версии ответ тот же, что до архивации, а не «0 сделок»
    под её именем. По умолчанию по-прежнему показывается версия в статусе forward."""
    from types import SimpleNamespace

    from app.main import app
    from app.routers.public import optional_user
    from app.snapshots import recompute

    url = f"/v1/stats?scope=forward&version={fx.v_old.version}"
    before = _get(url)
    assert before["metrics"]["closed"] == 4 and before["strategy_version"]["status"] == "forward"

    _set_version(fx, fx.v_old, status="archived")
    after = _get(url)
    assert after["strategy_version"] == {**before["strategy_version"], "status": "archived"}
    for k in ("metrics", "by_symbol", "by_grade", "equity", "r_histogram", "worst_drawdowns"):
        assert after[k] == before[k], k
    assert after["low_data"] is True and after["notice"] == before["notice"]
    # в селекторе она остаётся — с пометкой статуса; по умолчанию — версия в форварде
    default = _get("/v1/stats?scope=forward")
    assert default["strategy_version"]["id"] == fx.v_new.id
    assert _own_versions(fx, default) == [(fx.v_old.id, "archived"), (fx.v_new.id, "forward")]
    # фильтры и построчная история (admin) работают так же
    sym = next(iter(before["by_symbol"]))
    assert _get(f"{url}&symbol={sym}")["metrics"] == before["by_symbol"][sym]
    app.dependency_overrides[optional_user] = lambda: SimpleNamespace(role="admin")
    try:
        assert _get(f"/v1/stats/trades?scope=forward&version={fx.v_old.version}")["total"] == 4
    finally:
        app.dependency_overrides.pop(optional_user, None)
    # пересчёт снимков пишет форвард по каждой версии с форвард-историей (signals.scope), в том
    # числе по архивной: числа те же, что на лету
    recompute(fx.db)
    again = _get(url)
    assert again["source"] == "snapshot" and again["metrics"] == before["metrics"]
    assert _get("/v1/stats?scope=forward")["source"] == "snapshot"

    # версия вернулась из форварда в backtest — её записанная история тоже форвардная
    _set_version(fx, fx.v_old, status="backtest")
    assert _get(url)["metrics"] == before["metrics"]
    assert (fx.v_old.id, "backtest") in _own_versions(fx, _get("/v1/stats?scope=forward"))


@db_only
def test_forward_history_never_takes_live_signals(fx: Fixture) -> None:
    """Форвард-история версии — только её сигналы с ``scope = 'forward'`` (задача 5). Live-сигналы
    live-версии в форвард не попадают ни пока она в live, ни после ухода в архив; её live-история
    при этом остаётся в live (план 2.11, правило 4)."""
    live = _get(f"/v1/stats?scope=forward&version={fx.v_live.version}")
    assert live["strategy_version"]["status"] == "live" and live["metrics"]["signals"] == 0
    assert fx.v_live.id not in [i for i, _ in _own_versions(fx, live)]

    _set_version(fx, fx.v_live, status="archived", activated_at=T0)
    was_live = _get(f"/v1/stats?scope=forward&version={fx.v_live.version}")
    assert was_live["strategy_version"]["status"] == "archived"
    assert was_live["metrics"]["signals"] == 0
    assert fx.v_live.id not in [i for i, _ in _own_versions(fx, was_live)]
    # live-история архивной версии остаётся live: область зафиксирована при публикации
    assert _get(f"/v1/stats?scope=live&version={fx.v_live.version}")["metrics"]["closed"] == 1


@db_only
def test_forward_versions_skip_departed_without_history(fx: Fixture) -> None:
    """Версия без единого сигнала, которая не в форварде (новая в backtest или архив), в селектор
    не попадает: показывать по ней нечего. По явному адресу ответ пустой и называет её статус."""
    from app.models import StrategyVersion

    tag = fx.v_old.version.split("-")[-1]
    blank = StrategyVersion(
        strategy_id=fx.v_old.strategy_id, version=f"9.9-{tag}", params={}, status="backtest"
    )
    fx.db.add(blank)
    fx.db.flush()
    d = _get(f"/v1/stats?scope=forward&strategy_version_id={blank.id}")
    assert d["strategy_version"]["status"] == "backtest" and d["metrics"]["signals"] == 0
    assert blank.id not in [i for i, _ in _own_versions(fx, d)]
    _set_version(fx, blank, status="forward")  # в форварде и без сделок — в селекторе есть
    assert (blank.id, "forward") in _own_versions(fx, _get("/v1/stats?scope=forward"))


@db_only
def test_forward_notice_with_mistyped_settings(
    fx: Fixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Плашка при опечатках в настройках: сервис стартует, API отвечает, плашка на месте и без
    даты."""
    from app.config import settings

    bad = _notice_settings(monkeypatch, FORWARD_NOTICE="fasle", FORWARD_NOTICE_UNTIL="6 ноября")
    monkeypatch.setattr(settings, "forward_notice", bad.forward_notice)
    monkeypatch.setattr(settings, "forward_notice_until", bad.forward_notice_until)
    assert _get("/v1/stats?scope=forward")["notice"] == {"invalid_until": None}


@db_only
def test_stats_execution_and_results_recorded_without_costs(fx: Fixture) -> None:
    """Задача 3: live и forward называют комиссию и проскальзывание из ``ExecutionParams`` (подпись
    на /stats берёт числа отсюда) и число закрытых сделок, записанных до вычета комиссий
    (``signal_results.cost_r`` NULL). У бэктеста поля ``execution`` нет: комиссии прогона — в
    ``run``."""
    from sqlalchemy import select

    from app.models import Signal, SignalResult
    from app.snapshots import recompute
    from app.stats import WITHOUT_COSTS, load_trades
    from engine.backtest import DEFAULT_EXECUTION

    execution = {"fee_rate": "0.0005", "slippage": "0.0003"}
    assert execution == {
        "fee_rate": str(DEFAULT_EXECUTION.fee_rate),
        "slippage": str(DEFAULT_EXECUTION.slippage),
    }
    fwd = _get("/v1/stats?scope=forward")
    assert fwd["execution"] == execution and fwd["without_costs"] == 2
    live = _get("/v1/stats?scope=live")
    assert live["execution"] == execution and live["without_costs"] >= 1
    assert "execution" not in _get("/v1/stats?scope=backtest")

    # одна из двух сделок новой версии закрыта уже с вычетом комиссий: −1 R − 0.043 R
    first = fx.db.scalars(
        select(SignalResult)
        .join(Signal, Signal.id == SignalResult.signal_id)
        .where(Signal.strategy_version_id == fx.v_new.id)
        .order_by(Signal.candle_close_time)
    ).first()
    assert first is not None
    first.realized_r, first.cost_r = Decimal("-1.043"), Decimal("0.043")
    fx.db.flush()
    trades = load_trades(fx.db, "forward", fx.v_new.id)
    assert [(t.result.cost_r, t.facts[2]) for t in trades] == [
        (Decimal("0.043"), ""),
        (Decimal(0), WITHOUT_COSTS),
    ]
    fwd = _get("/v1/stats?scope=forward")
    assert fwd["without_costs"] == 1 and fwd["metrics"]["sum_r"] == 0.957
    assert _get(f"/v1/stats?scope=forward&version={fx.v_old.version}")["without_costs"] == 4
    # фильтр считает только свои сделки; из снимка — те же поля
    by_symbol = {t.symbol: t for t in trades}
    net_symbol = next(sym for sym, t in by_symbol.items() if t.facts[2] == "")
    assert _get(f"/v1/stats?scope=forward&symbol={net_symbol}")["without_costs"] == 0
    recompute(fx.db)
    snap = _get("/v1/stats?scope=forward")
    assert snap["source"] == "snapshot"
    assert snap["execution"] == execution and snap["without_costs"] == 1
