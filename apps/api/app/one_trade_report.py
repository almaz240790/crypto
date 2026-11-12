"""Отчёт для владельца: что подавляет правило «одна открытая сделка на инструмент и версию»
(задача 6 пакета «Сигналы», требование 6; план 10.4 — 20 примеров на правило).

Правило — ``engine.lifecycle.blocking_signal``; его применяет ``run_backtest``. Отчёт правило не
меняет и ничего не решает: он прогоняет бэктест версии по списку инструментов и через
``on_busy`` собирает **подавленные сигналы** — кандидаты, которые стали бы сделкой, если бы по
инструменту в этот момент не было сделки той же версии. Для каждого записано, что мешало:

- сделка ещё открыта (``Reason.OPEN``);
- сделка закрылась внутри сигнальной свечи кандидата — «свеча выхода» (``Reason.EXIT_CANDLE``).

По каждому подавленному сигналу считается, чем он закончился бы сам по себе (``simulate_trade``
по тем же свечам и с теми же комиссиями) — это гипотетический результат на прошлых данных,
иллюстрация, а не рекомендация. Для примеров (по умолчанию 20) рисуется PNG
(``app.debug.render_png``) и пишется абзац простым языком.

Модуль не знает о БД: вход инструмента даёт вызывающий (``load``), скрипт
``scripts/one_trade_report.py`` берёт его загрузчиками бэктеста. Свечи, не закрытые к моменту
``now``, отсекаются здесь через ``closed_only`` и в движок не попадают.

Отчёт детерминирован: одинаковые данные и аргументы дают одинаковые файлы байт в байт. Времени
запуска в файлах нет; порядок строк и выбор примеров от него не зависят.
"""

from __future__ import annotations

import csv
import io
from collections.abc import Callable, Iterable, Sequence
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from enum import StrEnum
from functools import partial
from multiprocessing import get_context
from pathlib import Path

from app.debug import ACCENT, DOWN, UP, WARN, render_png
from engine.backtest import (
    DEFAULT_EXECUTION,
    BacktestTrade,
    Metrics,
    TradeResult,
    TradeStatus,
    run_backtest,
    signal_status,
    simulate_trade,
    summarize,
)
from engine.candles import SIGNAL_TIMEFRAME, Candle, Timeframe, closed_only
from engine.lifecycle import SignalLife
from engine.params import StrategyParams
from engine.scoring import Grade
from engine.signal import MarketInputs, SignalCandidate
from engine.strategies import STRATEGIES
from engine.structure import Direction, MarketStructure
from engine.trade import TradeSetup

REPORT_MD = "one_trade_report.md"
REPORT_CSV = "one_trade_report.csv"
TRADES_CSV = "one_trade_trades.csv"
CHART_DIR = "examples"

DEFAULT_EXAMPLES = 20
"""Сколько примеров показывать (CLAUDE.md: «20 примеров на правило»)."""
DEFAULT_WINDOW = 700
"""Сколько последних свечей H4 видит ``evaluate`` — как в ``scripts/backtest.py``."""
FACET_SHARE = 5
"""Каждой причине и каждому направлению гарантируется не меньше 1/5 примеров (если столько есть)."""

CHART_BEFORE = 30
"""Свечей H4 до сигнальной свечи открытой сделки в окне графика."""
CHART_AFTER = 8
"""Свечей H4 после последнего из двух моментов — выхода сделки и подавленного сигнала."""
CHART_MAX_BARS = 220
"""Предел ширины окна: у сделки, которая живёт дольше, левый край обрезается."""
LABEL_SPAN = 3
"""Подпись ставится над максимумом (под минимумом) свечи и стольких соседних с каждой стороны."""
LABEL_NEAR = 9
"""Подписи на одной стороне ближе этого числа свечей разносятся: по высоте или по краям."""
LABEL_LINE = Decimal("0.022")
"""Высота строки подписи в долях ценового диапазона окна (шрифт ``render_png`` — 8 пунктов)."""

R_QUANT = Decimal("0.01")
CSV_R_QUANT = Decimal("0.001")
DASH = "—"

STATUS_LABEL = {
    "closed_time": "по времени",
    "closed_sl": "по стопу",
    "closed_be": "в безубыток",
    "closed_tp3": "по третьей цели",
}
"""Как закрылась сделка — для текста (вход рыночный: статусов pending и expired не бывает)."""
CHART_STATUS = {
    "closed_time": "по времени",
    "closed_sl": "стоп",
    "closed_be": "безубыток",
    "closed_tp3": "цель 3",
}
"""То же коротко — для подписей и заголовка графика."""
DIRECTION_LABEL = {Direction.UP: "лонг (на рост)", Direction.DOWN: "шорт (на снижение)"}
DIRECTION_CODE = {Direction.UP: "long", Direction.DOWN: "short"}


class Reason(StrEnum):
    """Почему инструмент был занят в момент подавленного сигнала."""

    OPEN = "open"
    """Сделка более раннего сигнала ещё открыта."""
    EXIT_CANDLE = "exit_candle"
    """Сделка закрылась внутри свечи H4, на закрытии которой появился сигнал."""


REASON_LABEL = {Reason.OPEN: "сделка ещё открыта", Reason.EXIT_CANDLE: "свеча выхода"}


