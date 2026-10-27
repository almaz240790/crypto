import { describe, expect, it } from "vitest";
import { CciCalc, IchimokuCalc, KeltnerCalc, ObvCalc, atr, cci, ema, ichimoku, keltner, obv } from "../indicators/core";
import { indicatorById } from "../indicators/registry";
import type { Candle } from "../types";

const mk = (rows: [number, number, number, number?][]): Candle[] => rows.map(([h, l, c, v], i) => ({ time: 1_700_000_000 + i * 14400, open: c, high: h, low: l, close: c, volume: v ?? 10, open_: false }));
const walk = (n: number) => mk(Array.from({ length: n }, (_, i) => { const c = 100 + ((i * 37) % 11) - 5 + Math.sin(i / 3) * 4; return [c + 2, c - 2, c, 5 + (i % 7)] as [number, number, number, number]; }));

describe("индикаторы v2", () => {
  it("CCI: ручной расчёт и 0 при плоском рынке", () => {
    // TP = 10, 20, 30 → mean 20, MD = 20/3; CCI = (30-20)/(0.015*20/3) = 100
    expect(cci(mk([[10, 10, 10], [20, 20, 20], [30, 30, 30]]), 3)).toEqual([null, null, 100]);
    expect(cci(mk([[5, 5, 5], [5, 5, 5], [5, 5, 5]]), 3)[2]).toBe(0);
  });

  it("Keltner: середина — EMA, границы ± mult·ATR", () => {
    const c = walk(60);
    const k = keltner(c, 20, 10, 2);
    const e = ema(c, 20);
    const a = atr(c, 10);
    expect(k[59]!.mid).toBeCloseTo(e[59]!, 9);
    expect(k[59]!.up).toBeCloseTo(e[59]! + 2 * a[59]!, 9);
    expect(k[59]!.lo).toBeCloseTo(e[59]! - 2 * a[59]!, 9);
    expect(k[0]!.up).toBeNull();
  });

  it("OBV: накопление по знаку изменения close", () => {
    const c = mk([[1, 1, 10, 100], [1, 1, 11, 50], [1, 1, 9, 30], [1, 1, 9, 70], [1, 1, 12, 20]]);
    expect(obv(c)).toEqual([0, 50, 20, 20, 40]);
  });

  it("Ichimoku: середины диапазонов и сдвиг облака вперёд", () => {
    const c = walk(120);
    const v = ichimoku(c, 9, 26, 52, 26);
    const hh = (i: number, n: number) => Math.max(...c.slice(i - n + 1, i + 1).map((x) => x.high));
    const ll = (i: number, n: number) => Math.min(...c.slice(i - n + 1, i + 1).map((x) => x.low));
    expect(v[119]!.tenkan).toBeCloseTo((hh(119, 9) + ll(119, 9)) / 2, 9);
    expect(v[119]!.kijun).toBeCloseTo((hh(119, 26) + ll(119, 26)) / 2, 9);
    // облако на свече i = значения, посчитанные на свече i − 26
    const raw = ichimoku(c, 9, 26, 52, 0);
    expect(v[119]!.senkouA).toBeCloseTo(raw[93]!.senkouA!, 9);
    expect(v[119]!.senkouB).toBeCloseTo((hh(93, 52) + ll(93, 52)) / 2, 9);
    expect(v[7]!.tenkan).toBeNull();
    expect(v[50]!.senkouA).toBeNull(); // A посчитана с 26-й свечи и показана через 26: индекс 51
    expect(v[51]!.senkouA).not.toBeNull();
    expect(v[76]!.senkouB).toBeNull();
    expect(v[77]!.senkouB).not.toBeNull();
  });

  it("инкрементальный расчёт равен полному", () => {
    const c = walk(150);
    const calcs = { cci: new CciCalc(20), k: new KeltnerCalc(20, 10, 2), o: new ObvCalc(), i: new IchimokuCalc() };
    const inc = c.map((x) => ({ cci: calcs.cci.push(x), k: calcs.k.push(x), o: calcs.o.push(x), i: calcs.i.push(x) }));
    expect(inc.map((x) => x.cci)).toEqual(cci(c, 20));
    expect(inc.map((x) => x.k)).toEqual(keltner(c, 20, 10, 2));
    expect(inc.map((x) => x.o)).toEqual(obv(c));
    expect(inc.map((x) => x.i)).toEqual(ichimoku(c));
  });

  it("реестр: четыре новых индикатора с сериями", () => {
    const c = walk(100);
    for (const id of ["ichimoku", "keltner", "cci", "obv"]) {
      const spec = indicatorById(id)!;
      expect(spec).toBeDefined();
      const out = spec.compute(c, Object.fromEntries(spec.params.map((p) => [p.key, p.default])));
      for (const s of spec.series) expect(out[s.key]).toHaveLength(100);
    }
  });
});
