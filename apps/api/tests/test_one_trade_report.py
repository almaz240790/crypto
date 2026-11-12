"""Отчёт для владельца о правиле «одна открытая сделка на инструмент и версию» (задача 6 пакета
«Сигналы», требование 6).

Данные синтетические, сети нет. Вместо ``evaluate`` — сценарий, записанный в самих свечах (код
сигнала лежит в поле ``trades`` сигнальной свечи), поэтому число сделок, занятых свечей и
подавленных сигналов известно заранее и проверяется точно: по причине, направлению и инструменту.
Проверяются выбор примеров (детерминированный и разнесённый), текст абзаца одного примера,
отсутствие «утечки будущего» и запуск скрипта: на CSV-выгрузках без БД и, если есть БД с
миграциями (``DATABASE_URL``), на БД — с теми же файлами байт в байт. Тест на БД записывает свои
инструменты и свечи отдельной транзакцией и удаляет их в конце.
"""

from __future__ import annotations

import csv
import io
import pickle
import random
import secrets
import sys
from collections.abc import Iterator
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from itertools import pairwise
from pathlib import Path

import pytest
from sqlalchemy import delete, insert, text
from sqlalchemy.exc import DBAPIError, OperationalError
from sqlalchemy.orm import Session

import engine.backtest as engine_backtest
from app.db import engine as db_engine
from app.models import Candle as CandleRow
from app.models import Instrument
from app.one_trade_report import (
    CHART_DIR,
    REPORT_CSV,
    REPORT_MD,
    TRADES_CSV,
    Example,
    Reason,
    Report,
    ReportOptions,
    Suppressed,
    SymbolReport,
    analyze,
    analyze_all,
    bounded,
    build_report,
    busy_reason,
    chart_title,
    count_by,
    example_paragraph,
    render_chart,
    render_csv,
    render_markdown,
    render_trades_csv,
    select_examples,
    write_report,
)
from engine.backtest import (
    DEFAULT_EXECUTION,
    BacktestTrade,
    TradeResult,
    TradeStatus,
    execution_cost_r,
    run_backtest,
    summarize,
)
from engine.bias import Bias, BiasContext
from engine.candles import Candle, Timeframe
from engine.filters import FilterSummary
from engine.params import StrategyParams
from engine.scoring import Grade, ScoreBreakdown
from engine.signal import MarketInputs, NoSignal, SignalCandidate
from engine.structure import Direction, Trend
from engine.trade import TradeSetup
from engine.zones import Zone, ZoneKind

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts"))

D = Decimal
H4 = Timeframe.H4.delta
VERSION = "trend-ob-retest@1.0.0"
PAD = 250
"""Спокойных свечей перед сценарием: загрузчик бэктеста не берёт инструмент с историей короче
``StrategyParams.min_h4_history``."""
LENGTH = 60
"""Свечей сценария; их закрытия и составляют период отчёта."""
T0 = datetime(2026, 8, 1, tzinfo=UTC)
"""Открытие первой свечи ряда."""
START = T0 + H4 * (PAD + 1)
"""Начало периода — закрытие первой свечи сценария."""
END = T0 + H4 * (PAD + LENGTH)
"""Конец периода и граница данных — закрытие последней свечи сценария."""
COST_R = execution_cost_r(D(100), D(3), DEFAULT_EXECUTION)
"""Комиссия и проскальзывание сделки сценария в R: (2 × 0.05 % + 0.03 %) × 100 / 3."""

NONE, LONG, SHORT, BELOW_THRESHOLD, DEFERRED = 0, 1, 2, 3, 4
"""Коды сценария в поле ``trades`` сигнальной свечи: нет сигнала; сигнал в лонг (градация B);
сигнал в шорт (градация A); кандидат ниже порога публикации; отложенный кандидат."""

FLAT = (D(100), D("100.5"), D("99.5"), D(100))
SPIKE_UP = (D(100), D(104), D("99.5"), D(100))  # выше стопа шорта (103) и первой цели лонга
DROP = (D(100), D("100.5"), D(87), D(100))  # ниже всех трёх целей шорта (97, 93.1, 88)


def at(i: int) -> datetime:
    """Закрытие свечи сценария с номером ``i`` (0 — первая свеча периода)."""
    return T0 + H4 * (PAD + i + 1)


def series(
    signals: dict[int, int], shapes: dict[int, tuple[Decimal, Decimal, Decimal, Decimal]]
) -> list[Candle]:
    """Ряд H4: ``PAD`` спокойных свечей и ``LENGTH`` свечей сценария. ``signals`` — код сигнала
    на закрытии свечи сценария, ``shapes`` — её OHLC (по умолчанию цена стоит у 100)."""
    out = []
    for n in range(PAD + LENGTH):
        i = n - PAD
        o, h, lo, c = shapes.get(i, FLAT)
        out.append(Candle(T0 + H4 * n, o, h, lo, c, D(10), D(1000), signals.get(i, NONE)))
    return out