# --- параметры и данные отчёта -----------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ReportOptions:
    version: str
    """Версия стратегии из ``engine.strategies``, например ``trend-ob-retest@1.2.0``."""
    start: datetime
    """Начало периода: закрытия H4 не раньше этого момента (UTC)."""
    end: datetime
    """Конец периода: закрытия H4 не позже этого момента (UTC)."""
    now: datetime
    """Граница данных (UTC): свеча, не закрытая к этому моменту, в расчёт не попадает."""
    examples: int = DEFAULT_EXAMPLES
    window: int = DEFAULT_WINDOW
    charts: bool = True

    def __post_init__(self) -> None:
        for name, t in (("start", self.start), ("end", self.end), ("now", self.now)):
            if t.tzinfo is None or t.utcoffset() != timedelta(0):
                raise ValueError(f"{name} должен быть timezone-aware в UTC")
        if self.version not in STRATEGIES:
            known = ", ".join(sorted(STRATEGIES))
            raise ValueError(f"версии {self.version} нет в engine.strategies; есть: {known}")
        if self.end < self.start:
            raise ValueError("конец периода раньше начала")
        if self.now < self.end:
            raise ValueError("граница данных now раньше конца периода")
        if self.examples < 0:
            raise ValueError("число примеров не может быть отрицательным")

    @property
    def params(self) -> StrategyParams:
        return STRATEGIES[self.version]


@dataclass(frozen=True, slots=True)
class Suppressed:
    """Сигнал, который правило не пропустило, и сделка, из-за которой инструмент был занят."""

    symbol: str
    at: datetime
    """Закрытие сигнальной свечи подавленного сигнала (UTC)."""
    direction: Direction
    grade: Grade
    score: int
    setup: TradeSetup
    reason: Reason
    blocker: BacktestTrade
    """Сделка этого же прогона, из-за которой инструмент занят."""
    outcome: TradeResult
    """Гипотетически: чем сигнал закончился бы сам по себе (``simulate_trade``)."""
    outcome_exit: datetime | None
    """Время гипотетического закрытия; ``None`` — к границе данных сделка не закрылась бы."""

    @property
    def key(self) -> tuple[datetime, str]:
        return (self.at, self.symbol)

    @property
    def alone(self) -> BacktestTrade:
        """Сигнал как отдельная сделка (гипотетически) — в виде сделки бэктеста: для тех же
        метрик, что считаются по настоящим сделкам прогона."""
        return BacktestTrade(
            symbol=self.symbol,
            direction=self.direction,
            signal_time=self.at,
            grade=self.grade,
            score=self.score,
            rr_tp2=self.setup.rr_tp2,
            entry=self.setup.entry_market,
            stop=self.setup.stop_loss,
            tp1=self.setup.tp1,
            tp2=self.setup.tp2,
            tp3=self.setup.tp3,
            result=self.outcome,
            exit_time=self.outcome_exit,
        )


@dataclass(frozen=True, slots=True)
class SymbolReport:
    """Итог по одному инструменту."""

    symbol: str
    h4: int
    d1: int
    w1: int
    funding: int
    open_interest: int
    long_short: int
    """Размеры входа после отсечения по ``now`` — чтобы в отчёте было видно, на чём считали."""
    first_close: datetime | None
    last_close: datetime | None
    """Первое и последнее закрытие H4 инструмента внутри периода."""
    evaluated: int
    """Закрытий H4, на которых сигнал искался (инструмент свободен)."""
    busy: int
    """Закрытий H4, пропущенных правилом (``skipped['busy']``)."""
    trades: tuple[BacktestTrade, ...]
    suppressed: tuple[Suppressed, ...]


@dataclass(frozen=True, slots=True)
class Example:
    number: int
    signal: Suppressed
    chart: bytes | None = None

    @property
    def chart_name(self) -> str:
        s = self.signal
        return f"{self.number:02d}-{s.symbol}-{s.at:%Y%m%dT%H%M}.png"

    @property
    def chart_file(self) -> str | None:
        return None if self.chart is None else f"{CHART_DIR}/{self.chart_name}"


@dataclass(frozen=True, slots=True)
class Report:
    options: ReportOptions
    symbols: tuple[SymbolReport, ...]
    """Инструменты с данными, в порядке списка."""
    missing: tuple[str, ...]
    """Инструменты списка, по которым данных нет или мало (``load`` вернул ``None``)."""
    examples: tuple[Example, ...]

    @property
    def trades(self) -> list[BacktestTrade]:
        return [t for s in self.symbols for t in s.trades]

    @property
    def suppressed(self) -> list[Suppressed]:
        return [x for s in self.symbols for x in s.suppressed]


# --- расчёт по инструменту ---------------------------------------------------------------------


def bounded(inp: MarketInputs, now: datetime) -> MarketInputs:
    """Вход без свечей, не закрытых к ``now``: движок получает только закрытые свечи."""
    return replace(
        inp,
        h4=closed_only(inp.h4, Timeframe.H4, now),
        d1=closed_only(inp.d1, Timeframe.D1, now),
        w1=closed_only(inp.w1, Timeframe.W1, now),
    )


