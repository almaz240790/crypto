"""Отчёт по правилу «одна открытая сделка на инструмент и версию» (задача 6, пакет 2026-11-05).

  uv run python scripts/occupancy_report.py --strategy trend-ob-retest@1.2.0 \\
      --symbols-file scripts/instruments_extended.txt --from 2022-06-01 --to 2026-11-09 \\
      --out docs/backtests/2026-11-10-one-trade-1.2.0 [--data-dir DIR] [--check-backtest]

Движок оценивается на каждом закрытии H4 — так forward писал кандидатов до правила. Каждый
публикуемый кандидат (градация A–C, не отложен) исполняется ``simulate_trade`` по H4 с
комиссиями, как в бэктесте. Затем на поток кандидатов накладывается общее правило
``engine.occupancy`` (то же, что в ``run_backtest``, scheduler и forward): кандидат подавляется,
если на его закрытии инструмент занят принятой раньше сделкой. ``--check-backtest`` сверяет
принятые сделки со сделками ``run_backtest`` на тех же данных (движок считается второй раз).

Пишет ``<out>.md`` (сводка, разбивка по инструментам, таблица примеров), ``<out>.csv`` (все
подавленные кандидаты) и ``<out>/NN-SYMBOL-YYYYMMDDTHHMM.png`` (графики примеров,
``render_png`` из /debug). Данные — БД или CSV-выгрузки (``--data-dir``, как scripts/backtest.py).
Одинаковый вход даёт одинаковые файлы.
"""

from __future__ import annotations

import argparse
import io
import multiprocessing
import sys
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "api"))

import backtest as bt_script  # scripts/backtest.py: загрузка входов из БД или CSV

from app.debug import ACCENT, CONTEXT, DOWN, UP, WARN, render_png
from engine.backtest import (
    DEFAULT_EXECUTION,
    BacktestTrade,
    Metrics,
    TradeResult,
    backtest_span,
    run_backtest,
    simulate_trade,
    summarize,
)
from engine.candles import SIGNAL_TIMEFRAME, Candle
from engine.occupancy import TradeSpan, occupying
from engine.params import StrategyParams
from engine.scoring import Grade
from engine.signal import MarketInputs, SignalCandidate, evaluate
from engine.strategies import STRATEGIES
from engine.structure import Direction, analyze_structure
from engine.trade import TradeSetup
from engine.zones import analyze_zones

H4 = SIGNAL_TIMEFRAME.delta
PNG_COLORS = 48
"""Палитра PNG после сжатия: графики из нескольких цветов темы, 48 хватает без потерь вида."""
EXIT_CANDLE_SHARE = 4
"""Из каждых N примеров один — «свеча выхода» (сделка закрылась в той же свече H4), если есть."""
PAD_BEFORE, PAD_AFTER = 24, 12
"""Свечей H4 на графике до сигнала открытой сделки и после подавленного кандидата/выхода."""


@dataclass(frozen=True, slots=True)
class Candidate:
    symbol: str
    index: int
    """Номер сигнальной свечи в ряду H4 инструмента."""
    at: datetime
    direction: Direction
    grade: str
    score: int
    entry: Decimal
    stop: Decimal
    tp1: Decimal
    tp2: Decimal
    tp3: Decimal
    result: TradeResult
    exit_time: datetime | None
    setup: TradeSetup
    blocked_by: str | None = None
    """Время сигнала открытой сделки, из-за которой кандидат подавлен; None — принят."""

    def trade(self) -> BacktestTrade:
        return BacktestTrade(
            symbol=self.symbol,
            direction=self.direction,
            signal_time=self.at,
            grade=Grade(self.grade),
            score=self.score,
            rr_tp2=Decimal(0),
            entry=self.entry,
            stop=self.stop,
            tp1=self.tp1,
            tp2=self.tp2,
            tp3=self.tp3,
            result=self.result,
            exit_time=self.exit_time,
        )


