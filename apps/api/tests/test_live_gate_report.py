"""Отчёт «готовность к live» (задача 9 пакета «Сигналы»).

Без БД — чистые функции: перцентили, бутстреп-интервал среднего R (детерминированный при
заданном зерне), число сделок для одностороннего критерия, скользящие окна и их сводка, статусы
критериев (в том числе по итогу сверки), бэктест-часть на синтетических свечах и
воспроизводимость отчёта байт в байт. Вместо ``evaluate`` — сценарий, записанный в самих
свечах (как в ``test_one_trade_report``), поэтому сделки бэктеста известны заранее.

На БД (нужен DATABASE_URL с миграциями до head; без БД тесты пропускаются) — раздел «Форвард»:
несколько синтетических форвард-сигналов во внешней транзакции, которая откатывается в конце.
Проверяется, какие сигналы попадают в отчёт (только опубликованные форвард-сигналы версии по
инструментам списка), их пересчёты по 1m и H4 и числа раздела; отдельно — запуск скрипта.
"""

from __future__ import annotations

import json
import random
import secrets
import sys
from collections.abc import Callable, Iterator
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import insert, select, text, update
from sqlalchemy.exc import DBAPIError, OperationalError
from sqlalchemy.orm import Session

import engine.backtest as engine_backtest
from app.db import engine
from app.forward import write_candidate
from app.live_gate_report import (
    ONE_TRADE_RULE_FROM,
    THREE_MONTHS,
    Backtest,
    Forward,
    ForwardSignal,
    GateOptions,
    Interval,
    Report,
    Status,
    SymbolRun,
    analyze,
    apply_one_trade_rule,
    backtest_symbol,
    bootstrap_means,
    build_forward,
    forward_trades,
    mean_interval,
    parse_reconcile,
    percentile,
    percentile_rank,
    render_markdown,
    report_name,
    resolve_version,
    rolling_windows,
    run_backtests,
    same_rules,
    trades_needed,
    window_stats,
    write_report,
)
from app.models import Candle as CandleRow
from app.models import Instrument, Signal, StatusChangeRequest, Strategy, StrategyVersion, User
from app.retrack import (
    Completeness,
    H4Retrack,
    MinuteRetrack,
    Outcome,
    SignalRow,
    read_only_connection,
)
from engine.backtest import (
    DEFAULT_EXECUTION,
    BacktestTrade,
    TradeResult,
    TradeStatus,
    execution_cost_r,
)
from engine.bias import Bias, BiasContext
from engine.candles import Candle, Timeframe
from engine.filters import FilterSummary
from engine.params import StrategyParams
from engine.scoring import Grade, ScoreBreakdown
from engine.signal import MarketInputs, NoSignal, SignalCandidate
from engine.strategies import STRATEGIES
from engine.structure import Direction, Trend
from engine.trade import TradeSetup
from engine.zones import Zone, ZoneKind

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts"))

D = Decimal
H4 = Timeframe.H4.delta
M1 = timedelta(minutes=1)
VERSION = "trend-ob-retest@1.2.0"


# --- статистика --------------------------------------------------------------------------------


def test_percentile_interpolates_and_rank_counts_ties_as_half() -> None:
    xs = [D(5), D(1), D(3), D(2), D(4)]
    assert percentile(xs, D("0.5")) == D(3)
    assert percentile(xs, D(0)) == D(1) and percentile(xs, D(1)) == D(5)
    assert percentile(xs, D("0.1")) == D("1.4")  # 1 + (2 − 1) × 0.4, как numpy.percentile
    assert percentile([D(7)], D("0.9")) == D(7)
    assert percentile_rank(xs, D(3)) == D("0.5")
    assert percentile_rank(xs, D(0)) == D(0) and percentile_rank(xs, D(9)) == D(1)
    assert percentile_rank([D(1), D(1), D(2), D(2)], D(1)) == D("0.25")
    with pytest.raises(ValueError):
        percentile([], D("0.5"))
    with pytest.raises(ValueError):
        percentile(xs, D("1.5"))
    with pytest.raises(ValueError):
        percentile_rank([], D(0))


def test_bootstrap_follows_seeded_generator() -> None:
    """Алгоритм закреплён: выборка — ``random.Random(seed).randrange`` подряд, среднее в Decimal."""
    values = [D(1), D(2), D(4)]
    rng = random.Random(7)
    expected = []
    for _ in range(3):
        picks = [values[rng.randrange(3)] for _ in range(2)]
        expected.append(sum(picks, D(0)) / 2)
    assert bootstrap_means(values, 2, 3, seed=7) == expected
    with pytest.raises(ValueError):
        bootstrap_means([], 1, 1, seed=1)
    with pytest.raises(ValueError):
        bootstrap_means(values, 0, 1, seed=1)


def test_mean_interval_is_deterministic_and_widens_for_fewer_trades() -> None:
    values = [D("-1.04"), D("0.36"), D("2.10"), D("-1.03"), D("0.37"), D("1.55")] * 8
    mean = sum(values, D(0)) / len(values)
    full = mean_interval(values, samples=2000, seed=11)
    again = mean_interval(values, samples=2000, seed=11)
    assert full == again  # то же зерно — тот же интервал
    assert full.size == len(values) and full.level == D("0.95")
    assert full.low < mean < full.high
    other = mean_interval(values, samples=2000, seed=12)
    assert other != full  # зерно действительно используется
    few = mean_interval(values, samples=2000, seed=11, size=5)
    assert few.size == 5
    assert few.low < full.low and few.high > full.high
    # постоянный ряд — интервал вырожден
    flat = mean_interval([D("0.5")] * 10, samples=100, seed=1)
    assert (flat.low, flat.high) == (D("0.5"), D("0.5"))
    # два значения по одному: средние — только −1 и +1, пределы — они же
    pm = mean_interval([D(-1), D(1)], samples=500, seed=3, size=1)
    assert (pm.low, pm.high) == (D(-1), D(1))
    assert Interval(3, D(-1), D(1)).contains(D(0)) and not Interval(3, D(-1), D(1)).contains(D(2))


def test_trades_needed_for_one_sided_test() -> None:
    # среднее 0.5, σ = √2: (1.645 · 1.414 / 0.5)² = 21.6 → 22
    assert trades_needed([D("-0.5"), D("1.5")]) == 22
    assert trades_needed([D(1), D(1), D(1)]) == 0  # разброса нет — ноль сделок
    assert trades_needed([D(-1), D("0.5")]) is None  # средний R не больше нуля
    assert trades_needed([D(1)]) is None


