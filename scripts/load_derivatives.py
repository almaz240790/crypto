"""Загрузка истории funding, OI и long/short с Binance USDT-M в БД (задача 1.5a).

  uv run python scripts/load_derivatives.py --symbols-file scripts/instruments_mvp.txt \
      --from 2022-01-01
  uv run python scripts/load_derivatives.py --symbols BTCUSDT --what funding

Возобновляемый: для каждого инструмента начинает с дня после последней записи в БД.
Дни без архива (пара ещё не торговалась) пропускаются и считаются в отчёте.
Ликвидации историей не загружаются (архивов нет) — см. engine/data/binance_derivatives.py.
"""

from __future__ import annotations

import argparse
import sys
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "api"))

from app.db import SessionLocal
from app.models import Instrument
from app.models.derivatives import FundingRateRow, LongShortRatioRow, OpenInterestRow
from engine.data.binance_derivatives import BinanceDerivativesHistory, MetricsSample
from engine.derivatives import FundingRate


def _last_time(session, table: str, col: str, instrument_id: int) -> datetime | None:  # type: ignore[no-untyped-def]
    value = session.execute(
        text(f"select max({col}) from {table} where instrument_id = :i"), {"i": instrument_id}
    ).scalar()
    return value.astimezone(UTC) if value else None


def upsert_funding(session, instrument_id: int, rows: list[FundingRate]) -> int:  # type: ignore[no-untyped-def]
    if not rows:
        return 0
    stmt = insert(FundingRateRow).values(
        [{"instrument_id": instrument_id, "funding_time": r.time, "rate": r.rate} for r in rows]
    )
    session.execute(
        stmt.on_conflict_do_update(
            index_elements=["instrument_id", "funding_time"], set_={"rate": stmt.excluded.rate}
        )
    )
    return len(rows)


def upsert_metrics(session, instrument_id: int, rows: list[MetricsSample]) -> int:  # type: ignore[no-untyped-def]
    if not rows:
        return 0
    oi = insert(OpenInterestRow).values(
        [
            {
                "instrument_id": instrument_id,
                "time": r.time,
                "oi_contracts": r.oi_contracts,
                "oi_quote": r.oi_quote,
            }
            for r in rows
        ]
    )
    session.execute(
        oi.on_conflict_do_update(
            index_elements=["instrument_id", "time"],
            set_={"oi_contracts": oi.excluded.oi_contracts, "oi_quote": oi.excluded.oi_quote},
        )
    )
    with_ratios = [r for r in rows if r.has_ratios]
    if not with_ratios:
        return len(rows)
    ls = insert(LongShortRatioRow).values(
        [
            {
                "instrument_id": instrument_id,
                "time": r.time,
                "top_traders_ratio": r.top_traders_ratio,
                "global_ratio": r.global_ratio,
                "taker_ratio": r.taker_ratio,
            }
            for r in with_ratios
        ]
    )
    session.execute(
        ls.on_conflict_do_update(
            index_elements=["instrument_id", "time"],
            set_={
                "top_traders_ratio": ls.excluded.top_traders_ratio,
                "global_ratio": ls.excluded.global_ratio,
                "taker_ratio": ls.excluded.taker_ratio,
            },
        )
    )
    return len(rows)


def main() -> int:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--symbols", nargs="*", default=[])
    p.add_argument("--symbols-file", type=Path)
    p.add_argument(
        "--what", nargs="+", default=["funding", "metrics"], choices=["funding", "metrics"]
    )
    p.add_argument("--from", dest="start", type=date.fromisoformat, default=date(2022, 1, 1))
    p.add_argument(
        "--to",
        dest="end",
        type=date.fromisoformat,
        default=datetime.now(tz=UTC).date() - timedelta(days=1),
    )
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

    history = BinanceDerivativesHistory()
    with SessionLocal() as session:
        for symbol in symbols:
            inst = session.scalar(
                select(Instrument).where(
                    Instrument.symbol == symbol, Instrument.market_type == "futures"
                )
            )
            if inst is None:
                print(f"{symbol}: нет в instruments — сначала scripts/load_history.py", flush=True)
                continue
            if "funding" in args.what:
                last = _last_time(session, "funding_rates", "funding_time", inst.id)
                start = max(args.start, last.date()) if last else args.start
                n = sum(
                    upsert_funding(session, inst.id, batch)
                    for batch in history.iter_funding(symbol, start, args.end)
                )
                session.commit()
                print(f"{symbol} funding: +{n} записей с {start}", flush=True)
            if "metrics" in args.what:
                last = _last_time(session, "open_interest", "time", inst.id)
                start = max(args.start, last.date() + timedelta(days=1)) if last else args.start
                n = missing = 0
                for day, rows in history.iter_metrics(symbol, start, args.end):
                    if rows is None:
                        missing += 1
                        continue
                    n += upsert_metrics(session, inst.id, rows)
                    if day.day == 1:
                        session.commit()
                        print(f"{symbol} metrics: {day} (+{n})", flush=True)
                session.commit()
                print(
                    f"{symbol} metrics: +{n} часовых записей с {start}, дней без архива: {missing}",
                    flush=True,
                )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