@dataclass(slots=True)
class SymbolResult:
    symbol: str
    evaluated: int = 0
    candidates: list[Candidate] = field(default_factory=list)
    not_publishable: int = 0
    """Кандидаты ниже градации C и отложенные: бэктест их не торгует (forward пишет их как C)."""
    not_publishable_free: int = 0
    """Из них — на закрытиях, где инструмент свободен по правилу."""
    backtest_match: bool | None = None
    backtest_trades: int = 0


CONFIG: dict[str, object] = {}
"""Параметры прогона для процессов-обработчиков (fork наследует их от главного процесса)."""


def _params() -> StrategyParams:
    params = CONFIG["params"]
    assert isinstance(params, StrategyParams)
    return params


def _window() -> tuple[datetime, datetime]:
    start, end = CONFIG["start"], CONFIG["end"]
    assert isinstance(start, datetime) and isinstance(end, datetime)
    return start, end


def load(symbol: str) -> MarketInputs | None:
    start, end = _window()
    return bt_script.market_inputs(symbol, start, end, _params())


def analyse(symbol: str) -> SymbolResult:
    """Все закрытия H4 инструмента: кандидаты, их исполнение и правило одной сделки."""
    params = _params()
    start, end = _window()
    window = int(str(CONFIG["window"]))
    out = SymbolResult(symbol)
    inp = load(symbol)
    if inp is None:
        return out
    h4 = list(inp.h4)
    last: tuple[TradeSpan, ...] = ()
    for i, c in enumerate(h4):
        at = c.close_time(SIGNAL_TIMEFRAME)
        if at < start or at > end:
            continue
        out.evaluated += 1
        sliced = MarketInputs(
            symbol=symbol,
            h4=h4[max(0, i + 1 - window) : i + 1],
            d1=inp.d1,
            w1=inp.w1,
            funding=inp.funding,
            open_interest=inp.open_interest,
            long_short=inp.long_short,
        )
        res = evaluate(sliced, at, params)
        if not isinstance(res, SignalCandidate):
            continue
        busy = occupying(last, at)
        if res.deferred or not res.score.publishable:
            out.not_publishable += 1
            out.not_publishable_free += busy is None
            continue
        result = simulate_trade(res.trade, h4[i + 1 :], params.trade, DEFAULT_EXECUTION)
        exit_time = (
            h4[i + 1 + result.exit_index].close_time(SIGNAL_TIMEFRAME)
            if result.exit_index is not None
            else None
        )
        cand = Candidate(
            symbol,
            i,
            at,
            res.direction,
            res.score.grade.value,
            res.score.total,
            res.trade.entry_market,
            res.trade.stop_loss,
            res.trade.tp1,
            res.trade.tp2,
            res.trade.tp3,
            result,
            exit_time,
            res.trade,
            None if busy is None else busy.ref,
        )
        out.candidates.append(cand)
        if busy is None:
            span = backtest_span(cand.trade())
            if span is not None:
                last = (span,)
    if CONFIG.get("check_backtest"):
        run = run_backtest([inp], params, start, end, DEFAULT_EXECUTION, window=window)
        accepted = [x for x in out.candidates if x.blocked_by is None]
        out.backtest_trades = len(run.trades)
        out.backtest_match = [(t.signal_time, t.result, t.exit_time) for t in run.trades] == [
            (x.at, x.result, x.exit_time) for x in accepted
        ]
    print(
        f"{symbol}: оценено {out.evaluated}, кандидатов {len(out.candidates)}, подавлено "
        f"{sum(x.blocked_by is not None for x in out.candidates)}",
        file=sys.stderr,
        flush=True,
    )
    return out


# --- отчёт ----------------------------------------------------------------------------------------


def _fmt_r(x: Decimal | None) -> str:
    return "—" if x is None else f"{x:+.2f}"


def _pct(x: Decimal | None) -> str:
    return "—" if x is None else f"{x * 100:.1f} %"