SCENARIO: dict[str, list[Candle]] = {
    # лонг на свече 10 закрывается по времени на свече 25 (15 свечей); пока он открыт — сигнал
    # в шорт (14), кандидат ниже порога (18) и отложенный (20); на свече выхода — сигнал в лонг
    # (25). Со свечи 26 инструмент свободен: шорт на 26 выбит стопом на 28, и на той же свече
    # выхода появляется ещё один сигнал в шорт.
    "AAAUSDT": series(
        {10: LONG, 14: SHORT, 18: BELOW_THRESHOLD, 20: DEFERRED, 25: LONG, 26: SHORT, 28: SHORT},
        {28: SPIKE_UP},
    ),
    # шорт на свече 40 берёт все три цели на свече 42; пока он открыт — сигнал в шорт (41).
    # Лонг на 43 закрывается по времени на 58; пока он открыт — сигнал в лонг (50), который сам
    # по себе до конца данных не закрылся бы.
    "BBBUSDT": series({40: SHORT, 41: SHORT, 43: LONG, 50: LONG}, {42: DROP}),
    # лонг на свече 55 к концу данных ещё открыт; пока он открыт — сигнал в шорт (57)
    "CCCUSDT": series({55: LONG, 57: SHORT}, {}),
}
SYMBOLS = [*SCENARIO, "DDDUSDT"]  # у DDDUSDT данных нет


def fake_evaluate(
    inp: MarketInputs, moment: datetime, params: StrategyParams
) -> SignalCandidate | NoSignal:
    """Вместо ``evaluate``: решение записано в сигнальной свече (последней во входе)."""
    candle = inp.h4[-1]
    assert candle.close_time(Timeframe.H4) == moment
    code = candle.trades
    if code == NONE:
        return NoSignal("trigger", "нет ретеста")
    up = code in (LONG, BELOW_THRESHOLD)
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
    grade = Grade.NONE if code == BELOW_THRESHOLD else Grade.B if up else Grade.A
    return SignalCandidate(
        symbol=inp.symbol,
        direction=direction,
        candle_close_time=moment,
        strategy_version=params.version,
        zone=Zone(ZoneKind.OB, direction, candle.high, candle.low, 0, 0, 0, 0),
        zone_kinds=frozenset({ZoneKind.OB}),
        trade=setup,
        score=ScoreBreakdown({}, 70, grade),
        filters=FilterSummary(()),
        bias=BiasContext(Bias.LONG, Trend.UP, Trend.UP, None, None, None, ()),
        input_hash="",
        facts=(),
        deferred=code == DEFERRED,
    )


@pytest.fixture
def scenario(monkeypatch: pytest.MonkeyPatch) -> dict[str, list[Candle]]:
    monkeypatch.setattr(engine_backtest, "evaluate", fake_evaluate)
    return SCENARIO


def options(**kw: object) -> ReportOptions:
    values: dict[str, object] = {"version": VERSION, "start": START, "end": END, "now": END}
    return ReportOptions(**{**values, **kw})  # type: ignore[arg-type]


def load(symbol: str) -> MarketInputs | None:
    candles = SCENARIO.get(symbol)
    return None if candles is None else MarketInputs(symbol=symbol, h4=candles)


def report(**kw: object) -> Report:
    return build_report(SYMBOLS, load, options(**kw))


# --- счёт подавленных сигналов -----------------------------------------------------------------


def test_suppressed_signals_are_counted_by_reason_direction_and_instrument(
    scenario: dict[str, list[Candle]],
) -> None:
    rep = report(charts=False)
    assert [s.symbol for s in rep.symbols] == ["AAAUSDT", "BBBUSDT", "CCCUSDT"]
    assert rep.missing == ("DDDUSDT",)
    by_symbol = {s.symbol: s for s in rep.symbols}
    # сделки и занятые свечи: A — 15 свечей под лонгом и 2 под шортом; B — 2 и 15; C — 4 до конца
    assert {k: (len(v.trades), v.busy, v.evaluated) for k, v in by_symbol.items()} == {
        "AAAUSDT": (2, 17, 43),
        "BBBUSDT": (2, 17, 43),
        "CCCUSDT": (1, 4, 56),
    }
    # подавленные сигналы: только кандидаты, которые стали бы сделкой; ниже порога и отложенный
    # (свечи 18 и 20) сюда не попадают
    assert [(s.symbol, s.at, s.direction, s.reason) for s in rep.suppressed] == [
        ("AAAUSDT", at(14), Direction.DOWN, Reason.OPEN),
        ("AAAUSDT", at(25), Direction.UP, Reason.EXIT_CANDLE),
        ("AAAUSDT", at(28), Direction.DOWN, Reason.EXIT_CANDLE),
        ("BBBUSDT", at(41), Direction.DOWN, Reason.OPEN),
        ("BBBUSDT", at(50), Direction.UP, Reason.OPEN),
        ("CCCUSDT", at(57), Direction.DOWN, Reason.OPEN),
    ]
    assert count_by(rep.suppressed) == {
        (Reason.OPEN, Direction.UP): 1,
        (Reason.OPEN, Direction.DOWN): 3,
        (Reason.EXIT_CANDLE, Direction.UP): 1,
        (Reason.EXIT_CANDLE, Direction.DOWN): 1,
    }
    # мешающая сделка — сделка этого же прогона, открытая раньше сигнала
    blockers = [(s.blocker.signal_time, s.blocker.exit_time) for s in rep.suppressed]
    assert blockers == [
        (at(10), at(25)),
        (at(10), at(25)),
        (at(26), at(28)),
        (at(40), at(42)),
        (at(43), at(58)),
        (at(55), None),
    ]
    md = render_markdown(rep)
    assert "| Сделка ещё открыта | 1 | 3 | 4 |" in md
    assert "| Свеча выхода | 1 | 1 | 2 |" in md
    assert "| Всего | 2 | 4 | 6 |" in md
    assert "| AAAUSDT | 2 | 17 | 3 | 1 | 2 | 1 | 2 |" in md
    assert "| BBBUSDT | 2 | 17 | 2 | 2 | 0 | 1 | 1 |" in md
    assert "| CCCUSDT | 1 | 4 | 1 | 1 | 0 | 0 | 1 |" in md
    assert "- Сделок с правилом (как в бэктесте): 5." in md
    assert "- Закрытий H4, пропущенных правилом (инструмент занят): 38." in md
    assert "- Сигналов, которые правило подавило: 6 — 54.5 % от всех сигналов" in md
    assert "без данных или с короткой историей: 1 (DDDUSDT)" in md