def busy_reason(blocker: BacktestTrade, at: datetime) -> Reason:
    """Почему сделка ``blocker`` занимает инструмент на закрытии свечи ``at``.

    Сделка, закрывшаяся позже ``at`` (или не закрывшаяся к концу данных), в этот момент ещё
    открыта. Сделка, закрывшаяся внутри свечи, которая заканчивается в ``at``, — «свеча выхода».
    """
    exit_time = blocker.exit_time
    if exit_time is None or exit_time > at:
        return Reason.OPEN
    if exit_time <= at - SIGNAL_TIMEFRAME.delta:
        raise ValueError(
            f"{blocker.symbol}: сделка закрылась {exit_time.isoformat()} — раньше свечи "
            f"{at.isoformat()}, занимать инструмент она не может"
        )
    return Reason.EXIT_CANDLE


def analyze(inp: MarketInputs, options: ReportOptions) -> SymbolReport:
    """Бэктест инструмента с правилом и список сигналов, которые правило подавило.

    Сделки и счётчики — ровно те, что даёт ``run_backtest`` без ``on_busy``; инструменты в
    бэктесте друг на друга не влияют, поэтому прогон по одному даёт те же сделки, что общий.
    """
    params = options.params
    tf = SIGNAL_TIMEFRAME
    inp = bounded(inp, options.now)
    h4 = list(inp.h4)
    index = {c.open_time: i for i, c in enumerate(h4)}
    hidden: list[tuple[SignalCandidate, SignalLife]] = []
    run = run_backtest(
        [replace(inp, h4=h4)],
        params,
        options.start,
        options.end,
        DEFAULT_EXECUTION,
        window=options.window,
        on_busy=lambda candidate, blocker: hidden.append((candidate, blocker)),
    )
    trades = {t.signal_time: t for t in run.trades}
    suppressed: list[Suppressed] = []
    for candidate, life in hidden:
        at = candidate.candle_close_time
        blocker = trades[life.opened_at]
        bar = index[at - tf.delta]
        outcome = simulate_trade(candidate.trade, h4[bar + 1 :], params.trade, DEFAULT_EXECUTION)
        exit_index = outcome.exit_index
        suppressed.append(
            Suppressed(
                symbol=inp.symbol,
                at=at,
                direction=candidate.direction,
                grade=candidate.score.grade,
                score=candidate.score.total,
                setup=candidate.trade,
                reason=busy_reason(blocker, at),
                blocker=blocker,
                outcome=outcome,
                outcome_exit=(
                    None if exit_index is None else h4[bar + 1 + exit_index].close_time(tf)
                ),
            )
        )
    closes = [t for c in h4 if options.start <= (t := c.close_time(tf)) <= options.end]
    return SymbolReport(
        symbol=inp.symbol,
        h4=len(h4),
        d1=len(inp.d1),
        w1=len(inp.w1),
        funding=len(inp.funding),
        open_interest=len(inp.open_interest),
        long_short=len(inp.long_short),
        first_close=closes[0] if closes else None,
        last_close=closes[-1] if closes else None,
        evaluated=run.evaluated,
        busy=run.skipped["busy"],
        trades=tuple(run.trades),
        suppressed=tuple(suppressed),
    )


# --- выбор примеров ----------------------------------------------------------------------------


def select_examples(items: Iterable[Suppressed], n: int) -> list[Suppressed]:
    """До ``n`` примеров, разнесённых по инструментам и по времени. Результат — по времени.

    Выбор жадный и не зависит от порядка входа: очередной пример берётся у инструмента, у
    которого примеров пока меньше всего, а среди таких — самый далёкий по времени от уже
    выбранных (при равенстве — самый ранний, затем по имени инструмента). Сначала каждой причине
    и каждому направлению набирается не меньше ``n // FACET_SHARE`` примеров (если столько есть),
    чтобы редкий случай — «свеча выхода» — попал в выборку.
    """
    pool = sorted(items, key=lambda s: s.key)
    n = min(n, len(pool))
    chosen: list[Suppressed] = []
    per_symbol: dict[str, int] = {}

    def gap(s: Suppressed) -> float:
        return min((abs((s.at - c.at).total_seconds()) for c in chosen), default=0.0)

    def pick(candidates: list[Suppressed]) -> None:
        best = min(candidates, key=lambda s: (per_symbol.get(s.symbol, 0), -gap(s), s.at, s.symbol))
        chosen.append(best)
        pool.remove(best)
        per_symbol[best.symbol] = per_symbol.get(best.symbol, 0) + 1

    facets: list[tuple[Callable[[Suppressed], object], object]] = [
        (lambda s: s.reason, Reason.EXIT_CANDLE),
        (lambda s: s.reason, Reason.OPEN),
        (lambda s: s.direction, Direction.UP),
        (lambda s: s.direction, Direction.DOWN),
    ]
    for facet, value in facets:
        while len(chosen) < n and sum(1 for c in chosen if facet(c) is value) < n // FACET_SHARE:
            candidates = [s for s in pool if facet(s) is value]
            if not candidates:
                break
            pick(candidates)
    while len(chosen) < n:
        pick(pool)
    return sorted(chosen, key=lambda s: s.key)


# --- график примера ----------------------------------------------------------------------------


def _quantized(x: Decimal, quant: Decimal) -> Decimal:
    q = x.quantize(quant, rounding=ROUND_HALF_UP)
    return abs(q) if q == 0 else q


def _r(x: Decimal) -> str:
    """R со знаком, два знака после запятой."""
    q = _quantized(x, R_QUANT)
    return "0.00" if q == 0 else format(q, "+f")