def _t(t: datetime | None) -> str:
    return "—" if t is None else f"{t:%d.%m.%Y %H:%M}"


def _dir(d: Direction) -> str:
    return "лонг" if d is Direction.UP else "шорт"


def _metrics_rows(without: Metrics, with_rule: Metrics) -> list[str]:
    def row(name: str, a: str, b: str) -> str:
        return f"| {name} | {a} | {b} |"

    return [
        "| | Без правила (forward до задачи 6) | С правилом (бэктест, forward, live) |",
        "|---|---|---|",
        row("Сигналов", str(without.signals), str(with_rule.signals)),
        row("Закрыто", str(without.closed), str(with_rule.closed)),
        row("Открыто на конец периода", str(without.open), str(with_rule.open)),
        row("Доля прибыльных", _pct(without.winrate), _pct(with_rule.winrate)),
        row("Средний R", _fmt_r(without.avg_r), _fmt_r(with_rule.avg_r)),
        row(
            "PF",
            "—" if without.profit_factor is None else f"{without.profit_factor:.2f}",
            "—" if with_rule.profit_factor is None else f"{with_rule.profit_factor:.2f}",
        ),
        row("Сумма R", _fmt_r(without.sum_r), _fmt_r(with_rule.sum_r)),
        row("Просадка, R", f"{without.max_drawdown_r:.2f}", f"{with_rule.max_drawdown_r:.2f}"),
    ]


def _max_overlap(cands: Sequence[Candidate]) -> int:
    """Наибольшее число одновременно открытых сделок по одному инструменту."""
    best = 0
    by_symbol: dict[str, list[Candidate]] = {}
    for c in cands:
        by_symbol.setdefault(c.symbol, []).append(c)
    for items in by_symbol.values():
        for c in items:
            n = sum(
                1 for o in items if o.at <= c.at and (o.exit_time is None or o.exit_time >= c.at)
            )
            best = max(best, n)
    return best


def _blocker(c: Candidate, by_key: dict[tuple[str, str], Candidate]) -> Candidate:
    assert c.blocked_by is not None
    return by_key[(c.symbol, c.blocked_by)]


def _exit_candle(c: Candidate, b: Candidate) -> bool:
    """Сделка-блокировщик закрылась внутри свечи H4, которая закончилась на кандидате."""
    return b.exit_time is not None and c.at - H4 < b.exit_time <= c.at


def status_at(c: Candidate, b: Candidate, h4: list[Candle], params: StrategyParams) -> str:
    """Чем занят инструмент на закрытии кандидата: статус сделки ``b`` по свечам до ``c.at``."""
    if _exit_candle(c, b):
        return f"свеча выхода ({b.result.status.value} в {b.exit_time:%H:%M})"
    so_far = simulate_trade(b.setup, h4[b.index + 1 : c.index + 1], params.trade)
    return "открыта: " + ("active", "tp1_hit", "tp2_hit")[min(so_far.tp_hits, 2)]


