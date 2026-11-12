"""Сверка записанных сигналов с офлайн-пересчётом — разовый запуск, только чтение (задача 8).

  uv run python scripts/reconcile.py              # последние 7 дней и все открытые сделки
  uv run python scripts/reconcile.py --days 14 --json

То же самое раз в сутки делает уведомитель (``app.workers.notifier``); скрипт — чтобы посмотреть
расхождения сразу. В БД ничего не пишет и итог в Redis не кладёт. Код возврата: 0 — критичных
расхождений нет, 1 — есть.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "api"))

from app.reconcile import DEFAULT_DAYS, DEFAULT_R_TOLERANCE, run_reconcile
from app.retrack import DEFAULT_MAX_GAP_MINUTES, read_only_connection


def main() -> int:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--days", type=int, default=DEFAULT_DAYS, help="за сколько дней сверять")
    p.add_argument(
        "--r-tolerance",
        type=Decimal,
        default=DEFAULT_R_TOLERANCE,
        help="порог |ΔR| между записью и эталоном H4",
    )
    p.add_argument(
        "--max-gap-minutes",
        type=int,
        default=DEFAULT_MAX_GAP_MINUTES,
        help="самый длинный допустимый пропуск 1m-свечей подряд",
    )
    p.add_argument("--json", action="store_true", help="итог в JSON, как его видит монитор")
    args = p.parse_args()
    with read_only_connection() as conn:
        report = run_reconcile(
            conn, datetime.now(tz=UTC), args.days, args.r_tolerance, args.max_gap_minutes
        )
    if args.json:
        print(json.dumps(report.to_json(), ensure_ascii=False, indent=2))
    else:
        print(report.summary())
        for line in report.lines():
            print(" -", line)
        for line in report.unchecked:
            print(" · не сверено:", line)
    return 1 if report.critical else 0


if __name__ == "__main__":
    raise SystemExit(main())
