import { describe, expect, it } from "vitest";
import { heikinAshi, heikinNext } from "../heikin";
import type { Candle } from "../types";

const c = (time: number, o: number, h: number, l: number, cl: number): Candle => ({ time, open: o, high: h, low: l, close: cl, volume: 1, open_: false });

describe("Heikin Ashi", () => {
  it("совпадает с эталонным ручным расчётом", () => {
    // эталон посчитан вручную по формулам TradingView/Investopedia
    const src = [c(1, 10, 12, 9, 11), c(2, 11, 13, 10, 12), c(3, 12, 12.5, 10.5, 11)];
    const ha = heikinAshi(src);
    expect(ha[0]).toMatchObject({ open: 10.5, close: 10.5, high: 12, low: 9 });
    // close2 = (11+13+10+12)/4 = 11.5; open2 = (10.5+10.5)/2 = 10.5
    expect(ha[1]).toMatchObject({ open: 10.5, close: 11.5, high: 13, low: 10 });
    // close3 = (12+12.5+10.5+11)/4 = 11.5; open3 = (10.5+11.5)/2 = 11
    expect(ha[2]).toMatchObject({ open: 11, close: 11.5, high: 12.5, low: 10.5 });
    expect(ha.map((x) => x.time)).toEqual([1, 2, 3]);
  });

  it("high/low расширяются до open/close HA", () => {
    const ha = heikinAshi([c(1, 10, 10, 10, 10), c(2, 10, 10.2, 9.9, 14)]);
    // close2 = (10+10.2+9.9+14)/4 = 11.025, open2 = 10 → high = max(10.2, 10, 11.025)
    expect(ha[1]!.high).toBeCloseTo(11.025, 6);
    expect(ha[1]!.low).toBe(9.9);
  });

  it("инкрементальный расчёт равен полному", () => {
    const src = Array.from({ length: 50 }, (_, i) => c(i, 100 + i, 102 + i, 99 + i, 101 + ((i * 7) % 3)));
    const full = heikinAshi(src);
    let prev: Candle | undefined;
    src.forEach((x, i) => {
      prev = heikinNext(prev, x);
      expect(prev).toEqual(full[i]);
    });
  });
});
