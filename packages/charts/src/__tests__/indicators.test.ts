import { describe, expect, it } from "vitest";
import { EmaCalc, MacdCalc, RsiCalc, SmaCalc, bollinger, ema, rsi, stochastic, supertrend, vwapDaily } from "../indicators/core";
import { INDICATORS, defaultParams, indicatorById } from "../indicators/registry";
import type { Candle } from "../types";

const mk = (closes: number[]): Candle[] => closes.map((c, i) => ({ time: 1_700_000_000 + i * 14400, open: c, high: c + 1, low: c - 1, close: c, volume: 10, open_: false }));

describe("индикаторы", () => {
  it("инкрементальный расчёт равен полному и не зависит от порции", () => {
    const candles = mk(Array.from({ length: 120 }, (_, i) => 100 + ((i * 37) % 11) - 5));
    const full = ema(candles, 12);
    const calc = new EmaCalc(12);
    const inc = candles.map((c) => calc.push(c));
    expect(inc).toEqual(full);
    const r = new RsiCalc(14);
    expect(candles.map((c) => r.push(c))).toEqual(rsi(candles, 14));
    const m = new MacdCalc();
    const first = candles.slice(0, 70).map((c) => m.push(c));
    const rest = candles.slice(70).map((c) => m.push(c));
    expect([...first, ...rest].map((x) => x.hist)).toEqual(bollinger(candles).map((_, i) => [...first, ...rest][i]!.hist));
  });

  it("SMA и EMA — ручной расчёт", () => {
    const s = new SmaCalc(3);
    expect([1, 2, 3, 4].map((v) => s.pushValue(v))).toEqual([null, null, 2, 3]);
    expect(ema(mk([1, 2, 3, 4]), 3)).toEqual([null, null, 2, 3]); // alpha 0.5: 0.5*4 + 0.5*2 = 3
  });

  it("RSI 100 при отсутствии падений, стохастик 50 при плоском рынке", () => {
    expect(rsi(mk([1, 2, 3, 4, 5, 6]), 5)[5]).toBe(100);
    const flat = mk([5, 5, 5, 5, 5, 5]).map((c) => ({ ...c, high: 5, low: 5 }));
    expect(stochastic(flat, 3, 2, 2)[3]!.k).toBe(50);
  });

  it("VWAP сбрасывается в полночь UTC", () => {
    const day0 = 1_700_006_400; // 00:00 UTC
    const c = mk([10, 20, 30, 40, 50, 60, 70, 80]).map((x, i) => ({ ...x, time: day0 + i * 14400 }));
    const v = vwapDaily(c);
    expect(v[6]).toBeCloseTo((71 + 69 + 70) / 3, 9);
    expect(v[1]).toBeCloseTo((10 + 20) / 2, 9);
  });

  it("Supertrend следует тренду", () => {
    const up = supertrend(mk(Array.from({ length: 40 }, (_, i) => 100 + i * 3)), 10, 3);
    expect(up[8]!.dir).toBeNull();
    expect(up.at(-1)!.dir).toBe(1);
    const down = supertrend(mk(Array.from({ length: 40 }, (_, i) => 300 - i * 3)), 10, 3);
    expect(down.at(-1)!.dir).toBe(-1);
  });

  it("реестр: каждый индикатор считает свои серии с параметрами по умолчанию", () => {
    const candles = mk(Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 5) * 10));
    for (const spec of INDICATORS) {
      const out = spec.compute(candles, defaultParams(spec));
      for (const s of spec.series) {
        expect(out[s.key], `${spec.id}.${s.key}`).toHaveLength(candles.length);
        expect(out[s.key]!.at(-1), `${spec.id}.${s.key} последнее`).not.toBeNull();
      }
    }
    expect(indicatorById("rsi")?.levels).toEqual([30, 70]);
    expect(indicatorById("nope")).toBeUndefined();
  });
});