def test_report_does_not_change_the_backtest(scenario: dict[str, list[Candle]]) -> None:
    """Сделки и счётчики отчёта — те же, что у обычного прогона бэктеста по всем инструментам
    сразу; подавленные сигналы вместе со сделками — все публикуемые кандидаты периода."""
    rep = report(charts=False)
    inputs = [MarketInputs(symbol=k, h4=v) for k, v in scenario.items()]
    plain = run_backtest(inputs, StrategyParams(), START, END)
    assert rep.trades == plain.trades
    assert sum(s.busy for s in rep.symbols) == plain.skipped["busy"] == 38
    assert sum(s.evaluated for s in rep.symbols) == plain.evaluated
    publishable = {
        (symbol, c.close_time(Timeframe.H4))
        for symbol, candles in scenario.items()
        for c in candles
        if c.trades in (LONG, SHORT)
    }
    taken = {(t.symbol, t.signal_time) for t in rep.trades}
    hidden = {(s.symbol, s.at) for s in rep.suppressed}
    assert taken | hidden == publishable and not taken & hidden


def test_hypothetical_outcome_of_each_suppressed_signal(scenario: dict[str, list[Candle]]) -> None:
    """«Сам по себе» — тот же ``simulate_trade`` с комиссиями по свечам после сигнала."""
    rep = report(charts=False)
    outcomes = {
        (s.symbol, s.at): (s.outcome.status, s.outcome.tp_hits, s.outcome_exit)
        for s in rep.suppressed
    }
    assert outcomes == {
        ("AAAUSDT", at(14)): (TradeStatus.CLOSED_SL, 0, at(28)),  # выбит всплеском на свече 28
        ("AAAUSDT", at(25)): (TradeStatus.CLOSED_BE, 1, at(29)),  # первая цель на 28, затем ноль
        ("AAAUSDT", at(28)): (TradeStatus.CLOSED_TIME, 0, at(43)),
        ("BBBUSDT", at(41)): (TradeStatus.CLOSED_TP3, 3, at(42)),
        ("BBBUSDT", at(50)): (TradeStatus.OPEN, 0, None),  # 15 свечей до конца данных не набралось
        ("CCCUSDT", at(57)): (TradeStatus.OPEN, 0, None),
    }
    r = {(s.symbol, s.at): s.outcome.realized_r for s in rep.suppressed}
    assert r[("AAAUSDT", at(14))] == -1 - COST_R
    assert r[("AAAUSDT", at(25))] == D("0.4") - COST_R
    assert r[("AAAUSDT", at(28))] == -COST_R
    assert r[("BBBUSDT", at(41))] == D("0.4") + D("0.4") * D("2.3") + D("0.2") * 4 - COST_R

    # те же метрики, что у бэктеста: подавленный сигнал представлен сделкой ``alone``
    with_rule = summarize(rep.trades)
    alone = summarize([s.alone for s in rep.suppressed])
    assert [s.alone.result for s in rep.suppressed] == [s.outcome for s in rep.suppressed]
    assert [(s.alone.signal_time, s.alone.exit_time) for s in rep.suppressed] == [
        (s.at, s.outcome_exit) for s in rep.suppressed
    ]
    # с правилом: по времени, стоп, три цели, по времени и одна открытая
    assert (with_rule.signals, with_rule.closed, with_rule.open) == (5, 4, 1)
    assert abs(with_rule.sum_r - (D("2.12") - 1 - 4 * COST_R)) < D("1e-20")
    assert (alone.signals, alone.closed, alone.open, alone.winrate) == (6, 4, 2, D("0.5"))
    assert abs(alone.sum_r - (D("2.12") + D("0.4") - 1 - 4 * COST_R)) < D("1e-20")
    md = render_markdown(rep)
    assert "| С правилом (сделки бэктеста) | 5 | 4 | 1 | 25.0 % | +0.95 | +0.24 |" in md
    assert "| Подавленные сигналы, каждый сам по себе | 6 | 4 | 2 | 50.0 % | +1.35 | +0.34 |" in md
    assert "| Гипотетически без правила (обе строки вместе) | 11 | 8 | 3 | 37.5 % | +2.29 |" in md
    assert "не рекомендация" in md and "результаты на прошлых данных" in md
    assert (
        "для сверки с сохранённым прогоном: закрытых 4, прибыльных 25.0 %, профит-фактор 1.84, "
        "сумма +0.95 R, наибольшая просадка 1.1 R." in md
    )


