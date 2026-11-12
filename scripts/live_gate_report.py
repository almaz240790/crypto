"""Отчёт «готовность к live» по версии стратегии и списку инструментов (задача 9 пакета
«Сигналы») — только чтение.

  uv run python scripts/live_gate_report.py --version 1.2.0 --symbols mvp20 \
      --since 2026-10-26 --to 2026-10-26 --now 2027-02-01 --reconcile-json reconcile.json
  uv run python scripts/live_gate_report.py --version 1.2.1 --to 2026-10-26 --now 2026-11-01 \
      --out /tmp/live-gate-1.2.1.md

Пишет один Markdown-файл (по умолчанию ``docs/backtests/<дата --now>-live-gate-<версия>.md``):
форвард из БД (опубликованные форвард-сигналы версии по инструментам списка, каждый пересчитан
1m-трекером и H4-эталоном — ``app.retrack``), бэктест той же версии на том же списке
(загрузчики ``scripts/backtest.py``, ``engine.backtest.run_backtest``), бутстреп-интервал
среднего R, скользящие окна, таблицу критериев плана и отличия форварда от бэктеста.

Список инструментов (``--symbols``): ``mvp20`` — ``scripts/instruments_mvp.txt``; ``all`` —
активные фьючерсы из БД; иначе — путь к файлу со списком. По умолчанию — список версии
(``StrategyParams.symbols``), а у версии без списка — ``all``. У версии со своим списком из
переданного отбрасывается всё, чего в её списке нет: вне списка версия сигналов не выпускает.

Время:
  --from   начало бэктеста (дата, UTC; по умолчанию 2022-06-01);
  --to     конец бэктеста — последнее закрытие H4, на котором ищется сигнал (обязателен);
  --now    момент отчёта (по умолчанию равен --to): форвард-сигналы и свечи позже него не
           читаются, сделка, не закрывшаяся к нему, показана открытой. Если закрытые свечи H4
           в БД кончаются раньше, форвард считается до последней из них, и отчёт это пишет;
  --since  начало форварда. По умолчанию — переход версии в форвард по журналу заявок на смену
           статуса (а у версии, созданной сразу в форварде до задачи 4, — создание строки).
           Раньше перехода --since начало не уводит; версия, которая в форвард не переходила,
           получает «не выполнено» в пункте о длине форварда.
Текущее время не используется нигде, бутстреп идёт от зерна (``--seed``): при тех же данных и
аргументах файл совпадает байт в байт.

Итог ежедневной сверки (задача 8) — необязательно: ``--reconcile-json`` (JSON из Redis
``reconcile:last`` или вывод ``scripts/reconcile.py --json``) или ``--reconcile-redis`` (читает
ключ по ``REDIS_URL``). Без него пункт «нет расхождений в сверке» — «нужно решение человека».

В БД ничего не пишет: форвард читается в транзакции только на чтение, бэктест — запросами
``SELECT``. На production скрипт запускает человек (форвард-строки доступны только admin).
Числа отчёта — результаты на прошлых данных.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from datetime import UTC, date, datetime
from functools import partial
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "api"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import backtest
from sqlalchemy import Connection, text

from app.live_gate_report import (
    DEFAULT_SAMPLES,
    DEFAULT_SEED,
    DEFAULT_WINDOW,
    GateOptions,
    Report,
    analyze,
    build_forward,
    parse_reconcile,
    render_markdown,
    report_name,
    resolve_version,
    run_backtests,
    write_report,
)
from app.retrack import DEFAULT_MAX_GAP_MINUTES, read_only_connection
from engine.signal import MarketInputs
from engine.strategies import STRATEGIES

ROOT = Path(__file__).resolve().parents[1]
MVP_FILE = ROOT / "scripts" / "instruments_mvp.txt"
DEFAULT_START = "2022-06-01"


def load_symbol(symbol: str, *, options: GateOptions) -> MarketInputs | None:
    """Вход инструмента загрузчиками бэктеста: те же окна, свечи — только до ``options.now``.
    Функция уровня модуля — чтобы её можно было передать в процессы ``--jobs``."""
    return backtest.load_inputs(
        symbol, options.params, options.start, options.end, data_end=options.now
    )


def read_symbols(path: Path) -> list[str]:
    return [
        s.strip()
        for s in path.read_text().splitlines()
        if s.strip() and not s.strip().startswith("#")
    ]


def active_symbols(conn: Connection) -> list[str]:
    """Активные фьючерсы в БД — список ``all``."""
    rows = conn.execute(
        text(
            "select symbol from instruments where market_type = 'futures' and is_active "
            "order by symbol"
        )
    ).all()
    return [r[0] for r in rows]


def _utc(value: str) -> datetime:
    """ISO-дата или дата со временем; без часового пояса — UTC."""
    t = datetime.fromisoformat(value)
    return t.replace(tzinfo=UTC) if t.tzinfo is None else t.astimezone(UTC)


def _day(value: str) -> datetime:
    day = date.fromisoformat(value)
    return datetime(day.year, day.month, day.day, tzinfo=UTC)


def _positive(value: str) -> int:
    n = int(value)
    if n < 1:
        raise argparse.ArgumentTypeError("ожидается число не меньше 1")
    return n


def _arg_time(t: datetime) -> str:
    return f"{t:%Y-%m-%d}" if t.hour == t.minute == t.second == 0 else f"{t:%Y-%m-%dT%H:%M}"


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--version", required=True, help="версия: 1.2.0 или trend-ob-retest@1.2.0")
    p.add_argument(
        "--symbols",
        help="mvp20, all или путь к файлу; по умолчанию — список версии, а без него — all",
    )
    p.add_argument("--from", dest="start", type=_day, default=_day(DEFAULT_START))
    p.add_argument("--to", dest="end", type=_utc, required=True, help="конец бэктеста (UTC)")
    p.add_argument("--now", type=_utc, help="момент отчёта; по умолчанию --to")
    p.add_argument(
        "--since", type=_utc, help="начало форварда; по умолчанию — переход версии в форвард"
    )
    p.add_argument("--out", type=Path, help="файл отчёта; по умолчанию docs/backtests/...")
    p.add_argument("--jobs", type=_positive, default=1, help="процессов для бэктеста (1)")
    p.add_argument("--bootstrap", type=_positive, default=DEFAULT_SAMPLES, help="выборок")
    p.add_argument("--seed", type=int, default=DEFAULT_SEED, help="зерно бутстрепа")
    p.add_argument("--window", type=_positive, default=DEFAULT_WINDOW, help=argparse.SUPPRESS)
    p.add_argument("--max-gap-minutes", type=int, default=DEFAULT_MAX_GAP_MINUTES)
    source = p.add_mutually_exclusive_group()
    source.add_argument("--reconcile-json", type=Path, help="итог сверки (JSON reconcile:last)")
    source.add_argument(
        "--reconcile-redis", action="store_true", help="прочитать reconcile:last из Redis"
    )
    return p.parse_args(argv)


def load_reconcile(args: argparse.Namespace) -> tuple[dict[str, Any] | None, str]:
    if args.reconcile_json is not None:
        raw = json.loads(args.reconcile_json.read_text())
        return raw, f"файл `{args.reconcile_json.name}`"
    if args.reconcile_redis:
        import redis

        from app.config import settings
        from app.monitor import RECONCILE_KEY

        r = redis.from_url(settings.redis_url, socket_timeout=5)
        try:
            value = r.get(RECONCILE_KEY)
        finally:
            r.close()
        return (json.loads(value) if value else None), f"Redis `{RECONCILE_KEY}`"
    return None, ""


def command_line(args: argparse.Namespace, version: str, symbols_arg: str | None) -> str:
    parts = [
        "uv run python scripts/live_gate_report.py",
        f"--version {version.rsplit('@', 1)[-1]}",
    ]
    if symbols_arg:
        parts.append(f"--symbols {symbols_arg}")
    parts += [f"--from {_arg_time(args.start)}", f"--to {_arg_time(args.end)}"]
    if args.now is not None:
        parts.append(f"--now {_arg_time(args.now)}")
    if args.since is not None:
        parts.append(f"--since {_arg_time(args.since)}")
    if args.bootstrap != DEFAULT_SAMPLES:
        parts.append(f"--bootstrap {args.bootstrap}")
    if args.seed != DEFAULT_SEED:
        parts.append(f"--seed {args.seed}")
    if args.max_gap_minutes != DEFAULT_MAX_GAP_MINUTES:
        parts.append(f"--max-gap-minutes {args.max_gap_minutes}")
    if args.reconcile_json is not None:
        parts.append(f"--reconcile-json {args.reconcile_json.name}")
    if args.reconcile_redis:
        parts.append("--reconcile-redis")
    return " \\\n    ".join(parts)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        version = resolve_version(args.version)
    except ValueError as exc:
        print(f"ошибка: {exc}", file=sys.stderr, flush=True)
        return 2
    params = STRATEGIES[version]
    now = args.now or args.end
    raw_reconcile, reconcile_source = load_reconcile(args)
    with read_only_connection() as conn:
        if args.symbols is None:
            label = "список версии" if params.symbols is not None else "all — активные в БД"
            symbols = list(params.symbols) if params.symbols is not None else active_symbols(conn)
        elif args.symbols == "mvp20":
            label, symbols = "mvp20 (`scripts/instruments_mvp.txt`)", read_symbols(MVP_FILE)
        elif args.symbols == "all":
            label, symbols = "all — активные в БД", active_symbols(conn)
        else:
            path = Path(args.symbols)
            label, symbols = f"файл `{path.name}`", read_symbols(path)
        symbols, dropped = backtest.version_symbols(params, list(dict.fromkeys(symbols)))
        try:
            options = GateOptions(
                version=version,
                symbols=tuple(symbols),
                symbols_label=label,
                start=args.start,
                end=args.end,
                now=now,
                since=args.since,
                samples=args.bootstrap,
                seed=args.seed,
                window=args.window,
                max_gap_minutes=args.max_gap_minutes,
                command=command_line(args, version, args.symbols),
            )
            forward = build_forward(
                conn, version, options.symbols, now, args.since, args.max_gap_minutes
            )
        except ValueError as exc:
            print(f"ошибка: {exc}", file=sys.stderr, flush=True)
            return 2
    if dropped:
        print(
            f"нет в списке версии {version}, пропущены: {', '.join(dropped)}",
            file=sys.stderr,
            flush=True,
        )
    bt = run_backtests(options.symbols, partial(load_symbol, options=options), options, args.jobs)
    report = Report(
        options,
        forward,
        bt,
        parse_reconcile(raw_reconcile, reconcile_source),
        tuple(dropped),
    )
    analysis = analyze(report)
    out = args.out or ROOT / "docs" / "backtests" / report_name(version, now)
    write_report(render_markdown(report, analysis), out)
    m = analysis.backtest
    print(
        f"бэктест: инструментов {len(bt.runs)}, сделок {m.signals}, закрыто {m.closed}; "
        f"форвард-сигналов: {len(forward.signals)}; критериев: {len(analysis.criteria)}",
        flush=True,
    )
    print(out, flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