def _when(t: datetime) -> str:
    return f"{t:%d.%m.%Y %H:%M}"


def closing_text(result: TradeResult) -> str:
    """Как закрылась сделка — словами для абзаца: «по стопу», «по времени» и т. д."""
    if result.status is TradeStatus.CLOSED_BE:
        target = "первой" if result.tp_hits == 1 else "второй"
        return f"в безубыток после {target} цели"
    return STATUS_LABEL[signal_status(result).value]


def _exit_price(trade: BacktestTrade, exit_candle: Candle) -> Decimal:
    """Цена выхода сделки — для выбора места подписи на графике."""
    status = trade.result.status
    if status is TradeStatus.CLOSED_SL:
        return trade.stop
    if status is TradeStatus.CLOSED_BE:
        return trade.entry
    if status is TradeStatus.CLOSED_TP3:
        return trade.tp3
    return exit_candle.close


def chart_title(s: Suppressed, version: str) -> str:
    a = s.blocker
    if a.exit_time is None:
        ending = "к концу данных открыта"
    else:
        status = CHART_STATUS[signal_status(a.result).value]
        ending = f"выход {_when(a.exit_time)} ({status}, {_r(a.realized_r)}R)"
    return (
        f"{s.symbol} {version.rsplit('@', 1)[-1]} | "
        f"A: {DIRECTION_CODE[a.direction]} {a.grade.value}, вход {_when(a.signal_time)}, {ending}"
        f" | B подавлен: {DIRECTION_CODE[s.direction]} {s.grade.value}, {_when(s.at)} "
        f"({REASON_LABEL[s.reason]}) | время UTC"
    )


def render_chart(s: Suppressed, h4: Sequence[Candle], version: str) -> bytes | None:
    """PNG примера на H4: открытая сделка A и подавленный сигнал B.

    Уровни сделки A (вход, стоп, три цели) — отрезки от её сигнальной свечи до свечи выхода:
    длина отрезков и есть время, пока сделка была открыта. Сигнальная свеча A и свеча её выхода
    обведены и подписаны цветом. Свеча подавленного сигнала B отмечена иначе — вертикальной
    пунктирной линией через весь график, точкой на цене входа и серой подписью у края графика.
    Структура и зоны не рисуются: здесь важны два момента времени, а не причина сигнала.
    ``h4`` — закрытые свечи инструмента; ``None`` — нужных свечей в ряду нет.

    Подписи ``render_png`` ставит у переданной цены (над ней или под ней — по направлению
    отметки), поэтому цена выбирается так, чтобы подпись не легла на свечи и на другую подпись:
    над максимумом или под минимумом соседних свечей, вторая подпись на той же стороне — строкой
    дальше, подпись B — у того края графика, где рядом нет подписей A.
    """
    tf = SIGNAL_TIMEFRAME
    a = s.blocker
    index = {c.open_time: i for i, c in enumerate(h4)}
    a_bar = index.get(a.signal_time - tf.delta)
    b_bar = index.get(s.at - tf.delta)
    if a_bar is None or b_bar is None:
        return None
    a_exit = None if a.exit_time is None else index.get(a.exit_time - tf.delta)
    last_event = len(h4) - 1 if a_exit is None else max(a_exit, b_bar)
    right = min(len(h4) - 1, last_event + CHART_AFTER)
    left = max(0, a_bar - CHART_BEFORE, right - CHART_MAX_BARS + 1)
    candles = list(h4[left : right + 1])
    low = min(c.low for c in candles)
    high = max(c.high for c in candles)
    line = (high - low) * LABEL_LINE

    def x(bar: int) -> int:
        return bar - left

    def beside(bar: int, above: bool, lines: int = 0) -> Decimal:
        """Цена для подписи у свечи ``bar``: за экстремумом соседних свечей, ``lines`` строк
        дальше; не выходит за ценовой диапазон окна больше чем на строку."""
        near = candles[max(0, x(bar) - LABEL_SPAN) : x(bar) + LABEL_SPAN + 1]
        if above:
            return min(max(c.high for c in near) + line * lines, high + line)
        return max(min(c.low for c in near) - line * lines, low - line)

    a_end = x(right if a_exit is None else a_exit)
    levels = (
        (a.entry, ACCENT, "-"),
        (a.stop, DOWN, "--"),
        (a.tp1, UP, ":"),
        (a.tp2, UP, ":"),
        (a.tp3, UP, ":"),
    )
    segments = [(x(a_bar), float(p), a_end, float(p), color, ls) for p, color, ls in levels]
    segments.append((x(b_bar), float(low), x(b_bar), float(high), WARN, "--"))
    marks: list[tuple[int, int, Decimal, str, str | None]] = []
    labelled: list[tuple[int, bool]] = []  # (свеча, подпись сверху?) — занятые места
    entry_above = a.direction is Direction.DOWN
    if a_bar >= left:
        marks.append(
            (
                x(a_bar),
                x(a_bar),
                beside(a_bar, entry_above),
                f"A: вход {DIRECTION_CODE[a.direction]}",
                "down" if entry_above else "up",
            )
        )
        labelled.append((a_bar, entry_above))
    if a_exit is not None:
        exit_above = a.realized_r <= 0
        crowded = any(side is exit_above and a_exit - bar <= LABEL_NEAR for bar, side in labelled)
        marks.append(
            (
                x(a_exit),
                x(a_exit),
                beside(a_exit, exit_above, lines=1 if crowded else 0),
                f"A: выход ({CHART_STATUS[signal_status(a.result).value]})",
                "down" if exit_above else "up",
            )
        )
        labelled.append((a_exit, exit_above))

    def busy(above: bool) -> bool:
        return any(side is above and abs(b_bar - bar) <= LABEL_NEAR for bar, side in labelled)

    b_on_top = not busy(True) or busy(False)
    marks.append(
        (
            x(b_bar),
            x(b_bar),
            high if b_on_top else low - line * 2,
            f"B: подавленный сигнал {DIRECTION_CODE[s.direction]}",
            None,
        )
    )
    dots = [(x(b_bar), float(s.setup.entry_market))]
    return render_png(
        candles,
        MarketStructure(),
        (),
        len(candles),
        chart_title(s, version),
        marks=marks,
        segments=segments,
        dots=dots,
    )