def test_busy_reason_follows_the_rule() -> None:
    """Сделка, закрывшаяся позже свечи или не закрывшаяся, — «ещё открыта»; закрывшаяся внутри
    свечи, которая заканчивается в момент сигнала, — «свеча выхода»; закрывшаяся раньше
    инструмент не занимает, и отчёт такую пару не принимает."""
    trade = _trade("AAAUSDT", at(0), at(5))
    assert busy_reason(trade, at(3)) is Reason.OPEN
    assert busy_reason(trade, at(5)) is Reason.EXIT_CANDLE
    assert busy_reason(replace(trade, exit_time=None), at(40)) is Reason.OPEN
    with pytest.raises(ValueError, match="занимать инструмент она не может"):
        busy_reason(trade, at(6))


# --- без утечки будущего -----------------------------------------------------------------------


def test_candles_not_closed_by_now_do_not_reach_the_engine(
    scenario: dict[str, list[Candle]],
) -> None:
    """Свеча, не закрытая к ``now``, в расчёт не попадает: ни как сигнальная, ни в исполнении
    сделок. Ранний ``now`` даёт то же, что ряд, обрезанный по ``now``."""
    candles = scenario["AAAUSDT"]
    unclosed = Candle(END, D(100), D(120), D(80), D(100), D(10), D(1000), LONG)
    inp = MarketInputs(symbol="AAAUSDT", h4=[*candles, unclosed], d1=[], w1=[])
    assert bounded(inp, END).h4 == candles
    assert analyze(inp, options()) == analyze(replace(inp, h4=candles), options())

    # граница данных — закрытие свечи 27: всплеск свечи 28 ещё не случился
    early = options(end=at(27), now=at(27))
    cut = analyze(replace(inp, h4=candles), early)
    assert cut == analyze(replace(inp, h4=candles[: PAD + 28]), early)
    assert [(t.signal_time, t.result.status, t.exit_time) for t in cut.trades] == [
        (at(10), TradeStatus.CLOSED_TIME, at(25)),
        (at(26), TradeStatus.OPEN, None),
    ]
    assert [(s.at, s.outcome.status) for s in cut.suppressed] == [
        (at(14), TradeStatus.OPEN),
        (at(25), TradeStatus.OPEN),
    ]
    assert cut.h4 == PAD + 28 and cut.last_close == at(27)


def test_options_are_validated() -> None:
    with pytest.raises(ValueError, match="timezone-aware"):
        options(start=datetime(2026, 8, 1))
    with pytest.raises(ValueError, match=r"нет в engine\.strategies"):
        options(version="trend-ob-retest@9.9.9")
    with pytest.raises(ValueError, match="раньше начала"):
        options(end=START - H4)
    with pytest.raises(ValueError, match="now раньше конца"):
        options(now=END - H4)
    with pytest.raises(ValueError, match="отрицательным"):
        options(examples=-1)
    assert options().params.version == VERSION


# --- выбор примеров ----------------------------------------------------------------------------


def _trade(symbol: str, opened: datetime, closed: datetime | None) -> BacktestTrade:
    result = TradeResult(
        TradeStatus.CLOSED_TIME if closed else TradeStatus.OPEN,
        D("-0.04"),
        None,
        None,
        0,
        0,
        14 if closed else None,
        D(0),
        D(0),
        D("0.04"),
    )
    return BacktestTrade(
        symbol,
        Direction.UP,
        opened,
        Grade.B,
        70,
        D("2.3"),
        D(100),
        D(97),
        D(103),
        D("106.9"),
        D(112),
        result,
        closed,
    )


def _signal(
    symbol: str,
    day: int,
    reason: Reason = Reason.OPEN,
    direction: Direction = Direction.DOWN,
) -> Suppressed:
    moment = T0 + timedelta(days=day)
    blocker = _trade(symbol, moment - H4 * 2, moment if reason is Reason.EXIT_CANDLE else None)
    setup = TradeSetup(direction, D(100), D(100), D(103), D(97), D(93), D(88), D(3), D("2.3"), ())
    return Suppressed(
        symbol, moment, direction, Grade.A, 80, setup, reason, blocker, blocker.result, None
    )


def test_examples_are_spread_over_instruments_and_time() -> None:
    """Не «первые N»: по примеру с каждого инструмента, а внутри инструмента — из разных частей
    периода."""
    one = [_signal("AAAUSDT", day) for day in range(100)]
    picked = select_examples(one, 5)
    days = [(s.at - T0).days for s in picked]
    assert days == sorted(days) and days[0] == 0 and days[-1] == 99
    assert min(b - a for a, b in pairwise(days)) >= 20
    assert days != list(range(5))

    many = [_signal(f"S{n:02d}USDT", day) for n in range(8) for day in range(n, 100, 10)]
    picked = select_examples(many, 8)
    assert sorted(s.symbol for s in picked) == [f"S{n:02d}USDT" for n in range(8)]
    spread = sorted((s.at - T0).days for s in picked)
    assert spread[-1] - spread[0] >= 80
    # больше примеров, чем инструментов, — добираются поровну
    counts: dict[str, int] = {}
    for s in select_examples(many, 20):
        counts[s.symbol] = counts.get(s.symbol, 0) + 1
    assert sorted(counts.values()) == [2, 2, 2, 2, 3, 3, 3, 3]


