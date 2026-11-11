"""Отчёт пересчёта форвард-сигналов исправленным трекером — только чтение (задача 7).

  uv run python scripts/retrack_report.py --since 2026-10-26 --out /tmp/retrack
  uv run python scripts/retrack_report.py --since 2026-10-26 --out /tmp/retrack \
      --version 1.0.0 1.1.0 --max-gap-minutes 30 --now 2026-11-11T12:00

Пересчитывает уже записанные форвард-сигналы (``signals.scope = 'forward'``, любые версии, в
том числе архивные) и пишет в каталог ``--out``:

  retrack_report.md    отчёт для владельца: «было / стало», сравнение 1m и H4, итоги по версиям
  retrack_report.csv   те же строки для таблицы
  signals/*.png        график по каждому сигналу

В БД ничего не пишет: соединение открывается транзакцией только на чтение
(``SET TRANSACTION ... READ ONLY``), запись в ней невозможна. Live-сигналы не читаются.

Отчёт воспроизводим: при тех же данных и том же ``--now`` файлы совпадают байт в байт. Без
``--now`` моментом отчёта считается текущее время, и оно указано в шапке отчёта.

В отчёте построчные данные форварда: в репозиторий его не кладут. На production скрипт
запускает человек.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from datetime import UTC, date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "api"))

from app.retrack import DEFAULT_MAX_GAP_MINUTES
from app.retrack_report import ReportOptions, UnknownVersionError, run_report


def _utc(value: str) -> datetime:
    """ISO-дата или дата со временем; без часового пояса — UTC."""
    t = datetime.fromisoformat(value)
    return t.replace(tzinfo=UTC) if t.tzinfo is None else t.astimezone(UTC)


def _since(value: str) -> datetime:
    day = date.fromisoformat(value)
    return datetime(day.year, day.month, day.day, tzinfo=UTC)


def _non_negative(value: str) -> int:
    n = int(value)
    if n < 0:
        raise argparse.ArgumentTypeError("ожидается число не меньше 0")
    return n


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument(
        "--since",
        type=_since,
        required=True,
        help="сигналы с закрытием сигнальной свечи не раньше этой даты (UTC), например 2026-10-26",
    )
    p.add_argument("--out", type=Path, required=True, help="каталог для файлов отчёта")
    p.add_argument(
        "--version",
        nargs="+",
        action="extend",
        default=[],
        help="только эти версии: 1.0.0 или стратегия@1.0.0; по умолчанию — все",
    )
    p.add_argument(
        "--max-gap-minutes",
        type=_non_negative,
        default=DEFAULT_MAX_GAP_MINUTES,
        help="самый длинный допустимый пропуск 1m-свечей подряд, мин; при большем сигнал "
        f"помечается «не пересчитан» (по умолчанию {DEFAULT_MAX_GAP_MINUTES}; 0 — любой пропуск)",
    )
    p.add_argument(
        "--now",
        type=_utc,
        help="момент отчёта, ISO (UTC): свечи позже него не читаются; по умолчанию — сейчас",
    )
    p.add_argument("--no-png", action="store_true", help="не рисовать графики сигналов")
    return p.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    options = ReportOptions(
        since=args.since,
        now=args.now or datetime.now(tz=UTC).replace(second=0, microsecond=0),
        versions=tuple(args.version),
        max_gap_minutes=args.max_gap_minutes,
        charts=not args.no_png,
    )
    try:
        report, files = run_report(options, args.out)
    except UnknownVersionError as exc:
        print(f"ошибка: {exc}", file=sys.stderr, flush=True)
        return 2
    rows = report.signals
    print(
        f"сигналов: {len(rows)}; пересчитано по 1m: {sum(1 for r in rows if r.new is not None)}; "
        f"не пересчитано: {sum(1 for r in rows if r.new is None)}; файлов: {len(files)}",
        flush=True,
    )
    for path in files[:2]:
        print(path, flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
