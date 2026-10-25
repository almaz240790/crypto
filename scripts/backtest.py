"""Бэктест стратегии на данных из БД (задача 1.9).

  uv run python scripts/backtest.py --symbols BTCUSDT ETHUSDT --from 2024-01-01 --to 2025-01-01
  uv run python scripts/backtest.py --symbols-file scripts/instruments_mvp.txt --from 2022-06-01

Печатает сводку метрик (JSON), разбивки по градации, инструменту и году, список сделок (CSV
в stdout при --trades). Исполнение — по свечам H4 (1m пока не загружены), правило «стоп
приоритетнее тейка в одной свече» делает оценку консервативной.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import asdict
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from pathlib import Path

from sqlalchemy import text

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "api"))

from app.db import SessionLocal
from app.db import engine as db_engine
from app.models import BacktestRun
from engine.backtest import (
    BacktestTrade,
    ExecutionParams,
    Metrics,
    breakdown,
    run_backtest,
    summarize,
)
from engine.candles import Candle, Timeframe
from engine.derivatives import FundingRate, LongShortRatio, OpenInterest
from engine.params import StrategyParams
from engine.signal import MarketInputs
from engine.strategies import STRATEGIES

DATA_DIR: Path | None = None
"""Если задан (--data-dir), свечи и деривативы читаются из CSV-выгрузок /debug/export вместо БД."""


def _csv_candles(symbol: str, tf: Timeframe, start: datetime, end: datetime) -> list[Candle]:
    assert DATA_DIR is not None
    path = DATA_DIR / f"{symbol}-{tf.value}.csv"
    if not path.exists():
        return []
    out: list[Candle] = []
    with path.open() as f:
        next(f)
        for line in f:
            ts, o, h, lo, c, v, qv, n = line.rstrip("\n").split(",")
            t = datetime.fromtimestamp(int(ts), tz=UTC)
            if start <= t < end:
                out.append(
                    Candle(
                        t,
                        Decimal(o),
                        Decimal(h),
                        Decimal(lo),
                        Decimal(c),
                        Decimal(v),
                        Decimal(qv),
                        int(n),
                    )
                )
    return out


def _csv_derivatives(
    symbol: str, start: datetime, end: datetime
) -> tuple[list[FundingRate], list[OpenInterest], list[LongShortRatio]]:
    assert DATA_DIR is not None

    def read(name: str) -> list[list[str]]:
        path = DATA_DIR / f"{symbol}-{name}.csv"
        if not path.exists():
            return []
        rows = [line.rstrip("\n").split(",") for line in path.open() if line.strip()]
        return [r for r in rows if start <= datetime.fromtimestamp(int(r[0]), tz=UTC) < end]

    ts = lambda r: datetime.fromtimestamp(int(r[0]), tz=UTC)  # noqa: E731
    return (
        [FundingRate(ts(r), Decimal(r[1])) for r in read("funding")],
        [OpenInterest(ts(r), Decimal(r[1])) for r in read("oi")],
        [LongShortRatio(ts(r), Decimal(r[1]) / (1 + Decimal(r[1]))) for r in read("ls")],
    )


def load_candles(symbol: str, tf: Timeframe, start: datetime, end: datetime) -> list[Candle]:
    if DATA_DIR is not None:
        return _csv_candles(symbol, tf, start, end)
    with db_engine.connect() as conn:
        rows = conn.execute(
            text(
                "select c.open_time, c.open, c.high, c.low, c.close, c.volume, "
                "c.quote_volume, c.trades "
                "from candles c join instruments i on i.id = c.instrument_id "
                "where i.symbol = :s and i.market_type = 'futures' and c.timeframe = :tf "
                "and c.open_time >= :a and c.open_time < :b order by c.open_time"
            ),
            {"s": symbol, "tf": tf.value, "a": start, "b": end},
        ).all()
    return [Candle(r[0].astimezone(UTC), r[1], r[2], r[3], r[4], r[5], r[6], r[7]) for r in rows]


def load_derivatives(
    symbol: str, start: datetime, end: datetime
) -> tuple[list[FundingRate], list[OpenInterest], list[LongShortRatio]]:
    if DATA_DIR is not None:
        return _csv_derivatives(symbol, start, end)
    with db_engine.connect() as conn:
        inst = conn.execute(
            text("select id from instruments where symbol = :s and market_type = 'futures'"),
            {"s": symbol},
        ).scalar()
        if inst is None:
            return [], [], []
        f = conn.execute(
            text(
                "select funding_time, rate from funding_rates where instrument_id = :i "
                "and funding_time >= :a and funding_time < :b order by funding_time"
            ),
            {"i": inst, "a": start, "b": end},
        ).all()
        oi = conn.execute(
            text(
                "select time, oi_quote from open_interest where instrument_id = :i "
                "and time >= :a and time < :b order by time"
            ),
            {"i": inst, "a": start, "b": end},
        ).all()
        ls = conn.execute(
            text(
                "select time, top_traders_ratio from long_short_ratios where instrument_id = :i "
                "and time >= :a and time < :b order by time"
            ),
            {"i": inst, "a": start, "b": end},
        ).all()
    return (
        [FundingRate(r[0].astimezone(UTC), r[1]) for r in f],
        [OpenInterest(r[0].astimezone(UTC), r[1]) for r in oi],
        [LongShortRatio(r[0].astimezone(UTC), r[1] / (1 + r[1])) for r in ls],
    )


def override_params(
    base: StrategyParams, overrides: dict[str, dict[str, object]]
) -> StrategyParams:
    """{"trade": {"tp2_min_r": "2.5"}, "version": "..."} → новый StrategyParams."""
    from dataclasses import fields, replace

    kwargs: dict[str, object] = {}
    for group, values in overrides.items():
        if group == "version":
            kwargs["version"] = values
            continue
        sub = getattr(base, group)
        typed: dict[str, object] = {}
        for f in fields(sub):
            if f.name in values:  # type: ignore[operator]
                raw = values[f.name]  # type: ignore[index]
                current = getattr(sub, f.name)
                typed[f.name] = (
                    type(current)(raw)
                    if isinstance(current, (Decimal, int)) and not isinstance(current, bool)
                    else raw
                )
        kwargs[group] = replace(sub, **typed)  # type: ignore[arg-type]
    return replace(base, **kwargs)  # type: ignore[arg-type]


def _dec(o: object) -> object:
    if isinstance(o, Decimal):
        return float(round(o, 4))
    if isinstance(o, datetime):
        return o.isoformat()
    raise TypeError(str(type(o)))


def metrics_dict(m: Metrics) -> dict[str, object]:
    return asdict(m)


def trade_dict(t: BacktestTrade) -> dict[str, object]:
    return {
        "symbol": t.symbol,
        "direction": t.direction.value,
        "signal_time": t.signal_time.isoformat(),
        "grade": t.grade.value,
        "score": t.score,
        "rr_tp2": str(t.rr_tp2),
        "entry": str(t.entry),
        "stop": str(t.stop),
        "status": t.result.status.value,
        "realized_r": str(t.result.realized_r),
        "tp_hits": t.result.tp_hits,
        "mfe_r": str(t.result.max_favorable_r),
        "mae_r": str(t.result.max_adverse_r),
        "exit_time": t.exit_time.isoformat() if t.exit_time else None,
        "facts": list(t.facts),
    }


def trade_row(t: BacktestTrade) -> str:
    r = t.result
    return ",".join(
        str(x)
        for x in (
            t.symbol,
            t.direction,
            t.signal_time.isoformat(),
            t.grade,
            t.score,
            round(t.rr_tp2, 2),
            t.entry,
            t.stop,
            t.tp1,
            t.tp2,
            t.tp3,
            r.status,
            round(r.realized_r, 3),
            r.tp_hits,
            t.exit_time.isoformat() if t.exit_time else "",
        )
    )


def main() -> int:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--symbols", nargs="*", default=[])
    p.add_argument("--symbols-file", type=Path)
    p.add_argument("--from", dest="start", type=date.fromisoformat, default=date(2022, 6, 1))
    p.add_argument("--to", dest="end", type=date.fromisoformat, default=datetime.now(tz=UTC).date())
    p.add_argument("--entry", default="market", choices=["market", "limit"])
    p.add_argument("--window", type=int, default=700)
    p.add_argument("--trades", action="store_true", help="печатать список сделок CSV")
    p.add_argument("--note", default="", help="комментарий к прогону (сохраняется в БД)")
    p.add_argument("--no-save", action="store_true", help="не сохранять прогон в backtest_runs")
    p.add_argument(
        "--data-dir", type=Path, help="читать CSV-выгрузки вместо БД (локальные прогоны)"
    )
    p.add_argument(
        "--params-json",
        help="переопределение параметров стратегии: путь к JSON-файлу или сам JSON (с «{»)",
    )
    p.add_argument(
        "--strategy",
        choices=sorted(STRATEGIES),
        help="версия стратегии из реестра (engine.strategies); по умолчанию базовая",
    )
    p.add_argument("--out", type=Path, help="сохранить сводку и сделки в JSON-файл")
    p.add_argument(
        "--no-derivatives", action="store_true", help="не использовать funding/OI/long-short"
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

    global DATA_DIR
    DATA_DIR = args.data_dir
    params = STRATEGIES[args.strategy] if args.strategy else StrategyParams()
    if args.params_json:
        raw = args.params_json.strip()
        text_json = raw if raw.startswith("{") else Path(raw).read_text()
        params = override_params(params, json.loads(text_json))
    start = datetime(args.start.year, args.start.month, args.start.day, tzinfo=UTC)
    end = datetime(args.end.year, args.end.month, args.end.day, tzinfo=UTC)
    warmup = start - timedelta(days=200)  # история для структуры, EMA50 D1 и ATR-перцентилей
    exec_params = ExecutionParams(entry_type=args.entry)

    def inputs_iter():  # type: ignore[no-untyped-def]
        for symbol in symbols:
            h4 = load_candles(symbol, Timeframe.H4, warmup, end + timedelta(days=30))
            if len(h4) < params.min_h4_history:
                print(f"{symbol}: мало свечей H4 ({len(h4)}), пропуск", file=sys.stderr, flush=True)
                continue
            d1 = load_candles(
                symbol, Timeframe.D1, warmup - timedelta(days=120), end + timedelta(days=30)
            )
            w1 = load_candles(
                symbol, Timeframe.W1, warmup - timedelta(days=400), end + timedelta(days=30)
            )
            funding, oi, ls = (
                ([], [], []) if args.no_derivatives else load_derivatives(symbol, warmup, end)
            )
            print(
                f"{symbol}: H4={len(h4)} D1={len(d1)} W1={len(w1)} "
                f"funding={len(funding)} oi={len(oi)}",
                file=sys.stderr,
                flush=True,
            )
            yield MarketInputs(
                symbol=symbol, h4=h4, d1=d1, w1=w1, funding=funding, open_interest=oi, long_short=ls
            )

    t0 = time.time()
    run = run_backtest(inputs_iter(), params, start, end, exec_params, window=args.window)
    elapsed = time.time() - t0

    summary = {
        "strategy": params.version,
        "period": [start.date().isoformat(), end.date().isoformat()],
        "symbols": symbols,
        "entry": args.entry,
        "evaluated_candles": run.evaluated,
        "skipped": dict(run.skipped),
        "skipped_by_symbol": {k: dict(v) for k, v in run.skipped_by_symbol.items()},
        "block_reasons": dict(sorted(run.block_reasons.items(), key=lambda kv: -kv[1])[:30]),
        "elapsed_sec": round(elapsed),
        "metrics": metrics_dict(summarize(run.trades)),
        "by_grade": {
            k: metrics_dict(v) for k, v in breakdown(run.trades, lambda t: t.grade.value).items()
        },
        "by_symbol": {
            k: metrics_dict(v) for k, v in breakdown(run.trades, lambda t: t.symbol).items()
        },
        "by_year": {
            k: metrics_dict(v)
            for k, v in breakdown(run.trades, lambda t: str(t.signal_time.year)).items()
        },
        "by_direction": {
            k: metrics_dict(v)
            for k, v in breakdown(run.trades, lambda t: t.direction.value).items()
        },
    }
    if not args.no_save and DATA_DIR is None:
        trades_json = [
            {
                "symbol": t.symbol,
                "direction": t.direction.value,
                "signal_time": t.signal_time.isoformat(),
                "grade": t.grade.value,
                "score": t.score,
                "rr_tp2": str(t.rr_tp2),
                "entry": str(t.entry),
                "stop": str(t.stop),
                "tp1": str(t.tp1),
                "tp2": str(t.tp2),
                "tp3": str(t.tp3),
                "status": t.result.status.value,
                "realized_r": str(t.result.realized_r),
                "tp_hits": t.result.tp_hits,
                "mfe_r": str(t.result.max_favorable_r),
                "mae_r": str(t.result.max_adverse_r),
                "exit_time": t.exit_time.isoformat() if t.exit_time else None,
                "facts": list(t.facts),
            }
            for t in run.trades
        ]
        with SessionLocal() as session:
            row = BacktestRun(
                strategy_version=params.version,
                params=json.loads(json.dumps(asdict(params), default=str)),
                period_start=start,
                period_end=end,
                instruments=symbols,
                execution=json.loads(json.dumps(asdict(exec_params), default=str)),
                result_summary=json.loads(json.dumps(summary, default=_dec)),
                trades=trades_json,
                created_by="scripts/backtest.py",
                note=args.note or None,
            )
            session.add(row)
            session.commit()
            print(f"сохранено: backtest_runs.id={row.id}", flush=True)
    if args.out:
        args.out.write_text(
            json.dumps(
                {"summary": summary, "trades": [trade_dict(t) for t in run.trades]},
                default=_dec,
                ensure_ascii=False,
            )
        )
    print("BACKTEST_SUMMARY " + json.dumps(summary, default=_dec, ensure_ascii=False), flush=True)
    if args.trades:
        print(
            "symbol,direction,signal_time,grade,score,rr_tp2,entry,stop,tp1,tp2,tp3,status,realized_r,tp_hits,exit_time"
        )
        for t in run.trades:
            print(trade_row(t))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