# --- сборка ------------------------------------------------------------------------------------

Loader = Callable[[str], MarketInputs | None]
"""Вход бэктеста по инструменту; ``None`` — данных нет или мало."""


def analyze_symbol(load: Loader, options: ReportOptions, symbol: str) -> SymbolReport | None:
    """Загрузка и расчёт одного инструмента; ``None`` — данных нет или мало."""
    inp = load(symbol)
    return None if inp is None else analyze(inp, options)


def analyze_all(
    symbols: Sequence[str], load: Loader, options: ReportOptions, jobs: int = 1
) -> list[SymbolReport | None]:
    """Расчёт по каждому инструменту, в порядке списка. ``jobs`` > 1 — в стольких процессах:
    инструменты независимы, результат от числа процессов не зависит. Для процессов ``load``
    должен быть функцией уровня модуля (или ``functools.partial`` от неё)."""
    work = partial(analyze_symbol, load, options)
    if jobs <= 1 or len(symbols) <= 1:
        return [work(symbol) for symbol in symbols]
    with ProcessPoolExecutor(max_workers=jobs, mp_context=get_context("spawn")) as pool:
        return list(pool.map(work, symbols))


def build_report(
    symbols: Sequence[str], load: Loader, options: ReportOptions, jobs: int = 1
) -> Report:
    """Считает отчёт по списку инструментов. ``load`` вызывается по одному инструменту за раз
    (свечи всех инструментов разом в памяти не держатся) и ещё раз — для инструментов примеров,
    когда рисуются графики."""
    ordered = list(dict.fromkeys(symbols))
    return assemble(ordered, analyze_all(ordered, load, options, jobs), load, options)


def assemble(
    symbols: Sequence[str],
    results: Sequence[SymbolReport | None],
    load: Loader,
    options: ReportOptions,
) -> Report:
    """Отчёт из расчётов по инструментам: выбор примеров и их графики."""
    done = [r for r in results if r is not None]
    missing = [symbol for symbol, r in zip(symbols, results, strict=True) if r is None]
    picked = select_examples((x for s in done for x in s.suppressed), options.examples)
    charts: dict[tuple[datetime, str], bytes | None] = {}
    if options.charts:
        for symbol in dict.fromkeys(s.symbol for s in picked):
            inp = load(symbol)
            h4 = [] if inp is None else list(bounded(inp, options.now).h4)
            for s in picked:
                if s.symbol == symbol:
                    charts[s.key] = render_chart(s, h4, options.version)
    examples = tuple(Example(i, s, charts.get(s.key)) for i, s in enumerate(picked, 1))
    return Report(options, tuple(done), tuple(missing), examples)


# --- итоги -------------------------------------------------------------------------------------


def count_by(
    items: Iterable[Suppressed],
) -> dict[tuple[Reason, Direction], int]:
    """Подавленные сигналы по причине и направлению (все сочетания, включая нулевые)."""
    out = {(r, d): 0 for r in Reason for d in Direction}
    for s in items:
        out[(s.reason, s.direction)] += 1
    return out


# --- CSV ---------------------------------------------------------------------------------------

CSV_COLUMNS = (
    "version",
    "symbol",
    "suppressed_candle_close_utc",
    "direction",
    "grade",
    "score",
    "reason",
    "entry",
    "stop",
    "tp1",
    "tp2",
    "tp3",
    "open_trade_candle_close_utc",
    "open_trade_direction",
    "open_trade_grade",
    "open_trade_status",
    "open_trade_r",
    "open_trade_exit_utc",
    "hypothetical_status",
    "hypothetical_r",
    "hypothetical_exit_utc",
    "example",
    "chart",
)


def _iso(t: datetime | None) -> str:
    return "" if t is None else f"{t:%Y-%m-%dT%H:%M:%SZ}"


def _price(x: Decimal) -> str:
    return format(x.normalize(), "f")


def _csv_r(result: TradeResult) -> str:
    return format(_quantized(result.realized_r, CSV_R_QUANT), "f") if result.closed else ""


TRADE_COLUMNS = (
    "version",
    "symbol",
    "candle_close_utc",
    "direction",
    "grade",
    "score",
    "rr_tp2",
    "entry",
    "stop",
    "tp1",
    "tp2",
    "tp3",
    "status",
    "tp_hits",
    "r",
    "exit_utc",
)


