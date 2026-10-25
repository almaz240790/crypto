"""Загрузка истории свечей Binance в БД (задача 0.3 плана).

Примеры:
  uv run python scripts/load_history.py --symbols BTCUSDT ETHUSDT --tf 4h 1d 1w --from 2022-01-01
  uv run python scripts/load_history.py --symbols-file scripts/instruments_mvp.txt \
      --tf 1m 4h 1d 1w --from 2022-01-01
  uv run python scripts/load_history.py --check-only --symbols BTCUSDT --tf 4h  # только проверка

Инструмент создаётся в таблице instruments, если его нет (tick/lot — из exchangeInfo).
После загрузки печатается отчёт о пропусках по каждой паре и таймфрейму;
код выхода 1, если пропуски есть.
"""

from __future__ import annotations

import argparse
import sys
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path

import httpx
from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "api"))

from app.db import SessionLocal
from app.models import Candle as CandleRow
from app.models import Instrument
from engine.candles import Candle, Timeframe, find_gaps
from engine.data.binance import BinanceHistory, Market

EXCHANGE_INFO = {
    "futures": "https://fapi.binance.com/fapi/v1/exchangeInfo",
    "spot": "https://api.binance.com/api/v3/exchangeInfo",
}


def ensure_instrument(session, symbol: str, market: Market, info: dict) -> Instrument:  # type: ignore[no-untyped-def]
    inst = session.scalar(
        select(Instrument).where(
            Instrument.exchange == "binance",
            Instrument.symbol == symbol,
            Instrument.market_type == market,
        )
    )
    if inst:
        return inst
    meta = info.get(symbol)
    if meta is None:
        raise SystemExit(f"{symbol}: нет в exchangeInfo ({market})")
    inst = Instrument(
        exchange="binance",
        symbol=symbol,
        base=meta["baseAsset"],
        quote=meta["quoteAsset"],
        market_type=market,
        tick_size=meta["tick_size"],
        lot_size=meta["lot_size"],
        min_notional=meta["min_notional"],
    )
    session.add(inst)
    session.flush()
    return inst


def load_exchange_info(market: Market) -> dict[str, dict]:  # type: ignore[type-arg]
    data = httpx.get(EXCHANGE_INFO[market], timeout=30).json()
    out: dict[str, dict] = {}  # type: ignore[type-arg]
    for s in data["symbols"]:
        filters = {f["filterType"]: f for f in s["filters"]}
        out[s["symbol"]] = {
            "baseAsset": s["baseAsset"],
            "quoteAsset": s["quoteAsset"],
            "tick_size": Decimal(filters["PRICE_FILTER"]["tickSize"]),
            "lot_size": Decimal(filters["LOT_SIZE"]["stepSize"]),
            "min_notional": Decimal(filters.get("MIN_NOTIONAL", {}).get("notional", "0")),
        }
    return out


def upsert_candles(session, instrument_id: int, tf: Timeframe, candles: list[Candle]) -> int:  # type: ignore[no-untyped-def]
    if not candles:
        return 0
    rows = [
        {
            "instrument_id": instrument_id,
            "timeframe": tf.value,
            "open_time": c.open_time,
            "open": c.open,
            "high": c.high,
            "low": c.low,
            "close": c.close,
            "volume": c.volume,
            "quote_volume": c.quote_volume,
            "trades": c.trades,
            "is_closed": True,
        }
        for c in candles
    ]
    for i in range(0, len(rows), 5000):
        stmt = insert(CandleRow).values(rows[i : i + 5000])
        stmt = stmt.on_conflict_do_update(
            index_elements=["instrument_id", "timeframe", "open_time"],
            set_={
                k: stmt.excluded[k]
                for k in ("open", "high", "low", "close", "volume", "quote_volume", "trades")
            },
        )
        session.execute(stmt)
    return len(rows)


def db_candles(session, instrument_id: int, tf: Timeframe) -> list[Candle]:  # type: ignore[no-untyped-def]
    rows = session.execute(
        text(
            "select open_time, open, high, low, close, volume, quote_volume, trades from candles "
            "where instrument_id=:i and timeframe=:tf order by open_time"
        ),
        {"i": instrument_id, "tf": tf.value},
    ).all()
    return [Candle(r[0].astimezone(UTC), r[1], r[2], r[3], r[4], r[5], r[6], r[7]) for r in rows]


def main() -> int:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--symbols", nargs="*", default=[])
    p.add_argument("--symbols-file", type=Path)
    p.add_argument(
        "--tf", nargs="+", default=["4h", "1d", "1w"], choices=[t.value for t in Timeframe]
    )
    p.add_argument("--market", default="futures", choices=["futures", "spot"])
    p.add_argument("--from", dest="start", type=date.fromisoformat, default=date(2022, 1, 1))
    p.add_argument("--to", dest="end", type=date.fromisoformat, default=datetime.now(tz=UTC).date())
    p.add_argument(
        "--check-only", action="store_true", help="не загружать, только проверить пропуски в БД"
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

    market: Market = args.market
    info = {} if args.check_only else load_exchange_info(market)
    history = BinanceHistory(market)
    has_gaps = False

    with SessionLocal() as session:
        for symbol in symbols:
            inst = (
                ensure_instrument(session, symbol, market, info)
                if not args.check_only
                else session.scalar(
                    select(Instrument).where(
                        Instrument.symbol == symbol, Instrument.market_type == market
                    )
                )
            )
            if inst is None:
                print(f"{symbol}: нет в БД, пропускаю")
                continue
            for tf_value in args.tf:
                tf = Timeframe(tf_value)
                if not args.check_only:
                    n = 0
                    for batch in history.iter_range(symbol, tf, args.start, args.end):
                        n += upsert_candles(session, inst.id, tf, batch)
                        session.flush()
                    print(f"{symbol} {tf.value}: загружено {n} свечей", flush=True)
                stored = db_candles(session, inst.id, tf)
                gaps = find_gaps(stored, tf)
                if gaps:
                    has_gaps = True
                    print(
                        f"{symbol} {tf.value}: ПРОПУСКИ {len(gaps)} — первые: {gaps[:3]}",
                        flush=True,
                    )
                else:
                    first = stored[0].open_time.date() if stored else None
                    print(
                        f"{symbol} {tf.value}: без пропусков, {len(stored)} свечей с {first}",
                        flush=True,
                    )
            session.commit()
    return 1 if has_gaps else 0


if __name__ == "__main__":
    raise SystemExit(main())