def test_examples_are_deterministic_and_cover_rare_cases() -> None:
    """Порядок входа на выбор не влияет; редкая причина («свеча выхода») и редкое направление
    попадают в выборку, даже если они не на краях периода."""
    items = [_signal(f"S{n % 4}USDT", n) for n in range(60)]
    items[30] = _signal("S2USDT", 30, reason=Reason.EXIT_CANDLE)
    items[31] = _signal("S3USDT", 31, reason=Reason.EXIT_CANDLE)
    items[32] = _signal("S0USDT", 32, direction=Direction.UP)
    picked = select_examples(items, 10)
    assert picked == sorted(picked, key=lambda s: s.key) and len({s.key for s in picked}) == 10
    for seed in range(5):
        shuffled = list(items)
        random.Random(seed).shuffle(shuffled)
        assert select_examples(shuffled, 10) == picked
    assert sum(1 for s in picked if s.reason is Reason.EXIT_CANDLE) == 2
    assert sum(1 for s in picked if s.direction is Direction.UP) == 1

    assert select_examples(items, 0) == []
    assert select_examples(items[:3], 20) == items[:3]
    assert select_examples([], 20) == []


def test_examples_of_the_report(scenario: dict[str, list[Candle]]) -> None:
    rep = report(examples=3, charts=False)
    assert [e.number for e in rep.examples] == [1, 2, 3]
    assert sorted(e.signal.symbol for e in rep.examples) == ["AAAUSDT", "BBBUSDT", "CCCUSDT"]
    assert all(e.chart is None and e.chart_file is None for e in rep.examples)
    assert [e.signal.key for e in rep.examples] == sorted(e.signal.key for e in rep.examples)
    everything = report(charts=False)
    assert [e.signal for e in everything.examples] == sorted(
        everything.suppressed, key=lambda s: s.key
    )
    assert "Примеры не запрошены." in render_markdown(report(examples=0, charts=False))


# --- текст и файлы -----------------------------------------------------------------------------


def test_markdown_paragraph_of_one_example(scenario: dict[str, list[Candle]]) -> None:
    """Абзац примера: инструмент; когда открыта первая сделка и чем она кончилась; когда появился
    подавленный сигнал, его направление и градация; что стало бы с ним самим — с пометкой, что
    это гипотетический результат на прошлых данных."""
    rep = report()
    by_key = {(e.signal.symbol, e.signal.at): e for e in rep.examples}
    exit_candle = by_key[("AAAUSDT", at(25))]
    assert example_paragraph(exit_candle, END) == (
        "**Пример 2. AAAUSDT.** Сделка A — лонг (на рост), градация B — открыта по сигналу "
        "13.09.2026 12:00 UTC и закрылась 16.09.2026 00:00 UTC по времени, через 60 ч, с "
        "результатом -0.04 R. На закрытии той же четырёхчасовой свечи, внутри которой сделка A "
        "закрылась, 16.09.2026 00:00 UTC, появился сигнал B — лонг (на рост), градация B. "
        "Правило его не пропустило: свеча, на которой сделка закрылась, тоже считается занятой — "
        "так же считает бэктест. Сам по себе сигнал B, если бы его исполнили отдельной сделкой "
        "(гипотетически, результат на прошлых данных), закрылся бы 16.09.2026 16:00 UTC в "
        "безубыток после первой цели с результатом +0.36 R. График: "
        "`examples/02-AAAUSDT-20260916T0000.png`."
    )
    still_open = example_paragraph(by_key[("AAAUSDT", at(14))], END)
    assert (
        "Пока она была открыта, 14.09.2026 04:00 UTC появился сигнал B — шорт (на снижение), "
        in (still_open)
    )
    assert "градация A. Правило его не пропустило: по инструменту уже была открыта сделка" in (
        still_open
    )
    assert "закрылся бы 16.09.2026 12:00 UTC по стопу с результатом -1.04 R." in still_open
    # сделка, не закрытая к концу данных, и сигнал, который сам до конца данных не закрылся бы
    open_end = example_paragraph(by_key[("CCCUSDT", at(57))], END)
    assert "и к концу данных (21.09.2026 16:00 UTC) ещё не закрылась." in open_end
    assert "оставался бы открытой сделкой — результата у него нет." in open_end
    md = render_markdown(rep)
    for example in rep.examples:
        assert example_paragraph(example, END) in md
    assert "## Примеры (6)" in md and "Показано 6 из 6 подавленных сигналов." in md


def test_report_without_suppressed_signals(scenario: dict[str, list[Candle]]) -> None:
    """Версия, у которой правило ничего не подавило, даёт честный пустой отчёт."""
    quiet = MarketInputs(symbol="QQQUSDT", h4=series({10: LONG}, {}))
    rep = build_report(["QQQUSDT"], {"QQQUSDT": quiet}.get, options())
    assert len(rep.trades) == 1 and rep.suppressed == [] and rep.examples == ()
    md = render_markdown(rep)
    assert "- Сигналов, которые правило подавило: 0 — 0.0 % от всех сигналов" in md
    assert "За период правило не подавило ни одного сигнала — примеров нет." in md
    assert render_csv(rep).count("\n") == 1
    empty = build_report(["DDDUSDT"], load, options())
    assert empty.symbols == () and empty.missing == ("DDDUSDT",)
    assert "Инструментов с данными нет." in render_markdown(empty)
    assert "- Сигналов, которые правило подавило: 0." in render_markdown(empty)