def render_trades_csv(report: Report) -> str:
    """CSV сделок с правилом — тот же список, что даёт бэктест: для сверки с сохранённым
    прогоном. По инструментам в порядке списка и по времени."""
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(TRADE_COLUMNS)
    for t in report.trades:
        writer.writerow(
            [
                report.options.version,
                t.symbol,
                _iso(t.signal_time),
                DIRECTION_CODE[t.direction],
                t.grade.value,
                t.score,
                format(_quantized(t.rr_tp2, R_QUANT), "f"),
                _price(t.entry),
                _price(t.stop),
                _price(t.tp1),
                _price(t.tp2),
                _price(t.tp3),
                signal_status(t.result).value,
                t.result.tp_hits,
                _csv_r(t.result),
                _iso(t.exit_time),
            ]
        )
    return buf.getvalue()


def render_csv(report: Report) -> str:
    """CSV: одна строка на подавленный сигнал, по инструментам в порядке списка и по времени."""
    examples = {e.signal.key: e for e in report.examples}
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(CSV_COLUMNS)
    for s in report.suppressed:
        a, example = s.blocker, examples.get(s.key)
        writer.writerow(
            [
                report.options.version,
                s.symbol,
                _iso(s.at),
                DIRECTION_CODE[s.direction],
                s.grade.value,
                s.score,
                s.reason.value,
                _price(s.setup.entry_market),
                _price(s.setup.stop_loss),
                _price(s.setup.tp1),
                _price(s.setup.tp2),
                _price(s.setup.tp3),
                _iso(a.signal_time),
                DIRECTION_CODE[a.direction],
                a.grade.value,
                signal_status(a.result).value,
                _csv_r(a.result),
                _iso(a.exit_time),
                signal_status(s.outcome).value,
                _csv_r(s.outcome),
                _iso(s.outcome_exit),
                "" if example is None else example.number,
                "" if example is None else (example.chart_file or ""),
            ]
        )
    return buf.getvalue()


# --- Markdown ----------------------------------------------------------------------------------


def _table(headers: Sequence[str], rows: Sequence[Sequence[object]], right: str = "") -> list[str]:
    """Таблица Markdown; ``right`` — строка из «r» и «l» по столбцам (по умолчанию все «l»)."""
    align = right.ljust(len(headers), "l")

    def line(cells: Sequence[object]) -> str:
        return "| " + " | ".join(str(c).replace("|", "\\|") for c in cells) + " |"

    return [
        line(headers),
        "|" + "|".join("---:" if a == "r" else "---" for a in align) + "|",
        *(line(r) for r in rows),
    ]


def _hours(start: datetime, end: datetime) -> str:
    hours = (end - start) // timedelta(hours=1)
    return f"{hours} ч"


def _percent(part: int, whole: int) -> str:
    if whole == 0:
        return DASH
    return f"{_quantized(Decimal(part) * 100 / whole, Decimal('0.1'))} %"


def _rate(rate: Decimal) -> str:
    return format((rate * 100).normalize(), "f")


def example_paragraph(example: Example, now: datetime) -> str:
    """Абзац простым языком: что за сделка была открыта, какой сигнал появился и что с ним
    стало бы, если исполнить его отдельно (гипотетически)."""
    s, a = example.signal, example.signal.blocker
    opened = (
        f"Сделка A — {DIRECTION_LABEL[a.direction]}, градация {a.grade.value} — открыта по "
        f"сигналу {_when(a.signal_time)} UTC"
    )
    if a.exit_time is None:
        ended = f" и к концу данных ({_when(now)} UTC) ещё не закрылась."
    else:
        ended = (
            f" и закрылась {_when(a.exit_time)} UTC {closing_text(a.result)}, через "
            f"{_hours(a.signal_time, a.exit_time)}, с результатом {_r(a.realized_r)} R."
        )
    signal = f"сигнал B — {DIRECTION_LABEL[s.direction]}, градация {s.grade.value}"
    if s.reason is Reason.EXIT_CANDLE:
        appeared = (
            f" На закрытии той же четырёхчасовой свечи, внутри которой сделка A закрылась, "
            f"{_when(s.at)} UTC, появился {signal}. Правило его не пропустило: свеча, на которой "
            "сделка закрылась, тоже считается занятой — так же считает бэктест."
        )
    else:
        appeared = (
            f" Пока она была открыта, {_when(s.at)} UTC появился {signal}. Правило его не "
            "пропустило: по инструменту уже была открыта сделка этой версии."
        )
    if s.outcome_exit is None:
        alone = (
            " Сам по себе сигнал B (гипотетически, на прошлых данных) к концу данных оставался бы "
            "открытой сделкой — результата у него нет."
        )
    else:
        alone = (
            " Сам по себе сигнал B, если бы его исполнили отдельной сделкой (гипотетически, "
            f"результат на прошлых данных), закрылся бы {_when(s.outcome_exit)} UTC "
            f"{closing_text(s.outcome)} с результатом {_r(s.outcome.realized_r)} R."
        )
    chart = f" График: `{example.chart_file}`." if example.chart_file else " Графика нет."
    return f"**Пример {example.number}. {s.symbol}.** {opened}{ended}{appeared}{alone}{chart}"


def _share(x: Decimal | None) -> str:
    """Доля 0–1 как проценты с одним знаком."""
    return DASH if x is None else f"{_quantized(x * 100, Decimal('0.1'))} %"


