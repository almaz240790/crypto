import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { atr, bollinger, ema, macd, rsi, sma, stochastic, supertrend, volumeSma, vwapDaily } from "../indicators/core";
import type { Candle } from "../types";

/** Golden-сверка с engine/indicators.py (план 2A.2): одинаковый вход → совпадение 1e-8. */
const DIR = join(__dirname, "..", "indicators", "golden");
const files = readdirSync(DIR).filter((f: string) => f.endsWith(".json"));
const EPS = 1e-8;

type Golden = {
  symbol: string;
  tf: string;
  candles: { time: number; open: number; high: number; low: number; close: number; volume: number }[];
  sma20: (number | null)[];
  ema50: (number | null)[];
  atr14: (number | null)[];
  rsi14: (number | null)[];
  macd: { line: (number | null)[]; signal: (number | null)[]; hist: (number | null)[] };
  stoch: { k: (number | null)[]; d: (number | null)[] };
  bb: { mid: (number | null)[]; up: (number | null)[]; lo: (number | null)[] };
  vwap: (number | null)[];
  supertrend: { line: (number | null)[]; dir: (number | null)[] };
  vol_sma20: (number | null)[];
};

function close(a: (number | null)[], b: (number | null)[], name: string) {
  expect(a.length, name).toBe(b.length);
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? null, y = b[i] ?? null;
    if (x === null || y === null) {
      expect(x, `${name}[${i}] null`).toBe(y);
      continue;
    }
    // относительная точность для больших значений (цены BTC ~1e5 при double ≈ 1e-11 абсолютной)
    expect(Math.abs(x - y) <= EPS * Math.max(1, Math.abs(y)), `${name}[${i}]: ${x} vs ${y}`).toBe(true);
  }
}

describe("golden против engine/indicators.py", () => {
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) {
    it(f, () => {
      const g = JSON.parse(readFileSync(join(DIR, f), "utf8")) as Golden;
      const c: Candle[] = g.candles.map((x) => ({ ...x, open_: false }));
      close(sma(c, 20), g.sma20, "sma20");
      close(ema(c, 50), g.ema50, "ema50");
      close(atr(c, 14), g.atr14, "atr14");
      close(rsi(c, 14), g.rsi14, "rsi14");
      const m = macd(c);
      close(m.map((x) => x.line), g.macd.line, "macd.line");
      close(m.map((x) => x.signal), g.macd.signal, "macd.signal");
      close(m.map((x) => x.hist), g.macd.hist, "macd.hist");
      const s = stochastic(c);
      close(s.map((x) => x.k), g.stoch.k, "stoch.k");
      close(s.map((x) => x.d), g.stoch.d, "stoch.d");
      const b = bollinger(c);
      close(b.map((x) => x.mid), g.bb.mid, "bb.mid");
      close(b.map((x) => x.up), g.bb.up, "bb.up");
      close(b.map((x) => x.lo), g.bb.lo, "bb.lo");
      close(vwapDaily(c), g.vwap, "vwap");
      const st = supertrend(c);
      close(st.map((x) => x.line), g.supertrend.line, "supertrend.line");
      close(st.map((x) => x.dir), g.supertrend.dir, "supertrend.dir");
      close(volumeSma(c, 20), g.vol_sma20, "vol_sma20");
    });
  }
});