def test_csv_has_a_row_per_suppressed_signal(scenario: dict[str, list[Candle]]) -> None:
    rep = report(examples=2, charts=False)
    rows = list(csv.DictReader(io.StringIO(render_csv(rep))))
    assert len(rows) == 6
    first = rows[0]
    assert (first["symbol"], first["direction"], first["grade"], first["reason"]) == (
        "AAAUSDT",
        "short",
        "A",
        "open",
    )
    assert first["suppressed_candle_close_utc"] == "2026-09-14T04:00:00Z"
    assert (first["entry"], first["stop"], first["tp1"], first["tp3"]) == ("100", "103", "97", "88")
    assert first["open_trade_candle_close_utc"] == "2026-09-13T12:00:00Z"
    assert (first["open_trade_status"], first["open_trade_r"]) == ("closed_time", "-0.043")
    assert (first["hypothetical_status"], first["hypothetical_r"]) == ("closed_sl", "-1.043")
    last = rows[-1]
    assert (last["open_trade_status"], last["open_trade_r"], last["open_trade_exit_utc"]) == (
        "active",
        "",
        "",
    )
    assert (last["hypothetical_status"], last["hypothetical_r"]) == ("active", "")
    assert sorted(r["example"] for r in rows) == ["", "", "", "", "1", "2"]

    # сделки с правилом — отдельным файлом, тем же списком, что у бэктеста
    trades = list(csv.DictReader(io.StringIO(render_trades_csv(rep))))
    assert [(t["symbol"], t["candle_close_utc"], t["status"], t["r"]) for t in trades] == [
        ("AAAUSDT", "2026-09-13T12:00:00Z", "closed_time", "-0.043"),
        ("AAAUSDT", "2026-09-16T04:00:00Z", "closed_sl", "-1.043"),
        ("BBBUSDT", f"{at(40):%Y-%m-%dT%H:%M:%SZ}", "closed_tp3", "2.077"),
        ("BBBUSDT", f"{at(43):%Y-%m-%dT%H:%M:%SZ}", "closed_time", "-0.043"),
        ("CCCUSDT", f"{at(55):%Y-%m-%dT%H:%M:%SZ}", "active", ""),
    ]
    assert (trades[2]["direction"], trades[2]["grade"], trades[2]["tp_hits"]) == ("short", "A", "3")
    assert (trades[2]["entry"], trades[2]["stop"], trades[2]["rr_tp2"]) == ("100", "103", "2.30")
    assert trades[2]["exit_utc"] == f"{at(42):%Y-%m-%dT%H:%M:%SZ}" and trades[4]["exit_utc"] == ""


def test_chart_marks_both_moments(scenario: dict[str, list[Candle]]) -> None:
    rep = report()
    by_key = {(e.signal.symbol, e.signal.at): e for e in rep.examples}
    for example in rep.examples:
        assert example.chart is not None and example.chart.startswith(b"\x89PNG")
    example = by_key[("AAAUSDT", at(28))]
    assert example.chart_file == f"{CHART_DIR}/03-AAAUSDT-20260916T1200.png"
    assert chart_title(example.signal, VERSION) == (
        "AAAUSDT 1.0.0 | A: short A, вход 16.09.2026 04:00, выход 16.09.2026 12:00 (стоп, -1.04R)"
        " | B подавлен: short A, 16.09.2026 12:00 (свеча выхода) | время UTC"
    )
    assert "к концу данных открыта" in chart_title(by_key[("CCCUSDT", at(57))].signal, VERSION)
    # свечей сигнала в ряду нет — графика нет, отчёт это переживает
    signal = example.signal
    assert render_chart(signal, scenario["AAAUSDT"][: PAD + 20], VERSION) is None
    assert render_chart(signal, scenario["AAAUSDT"], VERSION) == example.chart
    assert "Графика нет." in example_paragraph(Example(1, signal), END)


def test_long_trade_is_cut_on_the_left() -> None:
    """Сделка, открытая дольше окна графика: левый край обрезается, свеча подавленного сигнала
    и конец данных остаются в окне."""
    candles = series({}, {})
    opened = candles[20].close_time(Timeframe.H4)
    moment = candles[-3].close_time(Timeframe.H4)
    blocker = replace(_trade("AAAUSDT", opened, None), direction=Direction.DOWN)
    setup = TradeSetup(Direction.UP, D(100), D(100), D(97), D(103), D(107), D(112), D(3), D(2), ())
    signal = Suppressed(
        "AAAUSDT",
        moment,
        Direction.UP,
        Grade.C,
        50,
        setup,
        Reason.OPEN,
        blocker,
        blocker.result,
        None,
    )
    png = render_chart(signal, candles, VERSION)
    assert png is not None and png.startswith(b"\x89PNG")


def test_files_are_deterministic(scenario: dict[str, list[Candle]], tmp_path: Path) -> None:
    """Одинаковый вход — одинаковые файлы байт в байт, включая PNG; времени запуска в них нет."""
    runs = []
    for name in ("one", "two"):
        files = write_report(report(), tmp_path / name)
        runs.append({p.relative_to(tmp_path / name).as_posix(): p.read_bytes() for p in files})
    assert runs[0] == runs[1]
    names = set(runs[0])
    assert {REPORT_MD, REPORT_CSV, TRADES_CSV} <= names
    charts = sorted(n for n in names if n.endswith(".png"))
    assert len(charts) == 6 and all(n.startswith(f"{CHART_DIR}/") for n in charts)
    md = runs[0][REPORT_MD].decode()
    assert f"{datetime.now(tz=UTC):%d.%m.%Y}" not in md
    assert "Граница данных: 21.09.2026 16:00 UTC" in md
    # повторная запись в тот же каталог чужие файлы не трогает
    (tmp_path / "one" / "note.txt").write_text("не трогать")
    write_report(report(), tmp_path / "one")
    assert (tmp_path / "one" / "note.txt").read_text() == "не трогать"
    assert (tmp_path / "one" / REPORT_MD).read_bytes() == runs[0][REPORT_MD]


