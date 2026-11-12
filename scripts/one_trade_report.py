"""Отчёт для владельца: что подавляет правило «одна открытая сделка на инструмент и версию»
(задача 6 пакета «Сигналы», требование 6) — только чтение.

  uv run python scripts/one_trade_report.py --strategy trend-ob-retest@1.2.0 \
      --symbols-file scripts/instruments_extended.txt --from 2022-06-01 --to 2026-10-25 \
      --out /tmp/one-trade-1.2.0
  uv run python scripts/one_trade_report.py --strategy trend-ob-retest@1.0.0 \
      --symbols BTCUSDT XLMUSDT --to 2026-11-01 --examples 10 --out /tmp/one-trade-1.0.0

Прогоняет бэктест версии по списку инструментов (свечи и деривативы — теми же загрузчиками, что
``scripts/backtest.py``) и пишет в каталог ``--out``:

  one_trade_report.md    отчёт для владельца: сколько сигналов правило подавило — по причине
                         (сделка ещё открыта / свеча выхода), направлению и инструменту; итог
                         «с правилом / гипотетически без него»; примеры простым языком
  one_trade_report.csv   все подавленные сигналы, по строке на сигнал
  one_trade_trades.csv   сделки с правилом — тот же список, что даёт бэктест (для сверки)
  examples/*.png         график по каждому примеру (по умолчанию 20)

В БД ничего не пишет и прогон в ``backtest_runs`` не сохраняет. Числа — результаты на прошлых
данных.

Отчёт воспроизводим: при тех же данных и тех же аргументах файлы совпадают байт в байт.
Текущее время не используется нигде: ``--to`` обязателен, а данные ограничены ``--now`` (по
умолчанию равен ``--to``) — свечи, не закрытые к этому моменту, не читаются. Сделка, не
закрывшаяся к ``--now``, показана открытой. Чтобы последние сделки периода успели закрыться,
как в ``scripts/backtest.py`` (там хвост 30 дней), задайте ``--now`` позже ``--to``.

Считается рыночный вход — единственный, который сейчас используется. В отчёте построчные
данные прогона: в репозиторий его не кладут. На production скрипт запускает человек.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from datetime import UTC, date, datetime
from functools import partial
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "api"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import backtest

from app.one_trade_report import (
    DEFAULT_EXAMPLES,
    DEFAULT_WINDOW,
    ReportOptions,
    build_report,
    write_report,
)
from engine.signal import MarketInputs
from engine.strategies import STRATEGIES


def load_symbol(
    symbol: str, *, options: ReportOptions, derivatives: bool, data_dir: Path | None
) -> MarketInputs | None:
    """Вход инструмента загрузчиками бэктеста: те же окна, но свечи — только до ``options.now``.
    Функция уровня модуля — чтобы её можно было передать в процессы ``--jobs``."""
    backtest.DATA_DIR = data_dir
    return backtest.load_inputs(
        symbol,
        options.params,
        options.start,
        options.end,
        data_end=options.now,
        derivatives=derivatives,
    )


def _utc(value: str) -> datetime:
    """ISO-дата или дата со временем; без часового пояса — UTC."""
    t = datetime.fromisoformat(value)
    return t.replace(tzinfo=UTC) if t.tzinfo is None else t.astimezone(UTC)


def _day(value: str) -> datetime:
    day = date.fromisoformat(value)
    return datetime(day.year, day.month, day.day, tzinfo=UTC)


def _non_negative(value: str) -> int:
    n = int(value)
    if n < 0:
        raise argparse.ArgumentTypeError("ожидается число не меньше 0")
    return n


def _positive(value: str) -> int:
    n = int(value)
    if n < 1:
        raise argparse.ArgumentTypeError("ожидается число не меньше 1")
    return n


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument(
        "--strategy",
        required=True,
        choices=sorted(STRATEGIES),
        help="версия стратегии из реестра (engine.strategies)",
    )
    p.add_argument("--symbols", nargs="*", default=[], help="инструменты, например BTCUSDT")
    p.add_argument("--symbols-file", type=Path, help="файл со списком инструментов")
    p.add_argument(
        "--from",
        dest="start",
        type=_day,
        default=_day("2022-06-01"),
        help="начало периода, дата (UTC); по умолчанию 2022-06-01",
    )
    p.add_argument(
        "--to",
        dest="end",
        type=_utc,
        required=True,
        help="конец периода (UTC): последнее закрытие H4, на котором ищется сигнал",
    )
    p.add_argument(
        "--now",
        type=_utc,
        help="граница данных (UTC): свечи, не закрытые к этому моменту, не читаются; "
        "по умолчанию равна --to",
    )
    p.add_argument("--out", type=Path, required=True, help="каталог для файлов отчёта")
    p.add_argument(
        "--examples",
        type=_non_negative,
        default=DEFAULT_EXAMPLES,
        help=f"сколько примеров с графиком показать (по умолчанию {DEFAULT_EXAMPLES})",
    )
    p.add_argument(
        "--window",
        type=int,
        default=DEFAULT_WINDOW,
        help=f"сколько последних свечей H4 видит расчёт сигнала (по умолчанию {DEFAULT_WINDOW})",
    )
    p.add_argument(
        "--jobs",
        type=_positive,
        default=1,
        help="в скольких процессах считать инструменты (по умолчанию 1); на результат не влияет",
    )
    p.add_argument("--no-png", action="store_true", help="не рисовать графики примеров")
    p.add_argument(
        "--no-derivatives", action="store_true", help="не использовать funding/OI/long-short"
    )
    p.add_argument(
        "--data-dir", type=Path, help="читать CSV-выгрузки вместо БД (как scripts/backtest.py)"
    )
    return p.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    symbols = list(args.symbols)
    if args.symbols_file:
        symbols += [
            s.strip()
            for s in args.symbols_file.read_text().splitlines()
            if s.strip() and not s.startswith("#")
        ]
    try:
        options = ReportOptions(
            version=args.strategy,
            start=args.start,
            end=args.end,
            now=args.now or args.end,
            examples=args.examples,
            window=args.window,
            charts=not args.no_png,
        )
    except ValueError as exc:
        print(f"ошибка: {exc}", file=sys.stderr, flush=True)
        return 2
    # у версии со своим списком инструментов (StrategyParams.symbols) — только её пары, как у
    # scripts/backtest.py: вне списка версия сигналов не выпускает
    symbols, dropped = backtest.version_symbols(options.params, symbols)
    if dropped:
        print(
            f"нет в списке версии {options.version}, пропущены: {', '.join(dropped)}",
            file=sys.stderr,
            flush=True,
        )
    if not symbols:
        print("ошибка: укажите --symbols или --symbols-file", file=sys.stderr, flush=True)
        return 2
    load = partial(
        load_symbol, options=options, derivatives=not args.no_derivatives, data_dir=args.data_dir
    )
    report = build_report(symbols, load, options, jobs=args.jobs)
    files = write_report(report, args.out)
    print(
        f"инструментов: {len(report.symbols)}; сделок: {len(report.trades)}; "
        f"занятых закрытий H4: {sum(s.busy for s in report.symbols)}; "
        f"подавленных сигналов: {len(report.suppressed)}; примеров: {len(report.examples)}; "
        f"файлов: {len(files)}",
        flush=True,
    )
    for path in files:
        if path.suffix != ".png":
            print(path, flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