def _trade(
    at: datetime,
    r: str,
    *,
    status: TradeStatus = TradeStatus.CLOSED_SL,
    grade: Grade = Grade.B,
    direction: Direction = Direction.DOWN,
    symbol: str = "AAAUSDT",
) -> BacktestTrade:
    result = TradeResult(status, D(r), None, None, 0, 0, None, D(0), D(0), D(0))
    return BacktestTrade(
        symbol=symbol,
        direction=direction,
        signal_time=at,
        grade=grade,
        score=70,
        rr_tp2=D(2),
        entry=D(100),
        stop=D(103),
        tp1=D(97),
        tp2=D(94),
        tp3=D(88),
        result=result,
        exit_time=None if status is TradeStatus.OPEN else at + H4,
    )


def test_rolling_windows_count_trades_by_signal_time() -> None:
    t0 = datetime(2024, 1, 1, tzinfo=UTC)
    day = timedelta(days=1)
    trades = [
        _trade(t0 + timedelta(hours=4), "1.0"),
        _trade(t0 + day * 2, "-1.0"),
        _trade(t0 + day * 2 + timedelta(hours=8), "0.5"),
        _trade(t0 + day * 5, "2.0", status=TradeStatus.OPEN),  # открытая: в сумму не входит
    ]
    windows = rolling_windows(trades, t0, t0 + day * 7, day * 3)
    # окна [0; 3), [1; 4), … [4; 7) — пять окон, каждое целиком внутри периода
    assert [w.start for w in windows] == [t0 + day * k for k in range(5)]
    assert [w.trades for w in windows] == [3, 2, 2, 1, 1]
    assert [w.closed for w in windows] == [3, 2, 2, 0, 0]
    assert [w.sum_r for w in windows] == [D("0.5"), D("-0.5"), D("-0.5"), D(0), D(0)]
    assert windows[0].end == t0 + day * 3
    # окно длиннее периода — окон нет
    assert rolling_windows(trades, t0, t0 + day, day * 3) == []
    with pytest.raises(ValueError):
        rolling_windows(trades, t0, t0 + day, timedelta(0))

    stats = window_stats(windows, day * 3)
    assert stats is not None
    assert (stats.count, stats.empty, stats.negative) == (5, 0, 2)
    assert stats.trades == (D("1"), D("2"), D("2.6"))
    assert stats.sum_r == (D("-0.5"), D("0"), D("0.3"))
    assert window_stats([], day) is None


def test_numbers_are_written_plainly() -> None:
    from app.live_gate_report import _num, _r

    assert _num(D(10)) == "10" and _num(D("13.84")) == "13.8" and _num(D(0)) == "0"
    assert _r(D("-0.004")) == "0.00" and _r(D("1.005")) == "+1.01" and _r(None) == "—"


def test_versions_and_names() -> None:
    assert resolve_version("1.2.0") == VERSION
    assert resolve_version(VERSION) == VERSION
    with pytest.raises(ValueError, match=r"9\.9\.9"):
        resolve_version("9.9.9")
    assert same_rules(STRATEGIES["trend-ob-retest@1.2.1"], STRATEGIES[VERSION])
    assert not same_rules(STRATEGIES["trend-ob-retest@1.1.0"], STRATEGIES[VERSION])
    assert report_name("trend-ob-retest@1.2.1", datetime(2027, 2, 1, tzinfo=UTC)) == (
        "2027-02-01-live-gate-1.2.1.md"
    )


# --- синтетический бэктест (сценарий в свечах) -------------------------------------------------

PAD = 250
"""Спокойных свечей перед сценарием (история для окна ``evaluate``)."""
LENGTH = 60
T0 = datetime(2026, 8, 1, tzinfo=UTC)
START = T0 + H4 * (PAD + 1)
END = T0 + H4 * (PAD + LENGTH)
COST_R = execution_cost_r(D(100), D(3), DEFAULT_EXECUTION)
NONE, LONG, SHORT = 0, 1, 2
FLAT = (D(100), D("100.5"), D("99.5"), D(100))
SPIKE_UP = (D(100), D(104), D("99.5"), D(100))  # выше стопа шорта (103)
DROP = (D(100), D("100.5"), D(87), D(100))  # ниже всех трёх целей шорта (97, 93.1, 88)


def series(signals: dict[int, int], shapes: dict[int, tuple[Decimal, ...]]) -> list[Candle]:
    out = []
    for n in range(PAD + LENGTH):
        i = n - PAD
        o, h, lo, c = shapes.get(i, FLAT)
        out.append(Candle(T0 + H4 * n, o, h, lo, c, D(10), D(1000), signals.get(i, NONE)))
    return out


SCENARIO = {
    # шорт на 10 берёт три цели на 11; шорт на 20 выбит стопом на 21
    "AAAUSDT": series({10: SHORT, 20: SHORT}, {11: DROP, 21: SPIKE_UP}),
    # лонг на 5 закрыт по времени через 15 свечей; на 12 инструмент занят; шорт на 25 — три цели
    "BBBUSDT": series({5: LONG, 12: SHORT, 25: SHORT}, {26: DROP}),
}
SYMBOLS = ("AAAUSDT", "BBBUSDT", "CCCUSDT")  # у CCCUSDT данных нет
TP3_R = D("0.4") * 1 + D("0.4") * D("2.3") + D("0.2") * 4 - COST_R


def fake_evaluate(
    inp: MarketInputs, moment: datetime, params: StrategyParams
) -> SignalCandidate | NoSignal:
    """Вместо ``evaluate``: решение записано в сигнальной свече (последней во входе)."""
    candle = inp.h4[-1]
    assert candle.close_time(Timeframe.H4) == moment
    if candle.trades == NONE:
        return NoSignal("trigger", "нет ретеста")
    up = candle.trades == LONG
    direction = Direction.UP if up else Direction.DOWN
    sign = 1 if up else -1
    risk = candle.close * D("0.03")
    setup = TradeSetup(
        direction,
        candle.close,
        candle.close - sign * risk / 2,
        candle.close - sign * risk,
        candle.close + sign * risk,
        candle.close + sign * risk * D("2.3"),
        candle.close + sign * risk * 4,
        risk,
        D("2.3"),
        (),
    )
    return SignalCandidate(
        symbol=inp.symbol,
        direction=direction,
        candle_close_time=moment,
        strategy_version=params.version,
        zone=Zone(ZoneKind.OB, direction, candle.high, candle.low, 0, 0, 0, 0),
        zone_kinds=frozenset({ZoneKind.OB}),
        trade=setup,
        score=ScoreBreakdown({}, 70, Grade.B if up else Grade.A),
        filters=FilterSummary(()),
        bias=BiasContext(Bias.SHORT, Trend.DOWN, Trend.DOWN, None, None, None, ()),
        input_hash="",
        facts=(),
        deferred=False,
    )