def test_results_survive_pickling(scenario: dict[str, list[Candle]]) -> None:
    """Расчёт по инструменту передаётся между процессами (``--jobs``) без потерь."""
    results = analyze_all(SYMBOLS, load, options())
    assert pickle.loads(pickle.dumps(results)) == results
    assert [isinstance(r, SymbolReport) for r in results] == [True, True, True, False]


# --- скрипт ------------------------------------------------------------------------------------


def _write_csv(folder: Path, names: dict[str, str]) -> None:
    """CSV-выгрузки сценария в формате ``scripts/backtest.py --data-dir``."""
    folder.mkdir()
    for symbol, name in names.items():
        lines = ["open_time,open,high,low,close,volume,quote_volume,trades"]
        lines += [
            f"{int(c.open_time.timestamp())},{c.open},{c.high},{c.low},{c.close},{c.volume},"
            f"{c.quote_volume},{c.trades}"
            for c in SCENARIO[symbol]
        ]
        (folder / f"{name}-4h.csv").write_text("\n".join(lines) + "\n")


def _cli_args(out: Path, symbols: list[str], *extra: str) -> list[str]:
    return [
        "--strategy",
        VERSION,
        "--symbols",
        *symbols,
        "--from",
        f"{START:%Y-%m-%d}",
        "--to",
        END.isoformat(),
        "--out",
        str(out),
        *extra,
    ]


def _read(folder: Path) -> dict[str, bytes]:
    return {
        p.relative_to(folder).as_posix(): p.read_bytes() for p in folder.rglob("*") if p.is_file()
    }


