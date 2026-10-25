"""Форвард-тест: один прогон на момент последнего закрытия H4 (задача 1.11).

  uv run python scripts/forward.py                 # все активные инструменты, с догрузкой данных
  uv run python scripts/forward.py --symbols BTCUSDT ETHUSDT --no-refresh

На Railway запускается cron-сервисом ``2 */4 * * *`` (UTC). Повторный запуск безопасен.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "api"))

from app.forward import run_forward


def main() -> int:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--symbols", nargs="*")
    p.add_argument("--no-refresh", action="store_true", help="не догружать данные по REST")
    p.add_argument(
        "--no-track", action="store_true", help="не вести сигналы по H4 (их ведёт 1m-трекер)"
    )
    args = p.parse_args()
    stats = run_forward(args.symbols or None, refresh=not args.no_refresh, track=not args.no_track)
    print(f"готово: {stats}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
