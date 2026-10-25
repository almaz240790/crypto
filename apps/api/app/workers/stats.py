"""stats-worker (план 2.4): пересчёт снимков статистики по расписанию.

Отдельный процесс не обязателен — тот же пересчёт запускает уведомитель после закрытия
сигнала и раз в ``EVERY`` секунд. Этот модуль нужен для ручного прогона и как самостоятельный
сервис, если статистика станет тяжёлой.
"""

from __future__ import annotations

import argparse
import logging
import time

from app.db import SessionLocal
from app.snapshots import recompute

log = logging.getLogger("stats")
EVERY = 600


def once() -> int:
    with SessionLocal() as db:
        return recompute(db)


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    ap = argparse.ArgumentParser(description="пересчёт снимков статистики")
    ap.add_argument("--once", action="store_true", help="один прогон и выход")
    args = ap.parse_args()
    while True:
        try:
            once()
        except Exception:
            log.exception("пересчёт снимков")
        if args.once:
            return
        time.sleep(EVERY)


if __name__ == "__main__":
    main()
