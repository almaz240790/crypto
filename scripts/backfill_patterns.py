"""Бэкфилл свечных паттернов по истории (план 2A.10.4; задача 2B.11).

  uv run python scripts/backfill_patterns.py --symbols-file scripts/instruments_extended.txt \
      --tf 4h 1d 1w --from 2022-01-01

Пишет ``patterns`` (source=backfill), ``pattern_events``, ``pattern_outcomes``; в конце
пересчитывает агрегаты ``pattern_stats_snapshots``. Повторный запуск дубли не создаёт.
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import select

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "api"))

from app.db import SessionLocal
from app.figures import FIGURE_TFS
from app.figures import backfill as backfill_figures
from app.figures import recompute_stats as recompute_figure_stats
from app.models import Instrument
from app.patterns import BACKFILL_TFS, backfill, recompute_stats
from engine.candles import Timeframe

log = logging.getLogger("backfill_patterns")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbols", nargs="*")
    ap.add_argument("--symbols-file")
    ap.add_argument("--tf", nargs="*", default=[t.value for t in BACKFILL_TFS])
    ap.add_argument("--from", dest="since", default="2022-01-01")
    ap.add_argument("--no-stats", action="store_true")
    ap.add_argument("--figures", action="store_true", help="фигуры вместо свечных паттернов")
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    symbols: list[str] = list(a.symbols or [])
    if a.symbols_file:
        symbols += [x.strip() for x in Path(a.symbols_file).read_text().splitlines() if x.strip()]
    since = datetime.fromisoformat(a.since).replace(tzinfo=UTC)
    tfs = [Timeframe(t) for t in a.tf]
    total = {"patterns": 0, "outcomes": 0}
    started = time.monotonic()
    with SessionLocal() as db:
        q = select(Instrument).where(Instrument.market_type == "futures")
        if symbols:
            q = q.where(Instrument.symbol.in_(symbols))
        instruments = db.scalars(q.order_by(Instrument.symbol)).all()
        for inst in instruments:
            for tf in tfs:
                try:
                    if a.figures:
                        if tf not in FIGURE_TFS:
                            continue
                        r = backfill_figures(db, inst, tf, since=since)
                    else:
                        r = backfill(db, inst, tf, since=since)
                    db.commit()
                except Exception:
                    db.rollback()
                    log.exception("%s %s: ошибка", inst.symbol, tf.value)
                    continue
                total["patterns"] += r.get("patterns", r.get("new", 0))
                total["outcomes"] += r["outcomes"]
                log.info("%s %s: %s", inst.symbol, tf.value, r)
        if not a.no_stats:
            n = recompute_figure_stats(db) if a.figures else recompute_stats(db)
            db.commit()
            log.info("агрегаты: %d строк", n)
    log.info("готово за %.0f с: %s", time.monotonic() - started, total)


if __name__ == "__main__":
    main()
