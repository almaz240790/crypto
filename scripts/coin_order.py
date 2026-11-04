"""Снимок порядка монет по капитализации для STATIC_ORDER (apps/api/app/coin_rank.py) и
COIN_ORDER (apps/web/src/lib/coinRank.ts).

  uv run python scripts/coin_order.py                    # с CoinGecko, первые 300
  uv run python scripts/coin_order.py --json a.json b.json --top 300   # из сохранённых страниц

Печатает оба литерала и проверяет, что у инструментов из scripts/instruments_extended.txt есть
место. Код выхода 1, если какого-то нет (кроме MKR: у него нет капитализации в CoinGecko).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "api"))

from app.coin_rank import base_of, fetch_markets, order_from_markets

ROOT = Path(__file__).resolve().parents[1]
UNRANKED = {"MKR"}


def _lines(items: list[str], indent: str, per_line: int = 10) -> str:
    rows = [items[i : i + per_line] for i in range(0, len(items), per_line)]
    return "\n".join(indent + " ".join(f'"{x}",' for x in row) for row in rows)


def main() -> int:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--json", nargs="*", help="сохранённые страницы /coins/markets")
    p.add_argument("--top", type=int, default=300)
    a = p.parse_args()
    if a.json:
        markets = [m for f in a.json for m in json.loads(Path(f).read_text())]
    else:
        with httpx.Client() as client:
            markets = fetch_markets(client)
    order = order_from_markets(markets)[: a.top]
    print(
        "# fmt: off\nSTATIC_ORDER: tuple[str, ...] = (\n"
        + _lines(order, "    ")
        + "\n)\n# fmt: on\n"
    )
    print("export const COIN_ORDER: readonly string[] = [\n" + _lines(order, "  ") + "\n];\n")
    symbols = (ROOT / "scripts" / "instruments_extended.txt").read_text().split()
    missing = [s for s in symbols if s.endswith("USDT") and base_of(s) not in order]
    missing = [s for s in missing if base_of(s) not in UNRANKED]
    if missing:
        print("нет места:", ", ".join(missing), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