def test_cli_writes_the_report_from_csv_exports(
    scenario: dict[str, list[Candle]], tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    import one_trade_report as cli

    names = {symbol: symbol for symbol in SCENARIO}
    _write_csv(tmp_path / "data", names)
    # начало периода в аргументе — дата; закрытия до первой свечи сценария сигналов не несут
    code = cli.main(_cli_args(tmp_path / "o", SYMBOLS, "--data-dir", str(tmp_path / "data")))
    assert code == 0
    out = capsys.readouterr()
    assert (
        "инструментов: 3; сделок: 5; занятых закрытий H4: 38; подавленных сигналов: 6; "
        "примеров: 6; файлов: 9" in out.out
    )
    assert "DDDUSDT: мало свечей H4 (0), пропуск" in out.err
    files = _read(tmp_path / "o")
    hidden = [("AAAUSDT", 14), ("AAAUSDT", 25), ("AAAUSDT", 28), ("BBBUSDT", 41)]
    hidden += [("BBBUSDT", 50), ("CCCUSDT", 57)]  # по времени — в этом порядке идут номера
    charts = [
        f"{CHART_DIR}/{n:02d}-{symbol}-{at(i):%Y%m%dT%H%M}.png"
        for n, (symbol, i) in enumerate(hidden, 1)
    ]
    assert sorted(files) == sorted([REPORT_CSV, REPORT_MD, TRADES_CSV, *charts])
    md = files[REPORT_MD].decode()
    assert "- Версия стратегии: `trend-ob-retest@1.0.0`." in md
    assert "| Всего | 2 | 4 | 6 |" in md
    # второй запуск — те же файлы байт в байт; меньше примеров и без графиков — другой набор
    assert (
        cli.main(_cli_args(tmp_path / "again", SYMBOLS, "--data-dir", str(tmp_path / "data"))) == 0
    )
    assert _read(tmp_path / "again") == files
    brief = _cli_args(
        tmp_path / "brief",
        SYMBOLS,
        "--data-dir",
        str(tmp_path / "data"),
        "--examples",
        "2",
        "--no-png",
    )
    assert cli.main(brief) == 0
    assert sorted(_read(tmp_path / "brief")) == sorted([REPORT_MD, REPORT_CSV, TRADES_CSV])
    assert "## Примеры (2)" in (tmp_path / "brief" / REPORT_MD).read_text()


def test_cli_rejects_bad_arguments(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    import one_trade_report as cli

    assert (
        cli.main(["--strategy", VERSION, "--to", "2026-09-01", "--out", str(tmp_path / "x")]) == 2
    )
    assert "укажите --symbols или --symbols-file" in capsys.readouterr().err
    late = _cli_args(tmp_path / "x", ["AAAUSDT"], "--now", "2026-01-01")
    assert cli.main(late) == 2
    assert "now раньше конца периода" in capsys.readouterr().err
    assert not (tmp_path / "x").exists()
    with pytest.raises(SystemExit):
        cli.main(["--strategy", "trend-ob-retest@9.9.9", "--to", "2026-09-01", "--out", "x"])
    with pytest.raises(SystemExit):  # --to обязателен: текущее время не используется
        cli.main(["--strategy", VERSION, "--symbols", "AAAUSDT", "--out", "x"])


def test_cli_keeps_only_the_pairs_of_a_version_with_its_own_list(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """У версии со своим списком инструментов (1.2.1 — 20 пар MVP) отчёт строится только по её
    парам, как и бэктест: вне списка версия сигналов не выпускает (задача 11)."""
    import backtest
    import one_trade_report as cli

    from engine.strategies import MVP_SYMBOLS, STRATEGIES

    v121 = STRATEGIES["trend-ob-retest@1.2.1"]
    assert backtest.version_symbols(v121, []) == (list(MVP_SYMBOLS), [])
    assert backtest.version_symbols(v121, ["BTCUSDT", "AAAUSDT"]) == (["BTCUSDT"], ["AAAUSDT"])
    v120 = STRATEGIES["trend-ob-retest@1.2.0"]
    assert backtest.version_symbols(v120, ["AAAUSDT"]) == (["AAAUSDT"], [])
    args = ["--strategy", "trend-ob-retest@1.2.1", "--symbols", "AAAUSDT", "--to", "2026-09-01"]
    assert cli.main([*args, "--out", str(tmp_path / "x")]) == 2
    err = capsys.readouterr().err
    assert "пропущены: AAAUSDT" in err and "укажите --symbols" in err
    assert not (tmp_path / "x").exists()


def test_cli_in_several_processes_gives_the_same_files(tmp_path: Path) -> None:
    """``--jobs``: инструменты считаются в отдельных процессах, файлы — те же. Здесь настоящий
    ``evaluate`` (подмена в дочерние процессы не передаётся): на спокойном ряду сигналов нет."""
    import one_trade_report as cli

    names = {symbol: symbol for symbol in SCENARIO}
    _write_csv(tmp_path / "data", names)
    symbols_file = tmp_path / "symbols.txt"
    symbols_file.write_text("# список\n" + "\n".join(SYMBOLS) + "\n")
    common = [
        "--strategy",
        VERSION,
        "--symbols-file",
        str(symbols_file),
        "--from",
        f"{START:%Y-%m-%d}",
        "--to",
        END.isoformat(),
        "--data-dir",
        str(tmp_path / "data"),
    ]
    assert cli.main([*common, "--out", str(tmp_path / "one")]) == 0
    assert cli.main([*common, "--out", str(tmp_path / "two"), "--jobs", "2"]) == 0
    assert _read(tmp_path / "one") == _read(tmp_path / "two")
    md = (tmp_path / "one" / REPORT_MD).read_text()
    assert "- Инструментов с данными: 3; без данных или с короткой историей: 1 (DDDUSDT)." in md
    assert "- Сделок с правилом (как в бэктесте): 0." in md


# --- на БД -------------------------------------------------------------------------------------


def _db_available() -> bool:
    try:
        with db_engine.connect() as conn:
            conn.execute(text("select cost_r from signal_results limit 0"))
        return True
    except (OperationalError, DBAPIError):
        return False


db_only = pytest.mark.skipif(not _db_available(), reason="БД с миграциями недоступна")


@pytest.fixture
def stored_scenario() -> Iterator[dict[str, str]]:
    """Сценарий в БД под своими именами инструментов. Скрипт читает БД отдельным соединением,
    поэтому строки фиксируются — и удаляются в конце теста."""
    tag = secrets.token_hex(3).upper()
    names = {symbol: f"OT{tag}{symbol}" for symbol in SCENARIO}
    ids: list[int] = []
    try:
        with Session(db_engine) as s:
            for symbol, name in names.items():
                inst = Instrument(
                    exchange="binance",
                    symbol=name,
                    base=name.removesuffix("USDT"),
                    quote="USDT",
                    market_type="futures",
                    tick_size=D("0.01"),
                    lot_size=D("0.001"),
                )
                s.add(inst)
                s.flush()
                ids.append(inst.id)
                s.execute(
                    insert(CandleRow),
                    [
                        {
                            "instrument_id": inst.id,
                            "timeframe": "4h",
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
                        for c in SCENARIO[symbol]
                    ],
                )
            s.commit()
        yield names
    finally:
        with Session(db_engine) as s:
            s.execute(delete(CandleRow).where(CandleRow.instrument_id.in_(ids)))
            s.execute(delete(Instrument).where(Instrument.id.in_(ids)))
            s.commit()


@db_only
def test_cli_reads_the_database_like_the_backtest(
    scenario: dict[str, list[Candle]],
    stored_scenario: dict[str, str],
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Запуск на БД: свечи читаются загрузчиками ``scripts/backtest.py``, отчёт — тот же байт в
    байт, что на CSV-выгрузках тех же свечей. В БД скрипт ничего не пишет."""
    import one_trade_report as cli

    symbols = [*stored_scenario.values(), "OTNODATAUSDT"]

    def counts() -> tuple[int, ...]:
        with db_engine.connect() as conn:
            return tuple(
                conn.execute(text(f"select count(*) from {table}")).scalar_one()
                for table in ("signals", "backtest_runs", "candles", "instruments")
            )

    before = counts()
    assert cli.main(_cli_args(tmp_path / "db", symbols)) == 0
    assert counts() == before
    out = capsys.readouterr()
    assert "инструментов: 3; сделок: 5; занятых закрытий H4: 38; подавленных сигналов: 6" in out.out
    _write_csv(tmp_path / "data", stored_scenario)
    assert cli.main(_cli_args(tmp_path / "csv", symbols, "--data-dir", str(tmp_path / "data"))) == 0
    from_db, from_csv = _read(tmp_path / "db"), _read(tmp_path / "csv")
    assert from_db == from_csv and len(from_db) == 9
    md = from_db[REPORT_MD].decode()
    name = stored_scenario["AAAUSDT"]
    assert f"| {name} | 2 | 17 | 3 | 1 | 2 | 1 | 2 |" in md
    assert "без данных или с короткой историей: 1 (OTNODATAUSDT)" in md