def pick_examples(
    suppressed: Sequence[Candidate], blockers: dict[tuple[str, str], Candidate], n: int
) -> list[Candidate]:
    """Детерминированная выборка: каждый ``EXIT_CANDLE_SHARE``-й — случай «свеча выхода» (если
    есть), остальные — равномерно по времени, не больше двух подряд на инструмент."""
    ordered = sorted(suppressed, key=lambda c: (c.at, c.symbol))
    exit_cases = [c for c in ordered if _exit_candle(c, _blocker(c, blockers))]
    other = [c for c in ordered if c not in exit_cases]
    n_exit = min(len(exit_cases), max(1, n // EXIT_CANDLE_SHARE)) if exit_cases else 0

    def spread(items: list[Candidate], k: int) -> list[Candidate]:
        if k <= 0 or not items:
            return []
        if len(items) <= k:
            return list(items)
        step = len(items) / k
        return [items[int(i * step)] for i in range(k)]

    chosen = spread(exit_cases, n_exit) + spread(other, n - n_exit)
    return sorted(chosen, key=lambda c: (c.at, c.symbol))


def render_example(
    num: int, c: Candidate, b: Candidate, h4: list[Candle], params: StrategyParams, out_dir: Path
) -> str:
    """PNG примера: сделка-блокировщик (линии входа, стопа и тейков до выхода) и подавленный
    кандидат (его уровни пунктиром). Возвращает имя файла."""
    from PIL import Image

    end_idx = max(c.index, b.index + 1 + (b.result.exit_index or 0))
    first = max(0, b.index - PAD_BEFORE)
    last = min(len(h4) - 1, end_idx + PAD_AFTER)
    lo = max(0, first - CONTEXT)
    candles = h4[lo : last + 1]
    shift = lo
    structure = analyze_structure(candles, params.structure)
    zones = analyze_zones(candles, structure, params.zones)
    bi, ci = b.index - shift, c.index - shift
    bx = (
        (b.index + 1 + b.result.exit_index - shift)
        if b.result.exit_index is not None
        else len(candles) - 1
    )
    segments = [
        (bi, float(b.entry), bx, float(b.entry), ACCENT, "-"),
        (bi, float(b.stop), bx, float(b.stop), DOWN, "--"),
        (bi, float(b.tp1), bx, float(b.tp1), UP, ":"),
        (bi, float(b.tp2), bx, float(b.tp2), UP, ":"),
        (ci, float(c.entry), ci + PAD_AFTER // 2, float(c.entry), WARN, "-"),
        (ci, float(c.stop), ci + PAD_AFTER // 2, float(c.stop), WARN, "--"),
        (ci, float(c.tp1), ci + PAD_AFTER // 2, float(c.tp1), WARN, ":"),
    ]

    # render_png подписывает лонг под ценой метки, шорт и выход — над ней: метки ставятся на край
    # свечи, чтобы подписи кандидата и выхода на одной свече (случай «свеча выхода») не слились
    def edge(i: int, d: Direction, label_below: bool) -> Decimal:
        candle = candles[i]
        return candle.low if (d is Direction.UP) == label_below else candle.high

    bdir = "up" if b.direction is Direction.UP else "down"
    cdir = "up" if c.direction is Direction.UP else "down"
    marks = [
        (bi, bi, edge(bi, b.direction, True), "открытая сделка", bdir),
        (ci, ci, edge(ci, c.direction, True), "подавлен", cdir),
    ]
    if b.result.exit_index is not None:
        exit_price = edge(bx, c.direction, False)
        marks.append((bx, bx, exit_price, f"выход {b.result.status.value}", None))
    title = (
        f"{num:02d}. {c.symbol} H4 — кандидат {_t(c.at)} UTC ({_dir(c.direction)} {c.grade}) "
        f"подавлен: открыта сделка {_t(b.at)} ({_dir(b.direction)}), "
        f"выход {_t(b.exit_time)} {b.result.status.value}"
    )
    png = render_png(candles, structure, zones, last - first + 1, title, marks, segments)
    name = f"{num:02d}-{c.symbol}-{c.at:%Y%m%dT%H%M}.png"
    img = Image.open(io.BytesIO(png)).convert("RGB").quantize(colors=PNG_COLORS)
    img.save(out_dir / name, optimize=True)
    return name


def write_report(
    results: list[SymbolResult], args: argparse.Namespace, params: StrategyParams
) -> None:
    out: Path = args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    png_dir = out.parent / out.name
    png_dir.mkdir(parents=True, exist_ok=True)
    cands = sorted((c for r in results for c in r.candidates), key=lambda c: (c.at, c.symbol))
    accepted = [c for c in cands if c.blocked_by is None]
    suppressed = [c for c in cands if c.blocked_by is not None]
    by_key = {(c.symbol, c.at.isoformat()): c for c in accepted}
    without = summarize([c.trade() for c in cands])
    with_rule = summarize([c.trade() for c in accepted])
    supp_metrics = summarize([c.trade() for c in suppressed])
    exit_cases = [c for c in suppressed if _exit_candle(c, _blocker(c, by_key))]
    with_history = [r for r in results if r.evaluated]
    source = (
        f"CSV-каталог `{args.data_dir.name}` (публичные архивы Binance Data Vision)"
        if args.data_dir
        else "БД"
    )
    lines = [
        f"# Одна открытая сделка на инструмент и версию: {params.version}",
        "",
        f"Источник: {source}. Период закрытий H4: {args.start} – {args.end}. Инструментов: "
        f"{len(results)}, с историей в периоде: {len(with_history)}. Исполнение — по H4, "
        "`simulate_trade` с комиссией 0.05 % за сторону и проскальзыванием 0.03 % (как бэктест). "
        "Результаты на прошлых данных.",
        "",
        "## Как считалось",
        "",
        "- движок оценивается на каждом закрытии H4 — так forward писал кандидатов до правила;",
        "- публикуемые кандидаты (A–C, не отложенные) исполняются `simulate_trade`;",
        "- правило `engine.occupancy` подавляет кандидата, если на его закрытии у версии по "
        "инструменту есть сделка: открытая или закрывшаяся внутри этой свечи H4.",
    ]
    if args.check_backtest:
        ok = all(r.backtest_match for r in with_history)
        total = sum(r.backtest_trades for r in with_history)
        lines.append(
            f"- принятые сделки совпадают со сделками `run_backtest` на тех же данных: "
            f"**{'да' if ok else 'нет'}** ({total} сделок)."
        )
    lines += [
        "",
        "## Итог",
        "",
        *_metrics_rows(without, with_rule),
        "",
        f"Подавлено кандидатов: **{len(suppressed)}** из {len(cands)} "
        f"({_pct(Decimal(len(suppressed)) / len(cands) if cands else None)}); из них "
        f"{len(exit_cases)} — на закрытии свечи, внутри которой прежняя сделка закрылась.",
        f"Наибольшее число одновременно открытых сделок по одному инструменту: без правила "
        f"{_max_overlap(cands)}, с правилом {_max_overlap(accepted)}.",
        f"Подавленные кандидаты, если бы их взяли: закрыто {supp_metrics.closed}, доля прибыльных "
        f"{_pct(supp_metrics.winrate)}, средний R {_fmt_r(supp_metrics.avg_r)}, сумма R "
        f"{_fmt_r(supp_metrics.sum_r)}.",
        f"Непубликуемые кандидаты (ниже C) и отложенные: {sum(r.not_publishable for r in results)}"
        f", из них на свободных закрытиях {sum(r.not_publishable_free for r in results)}. "
        "Бэктест их не торгует; forward хранит их для анализа (план 2.7) с градацией C, "
        "инструмент они не занимают.",
        "",
        "## По инструментам (больше всего подавленных)",
        "",
        "| Инструмент | Оценено закрытий | Кандидатов | Принято | Подавлено |",
        "|---|---|---|---|---|",
    ]
    per_symbol = sorted(
        (r for r in with_history if r.candidates),
        key=lambda r: (-sum(c.blocked_by is not None for c in r.candidates), r.symbol),
    )
    for r in per_symbol[:15]:
        n_supp = sum(c.blocked_by is not None for c in r.candidates)
        lines.append(
            f"| {r.symbol} | {r.evaluated} | {len(r.candidates)} | "
            f"{len(r.candidates) - n_supp} | {n_supp} |"
        )
    examples = pick_examples(suppressed, by_key, args.examples)
    lines += [
        "",
        f"## {len(examples)} примеров",
        "",
        "«Почему не записан»: статус открытой сделки на момент кандидата (active — вход без "
        "тейков, tp1_hit/tp2_hit — тейки взяты, стоп в безубытке) или «свеча выхода» — сделка "
        "закрылась внутри свечи H4, которая закончилась на кандидате (её бэктест тоже "
        "пропускает). R — за вычетом комиссий.",
        "",
        "| # | Инструмент | Открытая сделка: сигнал → выход | Итог, R | Кандидат | Почему не "
        "записан | R кандидата, если бы взяли | График |",
        "|---|---|---|---|---|---|---|---|",
    ]
    h4_cache: dict[str, list[Candle]] = {}
    for num, c in enumerate(examples, 1):
        b = _blocker(c, by_key)
        if c.symbol not in h4_cache:
            inp = load(c.symbol)
            assert inp is not None
            h4_cache[c.symbol] = list(inp.h4)
        name = render_example(num, c, b, h4_cache[c.symbol], params, png_dir)
        why = status_at(c, b, h4_cache[c.symbol], params)
        lines.append(
            f"| {num} | {c.symbol} | {_t(b.at)} {_dir(b.direction)} {b.grade} → "
            f"{_t(b.exit_time)} {b.result.status.value} | {_fmt_r(b.result.realized_r)} | "
            f"{_t(c.at)} {_dir(c.direction)} {c.grade} | {why} | "
            f"{_fmt_r(c.result.realized_r)} {c.result.status.value} | "
            f"[{name}]({png_dir.name}/{name}) |"
        )
    (out.parent / f"{out.name}.md").write_text("\n".join(lines) + "\n")
    with (out.parent / f"{out.name}.csv").open("w") as f:
        f.write(
            "symbol,candidate_time,direction,grade,blocked_by_signal,blocker_exit,"
            "blocker_status,candidate_status,candidate_realized_r\n"
        )
        for c in suppressed:
            b = _blocker(c, by_key)
            f.write(
                f"{c.symbol},{c.at.isoformat()},{c.direction.value},{c.grade},"
                f"{b.at.isoformat()},{b.exit_time.isoformat() if b.exit_time else ''},"
                f"{b.result.status.value},{c.result.status.value},{c.result.realized_r:.4f}\n"
            )
    print(f"готово: {out.parent / f'{out.name}.md'}", flush=True)


def main() -> int:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--strategy", required=True, choices=sorted(STRATEGIES))
    p.add_argument("--symbols", nargs="*", default=[])
    p.add_argument("--symbols-file", type=Path)
    p.add_argument("--from", dest="start", type=date.fromisoformat, required=True)
    p.add_argument("--to", dest="end", type=date.fromisoformat, required=True)
    p.add_argument("--data-dir", type=Path, help="CSV-выгрузки вместо БД (как scripts/backtest.py)")
    p.add_argument("--window", type=int, default=700)
    p.add_argument("--examples", type=int, default=20)
    p.add_argument("--jobs", type=int, default=1, help="процессов для оценки инструментов")
    p.add_argument("--check-backtest", action="store_true", help="сверить с run_backtest")
    p.add_argument("--out", type=Path, required=True, help="путь без расширения")
    args = p.parse_args()

    symbols = list(args.symbols)
    if args.symbols_file:
        symbols += [
            s.strip()
            for s in args.symbols_file.read_text().splitlines()
            if s.strip() and not s.startswith("#")
        ]
    if not symbols:
        p.error("укажите --symbols или --symbols-file")
    bt_script.DATA_DIR = args.data_dir
    params = STRATEGIES[args.strategy]
    CONFIG.update(
        params=params,
        start=datetime(args.start.year, args.start.month, args.start.day, tzinfo=UTC),
        end=datetime(args.end.year, args.end.month, args.end.day, tzinfo=UTC),
        window=args.window,
        check_backtest=args.check_backtest,
    )
    if args.jobs > 1:
        with multiprocessing.get_context("fork").Pool(args.jobs) as pool:
            results = pool.map(analyse, symbols, chunksize=1)
    else:
        results = [analyse(s) for s in symbols]
    write_report(results, args, params)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