def load_scenario(symbol: str) -> MarketInputs | None:
    h4 = SCENARIO.get(symbol)
    return None if h4 is None else MarketInputs(symbol=symbol, h4=h4, d1=[], w1=[])


@pytest.fixture
def scenario(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(engine_backtest, "evaluate", fake_evaluate)


def options(**kw: Any) -> GateOptions:
    values: dict[str, Any] = {
        "version": VERSION,
        "symbols": SYMBOLS,
        "symbols_label": "тест",
        "start": START,
        "end": END,
        "now": END,
        "samples": 500,
        "command": "uv run python scripts/live_gate_report.py --version 1.2.0 --to …",
    }
    return GateOptions(**{**values, **kw})


def no_forward(now: datetime = END) -> Forward:
    return Forward(VERSION, False, None, None, "", now, ())


def test_backtest_part_matches_scenario(scenario: None) -> None:
    bt = run_backtests(SYMBOLS, load_scenario, options())
    assert [r.symbol for r in bt.runs] == ["AAAUSDT", "BBBUSDT"]
    assert bt.missing == ("CCCUSDT",)
    by_symbol = {r.symbol: r for r in bt.runs}
    a, b = by_symbol["AAAUSDT"], by_symbol["BBBUSDT"]
    assert [t.result.status for t in a.trades] == [TradeStatus.CLOSED_TP3, TradeStatus.CLOSED_SL]
    assert [t.realized_r for t in a.trades] == [TP3_R, D(-1) - COST_R]
    assert [t.result.status for t in b.trades] == [TradeStatus.CLOSED_TIME, TradeStatus.CLOSED_TP3]
    assert b.trades[0].realized_r == -COST_R
    # лонг на 5 живёт 15 свечей: закрытия 6–20 заняты (сигнал на 12 подавлен), у шорта на 25
    # занята свеча выхода 26; у AAAUSDT — свечи выхода 11 и 21
    assert b.busy == 16 and a.busy == 2
    assert a.first_close == START and a.last_close == END
    assert a.h4 == PAD + LENGTH and a.funding == 0
    # граница данных: свеча, не закрытая к now, в расчёт не попадает
    cut = START + H4 * 15
    early = backtest_symbol(scenario_input("AAAUSDT"), options(end=cut, now=cut))
    assert [t.result.status for t in early.trades] == [TradeStatus.CLOSED_TP3]
    assert early.h4 == PAD + 16


def scenario_input(symbol: str) -> MarketInputs:
    inp = load_scenario(symbol)
    assert inp is not None
    return inp


def test_report_without_forward_is_reproducible(scenario: None, tmp_path: Path) -> None:
    files = []
    for name in ("one", "two"):
        report = Report(options(), no_forward(), run_backtests(SYMBOLS, load_scenario, options()))
        files.append(write_report(render_markdown(report), tmp_path / f"{name}.md").read_bytes())
    assert files[0] == files[1]
    md = files[0].decode()
    for fragment in (
        "# Готовность к live: trend-ob-retest@1.2.0",
        "результаты на прошлых данных",
        "Форвард-сигналов нет — версии `trend-ob-retest@1.2.0` нет в БД",
        "| Все | 4 | 4 | 0 | 50.0 % |",
        "Нет данных или мало истории: CCCUSDT.",
        "| 4 | Форвард не короче 3 месяцев |",
        "**не выполнено**",
        "**нужно решение человека**",
        "## Отличия форварда от бэктеста",
        "Фильтр оборота работает только в форварде и live",
        "Делистинги",
        "Версия выбрана после просмотра результатов",
        "avg_volume_30d",
        "## Как воспроизвести",
    ):
        assert fragment in md, fragment
    # текущей даты в отчёте нет (дата правила одной сделки — постоянная, её не считаем)
    today = f"{datetime.now(tz=UTC):%d.%m.%Y}"
    assert today not in md.replace(f"{ONE_TRADE_RULE_FROM:%d.%m.%Y}", "")
    assert "гарант" not in md.lower()


def test_criteria_statuses(scenario: None) -> None:
    report = Report(options(), no_forward(), run_backtests(SYMBOLS, load_scenario, options()))
    a = analyze(report)
    status = {c.name: c.status for c in a.criteria}
    assert len(a.criteria) == 12
    assert status["Бэктест не короче 3 лет"] is Status.NOT_MET
    assert status["Не меньше 200 сделок"] is Status.NOT_MET
    assert status["Профит-фактор не ниже 1.4"] is Status.MET  # 4.15 / 1.09
    assert status["Форвард не короче 3 месяцев"] is Status.NOT_MET
    assert status["Форвард в пределах доверительного интервала бэктеста"] is Status.NOT_MET
    # у градации C сделок нет — порядок A > B > C проверить нечем
    assert status["Средний R на бэктесте: A > B > C"] is Status.HUMAN
    assert status["Просадка меньше 20 R при риске 1 % на сделку"] is Status.MET
    for name in (
        "Ревью логики сигналов человеком",
        "Ревью 20 примеров на правило",
        "Нет расхождений в ежедневной сверке",
        "Бета на 30 пользователях не меньше 2 недель",
        "Юридические тексты утверждены",
    ):
        assert status[name] is Status.HUMAN, name

    # 4 года, 240 сделок с убывающим средним R по градациям — пункты бэктеста выполнены
    t0 = datetime(2022, 1, 1, tzinfo=UTC)
    trades = []
    for k in range(240):
        grade = GRADE_CYCLE[k % 3]
        r = {Grade.A: "1.5", Grade.B: "0.9", Grade.C: "0.6"}[grade] if k % 2 else "-1"
        trades.append(_trade(t0 + timedelta(days=6 * k), r, grade=grade))
    run = SymbolRun("AAAUSDT", 0, 0, 0, 0, t0, None, 0, 0, tuple(trades))
    end = t0 + timedelta(days=6 * 240)
    good = Report(options(start=t0, end=end, now=end), no_forward(end), Backtest((run,), ()))
    status = {c.name: c.status for c in analyze(good).criteria}
    assert status["Бэктест не короче 3 лет"] is Status.MET
    assert status["Не меньше 200 сделок"] is Status.MET
    assert status["Средний R на бэктесте: A > B > C"] is Status.MET
    swap = {Grade.A: Grade.C, Grade.C: Grade.A}
    flipped = tuple(replace(t, grade=swap.get(t.grade, t.grade)) for t in trades)
    bad = replace(good, backtest=Backtest((replace(run, trades=flipped),), ()))
    status = {c.name: c.status for c in analyze(bad).criteria}
    assert status["Средний R на бэктесте: A > B > C"] is Status.NOT_MET


GRADE_CYCLE = (Grade.A, Grade.B, Grade.C)


@pytest.mark.parametrize(
    ("raw", "expected", "fragment"),
    [
        (None, Status.HUMAN, "итог сверки не передан"),
        ({"bogus": 1}, Status.HUMAN, "не читается"),
        (
            {"at": "2026-10-31T01:05:00+00:00", "failed": "OperationalError"},
            Status.NOT_MET,
            "не выполнена: OperationalError",
        ),
        (
            {"at": "2026-10-20T01:05:00+00:00", "checked": 5, "critical": 0, "warnings": 0},
            Status.HUMAN,
            "старше 36 ч",
        ),
        (
            {"at": "2026-10-31T01:05:00+00:00", "checked": 5, "critical": 0, "warnings": 1},
            Status.NOT_MET,
            "предупреждений 1",
        ),
        (
            {
                "at": "2026-10-31T01:05:00+00:00",
                "checked": 5,
                "critical": 0,
                "warnings": 0,
                "legacy": 2,
                "unchecked": ["AAAUSDT trend-ob-retest@1.2.0 abc: нет ни 1m, ни H4"],
            },
            Status.HUMAN,
            "не удалось сверить 1, результатов до учёта комиссий (не сверяются) 2 (AAAUSDT",
        ),
        (
            {
                "at": "2026-10-31T01:05:00+00:00",
                "since": "2026-10-24T01:05:00+00:00",
                "checked": 13,
                "critical": 0,
                "warnings": 0,
                "explained": 2,
            },
            Status.MET,
            "проверено сигналов 13",
        ),
    ],
)
def test_reconcile_criterion(raw: dict[str, Any] | None, expected: Status, fragment: str) -> None:
    now = datetime(2026, 11, 1, tzinfo=UTC)
    report = Report(
        options(now=now),
        no_forward(now),
        Backtest((), ()),
        parse_reconcile(raw, "файл `reconcile.json`"),
    )
    a = analyze(report)
    (criterion,) = [c for c in a.criteria if c.name == "Нет расхождений в ежедневной сверке"]
    assert criterion.status is expected
    assert fragment in criterion.value
    if raw is not None and raw.get("explained"):
        assert "насчитала 2 отличий записи от эталона H4" in render_markdown(report, a)


def test_options_are_validated() -> None:
    with pytest.raises(ValueError, match="timezone-aware"):
        options(start=datetime(2026, 1, 1))
    with pytest.raises(ValueError, match=r"engine\.strategies"):
        options(version="trend-ob-retest@9.9.9")
    with pytest.raises(ValueError, match="now раньше"):
        options(now=START)
    with pytest.raises(ValueError, match="since позже"):
        options(since=END + H4)
    with pytest.raises(ValueError, match="пуст"):
        options(symbols=())


def row(
    status: str, r: str | None, public_id: str = "pub", at: datetime = START, instrument: int = 1
) -> SignalRow:
    """Записанный форвард-сигнал (шорт от 100) без БД."""
    return SignalRow(
        1,
        public_id,
        "trend-ob-retest",
        "1.2.0",
        1,
        instrument,
        "AAAUSDT",
        "forward",
        "short",
        "A",
        80,
        at,
        D(100),
        None,
        D(103),
        D(97),
        D(94),
        D(88),
        D(2),
        Outcome(status, 0, None if r is None else D(r), None, None, None),
    )


GAP = Completeness(START, START, 0, ())


def fsig(signal: SignalRow, outcome: Outcome | None) -> ForwardSignal:
    """Сигнал с одинаковым пересчётом по 1m и H4; ``None`` — не пересчитан ни так, ни так."""
    return ForwardSignal(
        signal,
        MinuteRetrack(outcome, GAP, (), None if outcome else "нет 1m"),
        H4Retrack(outcome, None, None if outcome else "нет H4"),
    )


def closed_at(t: datetime, r: str = "-1.0434") -> Outcome:
    return Outcome("closed_sl", 0, D(r), D("0.0434"), t, D(4))


def test_forward_trades_keep_open_trades_out_of_sums() -> None:
    done = Outcome("closed_sl", 0, D("-1.0434"), D("0.0434"), START + H4, D(4))
    open_ = Outcome("tp1_hit", 1, None, None, None, None)
    gap = GAP
    signals = [
        ForwardSignal(
            row("closed_sl", "-1.043"), MinuteRetrack(done, gap, (), None), H4Retrack(done, None)
        ),
        ForwardSignal(
            row("tp1_hit", None),
            MinuteRetrack(open_, gap, (), None),
            H4Retrack(None, None, "нет свечи"),
        ),
    ]
    h4 = forward_trades(signals, "h4")
    m1 = forward_trades(signals, "1m")
    assert len(h4) == 1 and h4[0].realized_r == D("-1.043")  # точность signal_results
    assert [t.result.status for t in m1] == [TradeStatus.CLOSED_SL, TradeStatus.OPEN]
    assert m1[0].direction is Direction.DOWN and m1[0].grade is Grade.A


def test_one_trade_rule_over_forward() -> None:
    """Сигнал при открытой сделке более раннего неподавленного сигнала той же версии по тому же
    инструменту подавляется; подавленный инструмент не занимает; другой инструмент не мешает."""
    first = fsig(row("closed_sl", None, "p1"), closed_at(START + H4 * 5 + M1))
    busy = fsig(row("closed_sl", None, "p2", START + H4 * 2), closed_at(START + H4 * 20))
    # закрылась бы p2 позже, но она подавлена; p1 закрылась внутри свечи, что кончается в at
    same_candle = fsig(row("closed_sl", None, "p3", START + H4 * 6), closed_at(START + H4 * 7))
    free = fsig(row("closed_sl", None, "p4", START + H4 * 9), closed_at(START + H4 * 10))
    other = fsig(row("closed_sl", None, "p5", START + H4 * 2, instrument=2), None)
    after_unknown = fsig(row("closed_sl", None, "p6", START + H4 * 3, instrument=2), None)
    out = apply_one_trade_rule([free, other, first, busy, same_candle, after_unknown])
    by_id = {s.signal.public_id: s for s in out}
    assert [s.signal.public_id for s in out] == ["p4", "p5", "p1", "p2", "p3", "p6"]
    assert by_id["p2"].blocked_by == "p1" and not by_id["p2"].counted
    assert by_id["p3"].blocked_by == "p1"
    assert by_id["p4"].blocked_by is None and by_id["p4"].overlap_unknown is None
    assert by_id["p5"].counted
    # сделку p5 пересчитать не удалось: занят ли инструмент для p6, неизвестно — p6 считается
    assert by_id["p6"].counted and by_id["p6"].overlap_unknown == "p5"
    trades = forward_trades(out, "h4")
    assert [t.signal_time for t in trades] == [START + H4 * 9, START]


def _forward(
    *,
    since: datetime | None,
    now: datetime,
    data_end: datetime | None,
    entered: datetime | None = None,
    note: str = "создание версии в статусе forward",
    signals: tuple[ForwardSignal, ...] = (),
) -> Forward:
    return Forward(
        VERSION,
        True,
        "forward",
        since,
        "--since",
        now,
        signals,
        entered=entered,
        entered_note=note,
        data_end=data_end,
    )


def _criterion(forward: Forward, name: str, now: datetime | None = None) -> Any:
    report = Report(options(now=now or forward.now), forward, Backtest((), ()))
    (found,) = [c for c in analyze(report).criteria if c.name == name]
    return found


LENGTH_CRITERION = "Форвард не короче 3 месяцев"


def test_forward_length_ends_at_data_boundary() -> None:
    since = datetime(2026, 11, 1, tzinfo=UTC)
    now = since + timedelta(days=100)
    full = _forward(since=since, now=now, data_end=now, entered=since)
    c = _criterion(full, LENGTH_CRITERION)
    assert c.status is Status.MET and c.value == "01.11.2026 — 09.02.2027, 100 дн."
    # данные H4 кончаются через 30 дней: форвард — 30 дней, а не 100
    stale = _forward(since=since, now=now, data_end=since + timedelta(days=30), entered=since)
    assert stale.period == timedelta(days=30) and stale.stale
    c = _criterion(stale, LENGTH_CRITERION)
    assert c.status is Status.NOT_MET
    assert "30 дн.; данные H4 только до 01.12.2026 00:00 UTC — раньше момента отчёта" in c.value
    md = render_markdown(Report(options(now=now), stale, Backtest((), ())))
    assert "до 01.12.2026 00:00 UTC — **раньше момента отчёта**" in md
    # момент отчёта внутри свечи H4: граница — последнее закрытие, это не обрыв данных
    inside = _forward(since=since, now=now + H4 / 2, data_end=now, entered=since)
    assert not inside.stale
    nothing = _forward(since=since, now=now, data_end=None, entered=since)
    assert _criterion(nothing, LENGTH_CRITERION).status is Status.NOT_MET
    assert "закрытых свечей H4" in _criterion(nothing, LENGTH_CRITERION).value


def test_forward_length_needs_forward_status() -> None:
    since = datetime(2026, 11, 1, tzinfo=UTC)
    now = since + timedelta(days=100)
    never = _forward(
        since=None,
        now=now,
        data_end=now,
        note="версия в форвард не переходила (статус в БД — backtest)",
    )
    c = _criterion(never, LENGTH_CRITERION)
    assert c.status is Status.NOT_MET and "не переходила" in c.value
    md = render_markdown(Report(options(now=now), never, Backtest((), ())))
    assert "Форвард-сигналов нет — версия в форвард не переходила" in md
    assert "| Форвард | не начинался: версия в форвард не переходила" in md
    # начало задано --since, перехода в журнале нет и сигналов нет — не выполнено
    forced = replace(never, since=since)
    assert _criterion(forced, LENGTH_CRITERION).status is Status.NOT_MET
    # а если форвард-сигналы есть — решать человеку
    signal = fsig(row("closed_sl", None, "p1", since + H4), closed_at(since + H4 * 3))
    assert _criterion(replace(forced, signals=(signal,)), LENGTH_CRITERION).status is Status.HUMAN


def test_cancelled_signal_is_zero_r_in_1m() -> None:
    since = datetime(2026, 11, 1, tzinfo=UTC)
    now = since + timedelta(days=10)
    cancelled = fsig(row("cancelled", None, "p1", since + H4), closed_at(since + H4 * 3, "2.5"))
    assert cancelled.cancelled
    (m1,) = forward_trades([cancelled], "1m")
    (h4,) = forward_trades([cancelled], "h4")
    assert (m1.result.status, m1.realized_r) == (TradeStatus.CLOSED_TIME, D(0))
    assert h4.realized_r == D("2.5")  # справочно: без отмены
    fwd = _forward(since=since, now=now, data_end=now, entered=since, signals=(cancelled,))
    report = Report(options(now=now), fwd, _backtest_with([_trade(START, "1.0")], "AAAUSDT"))
    a = analyze(report)
    (c,) = [c for c in a.criteria if c.name.startswith("Форвард в пределах")]
    assert c.status is Status.HUMAN and "отменено вручную: 1" in c.value
    md = render_markdown(report, a)
    assert "отменён вручную: в 1m — 0 R, H4 — справочно" in md


# --- на БД: раздел «Форвард» -------------------------------------------------------------------


def _db_available() -> bool:
    try:
        with engine.connect() as conn:
            conn.execute(text("select published, scope from signals limit 0"))
        return True
    except (OperationalError, DBAPIError):
        return False


db_only = pytest.mark.skipif(not _db_available(), reason="БД с миграциями недоступна")

F0 = datetime(2026, 10, 26, 8, tzinfo=UTC)
"""Закрытие сигнальной свечи первого форвард-сигнала."""
FNOW = F0 + timedelta(days=4)
ENTRY = D(100)
F_COST = execution_cost_r(ENTRY, D(5), DEFAULT_EXECUTION)
"""(2 × 0.05 % + 0.03 %) × 100 / 5 = 0.026 R."""

Ohlc = tuple[Decimal, Decimal, Decimal, Decimal]
Path1m = Callable[[int], Ohlc]


def _flat(i: int) -> Ohlc:
    return D(100), D(100), D(100), D(100)


def _stop_long_at_300(i: int) -> Ohlc:
    return (D(100), D(100), D(100), D(100)) if i < 300 else (D(100), D(100), D(94), D(94))


def _short_three_targets(i: int) -> Ohlc:
    """Падение без отката к входу: TP1 (95) на 100-й минуте, TP2 (90) на 200-й, TP3 (80) на
    400-й."""
    p = D("99") if i < 100 else D("94") if i < 200 else D("89") if i < 400 else D("79")
    return p, p, p, p


def _long_three_targets(i: int) -> Ohlc:
    p = D("101") if i < 100 else D("106") if i < 200 else D("111") if i < 400 else D("121")
    return p, p, p, p


def _minutes(start: datetime, n: int, path: Path1m) -> list[Candle]:
    out = []
    for i in range(n):
        o, h, lo, c = path(i)
        out.append(Candle(start + M1 * i, o, h, lo, c, D(1), D(100), 1))
    return out


def _h4_from(minutes: list[Candle]) -> list[Candle]:
    out = []
    for k in range(0, len(minutes) - 239, 240):
        chunk = minutes[k : k + 240]
        out.append(
            Candle(
                chunk[0].open_time,
                chunk[0].open,
                max(c.high for c in chunk),
                min(c.low for c in chunk),
                chunk[-1].close,
                D(240),
                D(24000),
                240,
            )
        )
    return out


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


def _instrument(db: Session, name: str) -> Instrument:
    tag = secrets.token_hex(3).upper()
    inst = Instrument(
        exchange="binance",
        symbol=f"LG{name}{tag}USDT",
        base=f"LG{name}{tag}",
        quote="USDT",
        market_type="futures",
        tick_size=D("0.01"),
        lot_size=D("0.001"),
    )
    db.add(inst)
    db.flush()
    return inst


CREATED = F0 - timedelta(days=1)
"""Когда создана строка тестовой версии."""


def _version(
    db: Session, status: str = "forward", created_at: datetime = CREATED
) -> tuple[StrategyVersion, str]:
    """Версия 1.2.0 своей тестовой стратегии: боевые строки не затрагиваются."""
    strat = Strategy(slug=f"live-gate-{secrets.token_hex(3)}", name="live gate test")
    db.add(strat)
    db.flush()
    ver = StrategyVersion(
        strategy_id=strat.id, version="1.2.0", params={}, status=status, created_at=created_at
    )
    db.add(ver)
    db.flush()
    return ver, f"{strat.slug}@1.2.0"


def _status_change(
    db: Session, ver: StrategyVersion, from_status: str, to_status: str, at: datetime
) -> None:
    """Применённая заявка на смену статуса, как после ``decide_status_request``."""
    user = User(email=f"live-gate-{secrets.token_hex(4)}@example.com", role="admin")
    db.add(user)
    db.flush()
    db.add(
        StatusChangeRequest(
            strategy_version_id=ver.id,
            from_status=from_status,
            to_status=to_status,
            reason="тест",
            requested_by=user.id,
            decided_by=user.id,
            decision="applied",
            decided_at=at,
        )
    )
    ver.status = to_status
    db.flush()


def _store(db: Session, inst: Instrument, tf: str, candles: list[Candle]) -> None:
    db.execute(
        insert(CandleRow),
        [
            {
                "instrument_id": inst.id,
                "timeframe": tf,
                "open_time": c.open_time,
                "open": c.open,
                "high": c.high,
                "low": c.low,
                "close": c.close,
                "volume": c.volume,
                "quote_volume": c.quote_volume,
                "trades": c.trades,
                "is_closed": True,
            }
            for c in candles
        ],
    )
    db.commit()


def _market(db: Session, inst: Instrument, start: datetime, hours: int, path: Path1m) -> None:
    minutes = _minutes(start, hours * 60, path)
    _store(db, inst, "1m", minutes)
    _store(db, inst, "4h", _h4_from(minutes))


def _publish(
    db: Session,
    ver: StrategyVersion,
    inst: Instrument,
    at: datetime,
    direction: Direction = Direction.UP,
    grade: str = "A",
    publishable: bool = True,
) -> Signal:
    up = direction is Direction.UP
    sign = 1 if up else -1
    cand = SimpleNamespace(
        candle_close_time=at,
        direction=direction,
        trade=SimpleNamespace(
            entry_market=ENTRY,
            entry_limit=None,
            stop_loss=ENTRY - sign * 5,
            tp1=ENTRY + sign * 5,
            tp2=ENTRY + sign * 10,
            tp3=ENTRY + sign * 20,
            rr_tp2=D(2),
        ),
        score=SimpleNamespace(
            total=80,
            grade=SimpleNamespace(value=grade),
            publishable=publishable,
            components={"trend": 30},
        ),
        facts=("тест",),
        deferred=False,
        zone=SimpleNamespace(kind="ob", top=D(101), bottom=D(99)),
        filters=SimpleNamespace(flags=[]),
        input_hash="h" * 64,
    )
    assert write_candidate(db, ver, inst, cand)  # type: ignore[arg-type]
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


@pytest.fixture
def forward_fixture(db: Session) -> SimpleNamespace:
    """Три форвард-сигнала по инструментам списка: лонг A с time stop, лонг B со стопом, шорт C
    с тремя целями. Мимо отчёта: сигнал по инструменту вне списка, кандидат ниже порога
    публикации (не опубликован) и live-сигнал другой версии."""
    ver, label = _version(db)
    a, b, c, other = (_instrument(db, n) for n in ("A", "B", "C", "X"))
    _market(db, a, F0, 96, _flat)  # до момента отчёта: граница данных = FNOW
    _market(db, b, F0 + H4, 12, _stop_long_at_300)
    _market(db, c, F0 + H4 * 2, 12, _short_three_targets)
    _market(db, other, F0, 12, _long_three_targets)
    sig_a = _publish(db, ver, a, F0, grade="A")
    sig_b = _publish(db, ver, b, F0 + H4, grade="B")
    sig_c = _publish(db, ver, c, F0 + H4 * 2, Direction.DOWN, grade="C")
    sig_other = _publish(db, ver, other, F0)
    hidden = _publish(db, ver, b, F0 + H4 * 5, publishable=False)
    live_ver, _ = _version(db, status="live")
    live = _publish(db, live_ver, a, F0)
    return SimpleNamespace(
        label=label,
        symbols=(a.symbol, b.symbol, c.symbol),
        a=sig_a,
        b=sig_b,
        c=sig_c,
        other=sig_other,
        other_symbol=other.symbol,
        hidden=hidden,
        live=live,
    )


def _backtest_with(trades: list[BacktestTrade], symbol: str) -> Backtest:
    run = SymbolRun(symbol, 0, 0, 0, 0, None, None, 0, 0, tuple(trades))
    return Backtest((run,), ())


def _db_report(fx: SimpleNamespace, forward: Forward) -> Report:
    start = datetime(2025, 1, 1, tzinfo=UTC)
    trades = [
        _trade(start + timedelta(days=3 * k), r, grade=GRADE_CYCLE[k % 3])
        for k, r in enumerate(["-1.03", "0.40", "2.00"] * 30)
    ]
    opts = GateOptions(
        version=VERSION,
        symbols=fx.symbols,
        symbols_label="тест",
        start=start,
        end=F0 - H4,
        now=FNOW,
        since=F0 - H4,
        samples=1000,
    )
    return Report(opts, forward, _backtest_with(trades, fx.symbols[0]))


@db_only
def test_forward_section_numbers(db: Session, forward_fixture: SimpleNamespace) -> None:
    fx = forward_fixture
    with read_only_connection(db.connection()) as conn:
        fwd = build_forward(conn, fx.label, fx.symbols, FNOW, since=F0 - H4)
    assert fwd.in_db and fwd.status == "forward" and fwd.since_source == "--since"
    assert fwd.period == timedelta(days=4, hours=4)
    # только опубликованные форвард-сигналы версии по инструментам списка
    assert [s.signal.public_id for s in fwd.signals] == [
        fx.a.public_id,
        fx.b.public_id,
        fx.c.public_id,
    ]
    assert (fwd.outside_count, fwd.outside) == (1, (fx.other_symbol,))

    a, b, c = fwd.signals
    for s, status, r in (
        (a, "closed_time", -F_COST),
        (b, "closed_sl", D(-1) - F_COST),
        (c, "closed_tp3", D("0.4") + D("0.8") + D("0.8") - F_COST),
    ):
        assert s.m1 is not None and s.ref is not None
        assert (s.m1.status, s.m1.realized_r) == (status, r)
        assert (s.ref.status, s.ref.realized_r) == (status, r)
    assert a.m1 is not None and a.m1.closed_at == F0 + timedelta(hours=60)
    assert b.m1 is not None and b.m1.closed_at == F0 + H4 + M1 * 301  # 1m: в ту же минуту
    assert b.ref is not None and b.ref.closed_at == F0 + H4 * 3  # H4: закрытием свечи

    report = _db_report(fx, fwd)
    analysis = analyze(report)
    h4, m1 = analysis.forward_h4, analysis.forward_m1
    assert (h4.closed, m1.closed) == (3, 3)
    assert h4.sum_r == D("0.922") and h4.max_drawdown_r == D("1.052")
    assert h4.profit_factor == D("1.974") / D("1.052")
    assert analysis.forward_closed_r == (-F_COST, D(-1) - F_COST, D("1.974"))
    assert analysis.forward_interval is not None and analysis.forward_interval.size == 3
    status = {c.name: c.status for c in analysis.criteria}
    assert status["Форвард в пределах доверительного интервала бэктеста"] is Status.MET
    assert status["Форвард не короче 3 месяцев"] is Status.NOT_MET
    assert analysis.forward_windows is not None
    assert analysis.forward_windows.length == timedelta(days=4, hours=4)
    assert {w.length for w in analysis.windows} == {THREE_MONTHS, timedelta(days=4, hours=4)}

    md = render_markdown(report, analysis)
    for fragment in (
        "| 1m-трекер | 0 | 3 | 3 | 0 | 33.3 % | +0.31 | 1.88 | +0.92 | 1.05 |",
        "| H4-эталон | 0 | 3 | 3 | 0 | 33.3 % | +0.31 | 1.88 | +0.92 | 1.05 |",
        "| Шорт, H4 | 1 | 1 | 0 | 100.0 % | +1.97 | нет убыточных | +1.97 | 0.00 |",
        "| Лонг, H4 | 2 | 2 | 0 | 0.0 % | -0.53 | 0.00 | -1.05 | 1.05 |",
        "| Градация A, 1m | 1 | 1 | 0 | 0.0 % | -0.03 | 0.00 | -0.03 | 0.03 |",
        "| Градация C, H4 | 1 | 1 | 0 | 100.0 % | +1.97 | нет убыточных | +1.97 | 0.00 |",
        f"| `{fx.a.public_id}` | {fx.symbols[0]} | 26.10.2026 08:00 | лонг | A | ожидает входа "
        "| по времени -0.026 | по времени -0.026 |",
        f"| `{fx.c.public_id}` | {fx.symbols[2]} | 26.10.2026 16:00 | шорт | C | ожидает входа "
        "| TP3 +1.974 | TP3 +1.974 |",
        "Статус по 1m и по H4 совпал у 3 из 3",
        f"Сигналов версии по инструментам вне списка: 1 ({fx.other_symbol})",
        "Период: 26.10.2026 04:00 — 30.10.2026 08:00 UTC (4.2 дн.)",
        "Место форварда среди окон той же длины (4.2 дн.): по числу сигналов (3)",
        "Средний R форварда по H4-пересчёту: +0.31, закрытых сделок 3.",
    ):
        assert fragment in md, fragment
    for absent in (fx.live.public_id, fx.hidden.public_id, fx.other.public_id):
        assert absent not in md
    # тот же вход — тот же текст
    with read_only_connection(db.connection()) as conn:
        again = build_forward(conn, fx.label, fx.symbols, FNOW, since=F0 - H4)
    assert render_markdown(_db_report(fx, again)) == md


@db_only
def test_forward_start_follows_status_history(
    db: Session, forward_fixture: SimpleNamespace
) -> None:
    fx = forward_fixture
    with read_only_connection(db.connection()) as conn:
        # версия создана сразу в форварде (как до задачи 4): начало — создание строки
        fwd = build_forward(conn, fx.label, fx.symbols, FNOW)
        assert (fwd.since, fwd.entered) == (CREATED, CREATED)
        assert fwd.since_source == "создание версии в статусе forward"
        assert fwd.data_end == FNOW and not fwd.stale
        assert len(fwd.signals) == 3
        # --since раньше перехода начало не уводит
        early = build_forward(conn, fx.label, fx.symbols, FNOW, since=CREATED - timedelta(days=9))
        assert early.since == CREATED and early.since_source.endswith("--since раньше перехода")
        absent = build_forward(conn, "trend-ob-retest@9.9.9", fx.symbols, FNOW)
        assert not absent.in_db and absent.signals == ()
        # к моменту отчёта версии ещё не было
        before = build_forward(conn, fx.label, fx.symbols, CREATED - H4)
        assert before.since is None and before.signals == ()
        assert "позже момента отчёта" in before.entered_note
        # версия есть, сигналов в окне нет; граница данных — не позже момента отчёта
        empty = build_forward(conn, fx.label, fx.symbols, F0 - H4, since=F0 - H4 * 2)
        assert empty.in_db and empty.signals == () and empty.data_end is None
    md = render_markdown(_db_report(fx, empty))
    assert "не опубликовала ни одного сигнала по инструментам списка" in md


@db_only
def test_forward_start_of_version_created_in_backtest(db: Session) -> None:
    """С задачи 4 версия создаётся в статусе backtest: форвард начинается с решения по заявке на
    переход в форвард, а не с создания строки."""
    ver, label = _version(db, status="backtest", created_at=F0 - timedelta(days=30))
    inst = _instrument(db, "S")
    _market(db, inst, F0, 8, _flat)
    symbols = (inst.symbol,)
    with read_only_connection(db.connection()) as conn:
        fwd = build_forward(conn, label, symbols, FNOW)
    assert fwd.since is None and fwd.entered is None and fwd.signals == ()
    assert fwd.entered_note == "версия в форвард не переходила (статус в БД — backtest)"
    # граница данных — последнее закрытие H4 инструмента, а не момент отчёта
    assert fwd.data_end == F0 + H4 * 2 and fwd.stale
    report = Report(options(now=FNOW), fwd, Backtest((), ()))
    (length,) = [c for c in analyze(report).criteria if c.name == LENGTH_CRITERION]
    assert length.status is Status.NOT_MET and "не переходила" in length.value

    _status_change(db, ver, "backtest", "forward", F0 - H4)
    with read_only_connection(db.connection()) as conn:
        fwd = build_forward(conn, label, symbols, FNOW)
        assert (fwd.since, fwd.entered) == (F0 - H4, F0 - H4)
        assert fwd.since_source == "решение по заявке на переход в форвард"
        assert fwd.period == F0 + H4 * 2 - (F0 - H4)  # до границы данных
        # момент отчёта раньше перехода — форварда ещё не было
        early = build_forward(conn, label, symbols, F0 - H4 * 2)
        assert early.since is None and "позже момента отчёта" in early.entered_note
    # переход в live после форварда начало не сдвигает
    _status_change(db, ver, "forward", "live", F0 + H4)
    with read_only_connection(db.connection()) as conn:
        assert build_forward(conn, label, symbols, FNOW).since == F0 - H4


@db_only
def test_forward_signals_before_one_trade_rule(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Сигнал, записанный при открытой сделке до задачи 6, в метрики форварда не входит;
    отменённый вручную — 0 R по 1m."""
    import app.forward as forward_module

    ver, label = _version(db)
    inst = _instrument(db, "R")
    _market(db, inst, F0, 96, _flat)
    first = _publish(db, ver, inst, F0)
    # запись кандидата без правила одной сделки — как до задачи 6
    monkeypatch.setattr(forward_module, "open_trade_blocker", lambda *a, **k: None)
    busy = _publish(db, ver, inst, F0 + H4 * 2)
    # сделка first закрывается по времени в F0 + 60 ч; busy подавлен и инструмент не занимает
    late = _publish(db, ver, inst, F0 + timedelta(hours=64))
    db.execute(update(Signal).where(Signal.id == late.id).values(status="cancelled"))
    db.commit()
    with read_only_connection(db.connection()) as conn:
        fwd = build_forward(conn, label, (inst.symbol,), FNOW)
    by_id = {s.signal.public_id: s for s in fwd.signals}
    assert by_id[busy.public_id].blocked_by == first.public_id
    assert by_id[first.public_id].counted and by_id[late.public_id].counted
    assert [s.signal.public_id for s in fwd.blocked] == [busy.public_id]
    report = Report(options(now=FNOW), fwd, Backtest((), ()))
    a = analyze(report)
    assert (a.forward_h4.signals, a.forward_h4.closed) == (2, 1)  # late открыт по H4
    assert (a.forward_m1.signals, a.forward_m1.closed) == (2, 2)  # late отменён: 0 R
    assert a.forward_m1.sum_r == -F_COST
    md = render_markdown(report, a)
    assert "из них 1 подавило бы правило одной открытой сделки" in md
    assert f"инструмент занят сделкой `{first.public_id}` — в метрики не входит" in md
    assert "(в этом форварде — 1)" in md


@db_only
def test_cli_writes_identical_files(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    import live_gate_report as cli

    reconcile = tmp_path / "reconcile.json"
    reconcile.write_text(
        json.dumps({"at": "2026-10-31T01:05:00+00:00", "checked": 0, "critical": 0, "warnings": 0})
    )
    args = ["--version", "1.2.1", "--from", "2026-06-01", "--to", "2026-10-26"]
    args += ["--now", "2026-11-01", "--bootstrap", "200", "--reconcile-json", str(reconcile)]
    paths = [tmp_path / "one.md", tmp_path / "two.md"]
    for path in paths:
        assert cli.main([*args, "--out", str(path)]) == 0
    assert paths[0].read_bytes() == paths[1].read_bytes()
    md = paths[0].read_text()
    assert "список версии, 20: BTCUSDT" in md
    assert "Правила версии | те же, что у `trend-ob-retest@1.2.0`" in md
    assert "файл `reconcile.json`" in md
    assert "--reconcile-json reconcile.json" in md
    assert "форвард-сигналов: 0" in capsys.readouterr().out
    assert cli.main(["--version", "9.9.9", "--to", "2026-10-26"]) == 2
    assert "9.9.9" in capsys.readouterr().err


@db_only
def test_cli_symbol_lists(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    import live_gate_report as cli

    base = ["--from", "2026-09-01", "--to", "2026-10-26", "--bootstrap", "50"]
    out = tmp_path / "mvp.md"
    assert cli.main(["--version", "1.2.0", "--symbols", "mvp20", *base, "--out", str(out)]) == 0
    assert "mvp20 (`scripts/instruments_mvp.txt`), 20: BTCUSDT" in out.read_text()
    # у версии со своим списком из файла остаётся только то, что есть в её списке
    listed = tmp_path / "pairs.txt"
    listed.write_text("# пары\nBTCUSDT\nXLMUSDT\n")
    out = tmp_path / "file.md"
    args = ["--version", "1.2.1", "--symbols", str(listed), *base, "--out", str(out)]
    assert cli.main(args) == 0
    md = out.read_text()
    assert "файл `pairs.txt`, 1: BTCUSDT" in md and "Вне списка версии, отброшены | XLMUSDT" in md
    assert "пропущены: XLMUSDT" in capsys.readouterr().err