def _metrics_row(name: str, m: Metrics) -> list[str]:
    return [
        name,
        str(m.signals),
        str(m.closed),
        str(m.open),
        _share(m.winrate),
        _r(m.sum_r),
        DASH if m.avg_r is None else _r(m.avg_r),
    ]


def render_markdown(report: Report) -> str:
    """Markdown для владельца: что измерено, сколько сигналов подавлено и почему, примеры."""
    o = report.options
    trades, suppressed = report.trades, report.suppressed
    counts = count_by(suppressed)
    evaluated = sum(s.evaluated for s in report.symbols)
    busy = sum(s.busy for s in report.symbols)
    with_rule = summarize(trades)
    alone = summarize([s.alone for s in suppressed])
    without_rule = summarize([*trades, *(s.alone for s in suppressed)])
    fee, slippage = _rate(DEFAULT_EXECUTION.fee_rate), _rate(DEFAULT_EXECUTION.slippage)
    pf = with_rule.profit_factor
    profit_factor = DASH if pf is None else str(_quantized(pf, R_QUANT))

    def total(reason: Reason | None = None, direction: Direction | None = None) -> int:
        return sum(
            n
            for (r, d), n in counts.items()
            if (reason is None or r is reason) and (direction is None or d is direction)
        )

    out: list[str] = [
        "# Правило «одна открытая сделка на инструмент и версию»: что оно подавляет",
        "",
        "Отчёт только читает данные и ничего не меняет. Числа — результаты на прошлых данных; "
        "это проверка правила на примерах, а не оценка доходности и не рекомендация.",
        "",
        f"- Версия стратегии: `{o.version}`.",
        f"- Период: закрытия четырёхчасовых свечей (H4) с {_when(o.start)} по {_when(o.end)} UTC.",
        f"- Граница данных: {_when(o.now)} UTC — свечи, не закрытые к этому моменту, в расчёт не "
        "попадают.",
        f"- Вход рыночный (по закрытию сигнальной свечи); комиссия {fee} % за сторону и "
        f"проскальзывание {slippage} % — как в бэктесте.",
        f"- Инструментов с данными: {len(report.symbols)}"
        + (
            f"; без данных или с короткой историей: {len(report.missing)} "
            f"({', '.join(report.missing)})."
            if report.missing
            else "."
        ),
        "",
        "## Коротко",
        "",
        f"- Сделок с правилом (как в бэктесте): {with_rule.signals}.",
        f"- Те же сделки в метриках бэктеста — для сверки с сохранённым прогоном: закрытых "
        f"{with_rule.closed}, прибыльных {_share(with_rule.winrate)}, профит-фактор "
        f"{profit_factor}, сумма {_r(with_rule.sum_r)} R, наибольшая просадка "
        f"{_quantized(with_rule.max_drawdown_r, Decimal('0.1'))} R.",
        f"- Закрытий H4, на которых сигнал искался: {evaluated}.",
        f"- Закрытий H4, пропущенных правилом (инструмент занят): {busy}.",
        f"- Сигналов, которые правило подавило: {len(suppressed)}"
        + (
            f" — {_percent(len(suppressed), len(trades) + len(suppressed))} от всех "
            "сигналов, которые появились бы без правила."
            if trades or suppressed
            else "."
        ),
        f"- Из них: сделка ещё открыта — {total(Reason.OPEN)}, свеча выхода — "
        f"{total(Reason.EXIT_CANDLE)}; лонг — {total(direction=Direction.UP)}, шорт — "
        f"{total(direction=Direction.DOWN)}.",
        "",
        "## Подавленные сигналы по причине и направлению",
        "",
        *_table(
            ("Почему инструмент занят", "Лонг", "Шорт", "Всего"),
            [
                *(
                    [
                        REASON_LABEL[r].capitalize(),
                        counts[(r, Direction.UP)],
                        counts[(r, Direction.DOWN)],
                        total(r),
                    ]
                    for r in Reason
                ),
                ["Всего", total(direction=Direction.UP), total(direction=Direction.DOWN), total()],
            ],
            right="lrrr",
        ),
        "",
        "## С правилом и гипотетически без него",
        "",
        "Иллюстрация на прошлых данных, не рекомендация. Строка «подавленные сигналы» — каждый "
        "такой сигнал исполнен отдельной сделкой, сам по себе, с теми же комиссиями. Без правила "
        "по одному инструменту одновременно было бы открыто несколько сделок одной версии.",
        "",
        *_table(
            ("", "Сигналов", "Закрыто", "Открыто", "Прибыльных", "Сумма R", "Средний R"),
            [
                _metrics_row("С правилом (сделки бэктеста)", with_rule),
                _metrics_row("Подавленные сигналы, каждый сам по себе", alone),
                _metrics_row("Гипотетически без правила (обе строки вместе)", without_rule),
            ],
            right="lrrrrrr",
        ),
        "",
        "Сумма и среднее R — по закрытым сделкам; у сделки, не закрытой к границе данных, "
        "результата нет.",
        "",
        "## По инструментам",
        "",
    ]
    if report.symbols:
        out += _table(
            (
                "Инструмент",
                "Сделок",
                "Занятых закрытий H4",
                "Подавлено",
                "Сделка открыта",
                "Свеча выхода",
                "Лонг",
                "Шорт",
            ),
            [
                [
                    s.symbol,
                    len(s.trades),
                    s.busy,
                    len(s.suppressed),
                    sum(1 for x in s.suppressed if x.reason is Reason.OPEN),
                    sum(1 for x in s.suppressed if x.reason is Reason.EXIT_CANDLE),
                    sum(1 for x in s.suppressed if x.direction is Direction.UP),
                    sum(1 for x in s.suppressed if x.direction is Direction.DOWN),
                ]
                for s in report.symbols
            ],
            right="lrrrrrrr",
        )
    else:
        out.append("Инструментов с данными нет.")
    out += ["", f"## Примеры ({len(report.examples)})", ""]
    if not suppressed:
        out += ["За период правило не подавило ни одного сигнала — примеров нет.", ""]
    elif not report.examples:
        out += ["Примеры не запрошены.", ""]
    else:
        out += [
            f"Показано {len(report.examples)} из {len(suppressed)} подавленных сигналов. Примеры "
            "выбраны автоматически так, чтобы они были с разных инструментов и из разных частей "
            "периода и чтобы среди них были обе причины и оба направления, если такие есть.",
            "",
            "Как читать график (свечи H4, время UTC). Сделка A: её сигнальная свеча и свеча "
            "выхода обведены рамкой и подписаны; горизонтальные линии — вход (сплошная синяя), "
            "стоп (красная штриховая) и три цели (зелёный пунктир) — нарисованы от сигнальной "
            "свечи до свечи выхода, то есть ровно на то время, пока сделка была открыта. Уровень, "
            "до которого цена не дошла, может оказаться за краем графика. Сигнал B: вертикальная "
            "пунктирная линия через весь график на его сигнальной свече, чёрная точка — цена его "
            "входа, серая подпись — у верхнего или нижнего края.",
            "",
        ]
        for example in report.examples:
            out += [example_paragraph(example, o.now), ""]
    out += [
        "## Данные, на которых посчитано",
        "",
        f"- Funding есть у {sum(1 for s in report.symbols if s.funding)} из {len(report.symbols)} "
        "инструментов; открытый интерес — у "
        f"{sum(1 for s in report.symbols if s.open_interest)}; long/short — у "
        f"{sum(1 for s in report.symbols if s.long_short)}. Фильтр без данных сигнал не "
        "блокирует и бонус не даёт.",
        "",
    ]
    if report.symbols:
        out += _table(
            (
                "Инструмент",
                "Первое закрытие H4 в периоде",
                "Последнее",
                "H4",
                "D1",
                "W1",
                "Funding",
                "OI",
                "Long/short",
            ),
            [
                [
                    s.symbol,
                    DASH if s.first_close is None else _when(s.first_close),
                    DASH if s.last_close is None else _when(s.last_close),
                    s.h4,
                    s.d1,
                    s.w1,
                    s.funding,
                    s.open_interest,
                    s.long_short,
                ]
                for s in report.symbols
            ],
            right="lllrrrrrr",
        )
        out.append("")
    out += [
        "## Как читать отчёт",
        "",
        "1. **Правило.** У одной версии стратегии по одному инструменту — не больше одной сделки "
        "за раз. Пока сделка открыта, новый сигнал этой версии по этому инструменту не "
        "публикуется. Не публикуется он и на закрытии той четырёхчасовой свечи, внутри которой "
        "сделка закрылась («свеча выхода»); со следующей свечи инструмент свободен.",
        "2. **Подавленный сигнал** — сигнал, который прошёл все проверки стратегии и был бы "
        "опубликован, но в этот момент инструмент был занят. Сигналы ниже порога публикации и "
        "отложенные сюда не входят: сделкой они не стали бы и без правила.",
        "3. **Занятые закрытия H4** — сколько раз правило пропустило проверку инструмента. На "
        "большинстве таких свечей сигнала не было бы и так, поэтому подавленных сигналов "
        "намного меньше.",
        "4. **«Сам по себе»** — подавленный сигнал исполнен отдельно, теми же правилами "
        "исполнения, что и сделки бэктеста. Это гипотетический расчёт: он показывает, от чего "
        "правило отказывается, и не говорит, что так было бы выгоднее.",
        "5. **R** — результат сделки в долях риска (расстояния от входа до стопа), за вычетом "
        "комиссии и проскальзывания; округлён до 0.01.",
        "6. **Выборка мала.** Отчёт проверяет работу правила. О прибыльности стратегии он "
        "ничего не доказывает.",
        "",
    ]
    return "\n".join(out)


# --- запись ------------------------------------------------------------------------------------


def write_report(report: Report, out_dir: Path) -> list[Path]:
    """Пишет ``one_trade_report.md``, ``one_trade_report.csv``, ``one_trade_trades.csv`` и
    ``examples/*.png`` в ``out_dir``. Возвращает записанные файлы. Посторонние файлы каталога
    не трогает."""
    out_dir.mkdir(parents=True, exist_ok=True)
    files = {
        out_dir / REPORT_MD: render_markdown(report).encode("utf-8"),
        out_dir / REPORT_CSV: render_csv(report).encode("utf-8"),
        out_dir / TRADES_CSV: render_trades_csv(report).encode("utf-8"),
    }
    for example in report.examples:
        if example.chart is not None and example.chart_file is not None:
            files[out_dir / example.chart_file] = example.chart
    for path, data in files.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return list(files)
