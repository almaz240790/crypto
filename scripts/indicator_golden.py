"""Эталоны индикаторов для golden-тестов TypeScript (план 2A.2, 2B.3).

Берёт CSV-выгрузки свечей (формат scripts/backtest.py --data-dir), считает все индикаторы
терминала Python-реализацией engine.indicators и пишет JSON в
packages/charts/src/indicators/golden/.

    uv run python scripts/indicator_golden.py --data-dir ./data \
        --symbols BTCUSDT ETHUSDT --tfs 4h 1d --last 400
"""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

from engine.candles import Candle
from engine.indicators import (
    atr,
    bollinger,
    ema,
    macd,
    rsi,
    sma,
    stochastic,
    supertrend,
    volume_sma,
    vwap_daily,
)


def read(path: Path, last: int) -> list[Candle]:
    rows = path.read_text().splitlines()[1:]
    out: list[Candle] = []
    for line in rows[-last:]:
        ts, o, h, lo, c, v, qv, n = line.split(",")
        out.append(
            Candle(
                datetime.fromtimestamp(int(ts), tz=UTC),
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


def f(values: list) -> list:  # type: ignore[type-arg]
    return [None if v is None else (v if isinstance(v, int) else float(v)) for v in values]


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--data-dir", type=Path, required=True)
    p.add_argument("--symbols", nargs="+", default=["BTCUSDT", "ETHUSDT"])
    p.add_argument("--tfs", nargs="+", default=["4h", "1d"])
    p.add_argument("--last", type=int, default=400)
    p.add_argument("--out", type=Path, default=Path("packages/charts/src/indicators/golden"))
    args = p.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    for sym in args.symbols:
        for tf in args.tfs:
            path = args.data_dir / f"{sym}-{tf}.csv"
            if not path.exists():
                print("нет файла", path)
                continue
            c = read(path, args.last)
            m_line, m_sig, m_hist = macd(c)
            st_k, st_d = stochastic(c)
            b_mid, b_up, b_lo = bollinger(c)
            s_line, s_dir = supertrend(c)
            data = {
                "symbol": sym,
                "tf": tf,
                "candles": [
                    {
                        "time": int(x.open_time.timestamp()),
                        "open": float(x.open),
                        "high": float(x.high),
                        "low": float(x.low),
                        "close": float(x.close),
                        "volume": float(x.volume),
                    }
                    for x in c
                ],
                "sma20": f(sma(c, 20)),
                "ema50": f(ema(c, 50)),
                "atr14": f(atr(c, 14)),
                "rsi14": f(rsi(c, 14)),
                "macd": {"line": f(m_line), "signal": f(m_sig), "hist": f(m_hist)},
                "stoch": {"k": f(st_k), "d": f(st_d)},
                "bb": {"mid": f(b_mid), "up": f(b_up), "lo": f(b_lo)},
                "vwap": f(vwap_daily(c)),
                "supertrend": {"line": f(s_line), "dir": f(s_dir)},
                "vol_sma20": f(volume_sma(c, 20)),
            }
            out = args.out / f"{sym}-{tf}.json"
            out.write_text(json.dumps(data, separators=(",", ":")))
            print("записан", out, len(c), "свечей")


if __name__ == "__main__":
    main()
