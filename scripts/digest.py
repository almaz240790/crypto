"""Email-дайджест (план 3.11, задача 2.13).

  uv run python scripts/digest.py            # ежедневный; по понедельникам — ещё и недельный
  uv run python scripts/digest.py --period weekly

Дайджесты шлёт и уведомитель (``app.workers.notifier``, после 06:00 UTC), у которого на Railway
есть ключ почты. Этот скрипт — ручной или cron-запуск (``5 6 * * *`` UTC); повтор в тот же день
безопасен: одна отправка на пользователя и дату (notification_log). В production без ключа
почты скрипт ничего не делает и не отмечает дайджесты отправленными (ADR-0002).
"""

from __future__ import annotations

import argparse
import logging
import sys
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "api"))

from app.db import SessionLocal
from app.notify import mail_ready, run_digest


def main() -> int:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--period", choices=["daily", "weekly", "auto"], default="auto")
    args = p.parse_args()
    if not mail_ready():
        print("ключ почты не задан: пропуск, дайджест отправит уведомитель", flush=True)
        return 0
    now = datetime.now(tz=UTC)
    periods = (
        [args.period]
        if args.period != "auto"
        else (["daily", "weekly"] if now.weekday() == 0 else ["daily"])
    )
    with SessionLocal() as db:
        for period in periods:
            n = run_digest(db, period, now)
            print(f"{period}: отправлено {n}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
