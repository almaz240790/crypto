import { describe, expect, it } from "vitest";
import { liquidationMap, supportResistance } from "../levels";
import type { Candle } from "../types";

const H = 14400;
const mk = (i: number, o: number, h: number, l: number, c: number, v = 100, open_ = false): Candle => ({ time: i * H, open: o, high: h, low: l, close: c, volume: v, open_ });

/** Пила между 90 и 110: развороты у 90 (поддержка) и 110 (сопротивление), цена в конце около 100. */
function saw(n: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const phase = i % 20;
    const mid = phase < 10 ? 90 + phase * 2 : 110 - (phase - 10) * 2;
    out.push(mk(i, mid - 0.5, mid + 1, mid - 1, mid + 0.5));
  }
  return out;
}

describe("поддержка и сопротивление", () => {
  it("находит уровни по повторным разворотам сверху и снизу от цены", () => {
    const cs = saw(125);
    const lv = supportResistance(cs);
    const sup = lv.filter((l) => l.side === "support");
    const res = lv.filter((l) => l.side === "resistance");
    expect(sup.length).toBeGreaterThan(0);
    expect(res.length).toBeGreaterThan(0);
    expect(sup[0]!.price).toBeLessThan(cs.at(-1)!.close);
    expect(res[0]!.price).toBeGreaterThan(cs.at(-1)!.close);
    expect(Math.abs(sup[0]!.price - 89)).toBeLessThan(1.5);
    expect(Math.abs(res[0]!.price - 111)).toBeLessThan(1.5);
    expect(sup[0]!.touches).toBeGreaterThanOrEqual(2);
  });

  it("незакрытая свеча не влияет на уровни (без утечки будущего)", () => {
    const cs = saw(125);
    const base = supportResistance(cs);
    const withOpen = supportResistance([...cs, mk(125, 100, 300, 1, 100, 100, true)]);
    expect(withOpen).toEqual(base);
  });

  it("мало свечей — пусто", () => {
    expect(supportResistance(saw(5))).toEqual([]);
  });
});

describe("карта ликвидаций", () => {
  it("уровни лонгов ниже цены, шортов выше; сработавшие отбрасываются", () => {
    // ровный рынок у 100: лонги 10× ликвидируются около 90.5, шорты около 109.5
    const cs = Array.from({ length: 50 }, (_, i) => mk(i, 100, 100.5, 99.5, 100));
    const m = liquidationMap(cs, null)!;
    expect(m).not.toBeNull();
    expect(m.topLong!.price).toBeLessThan(100);
    expect(m.topShort!.price).toBeGreaterThan(100);
    expect(Math.abs(m.topLong!.price - 90.5)).toBeLessThan(m.step * 1.5);
    // провал до 85 после открытия: лонги 10× (≈90.5) уже ликвидированы
    const crash = [...cs, mk(50, 100, 100, 85, 99)];
    const m2 = liquidationMap(crash, null)!;
    const near = m2.buckets.filter((b) => Math.abs(b.price - 90.5) < m2.step).reduce((s, b) => s + b.long, 0);
    expect(near).toBe(0);
  });

  it("с открытым интересом вес — только прирост OI", () => {
    const cs = Array.from({ length: 20 }, (_, i) => mk(i, 100, 100.5, 99.5, 100));
    const flat = cs.map((c) => ({ t: c.time, v: 1000 }));
    expect(liquidationMap(cs, flat)).toBeNull();
    const growing = cs.map((c, i) => ({ t: c.time, v: 1000 + i * 10 }));
    expect(liquidationMap(cs, growing)).not.toBeNull();
  });
});
