import { describe, expect, it } from "vitest";
import { LIQ_MIN_OI_COVERAGE, liquidationMap, oiCoverage, supportResistance } from "../levels";
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

/** Открытый интерес на каждой свече, растёт на step за свечу. */
const growingOi = (cs: Candle[], step = 10) => cs.map((c, i) => ({ t: c.time, v: 1000 + i * step }));

describe("карта ликвидаций", () => {
  it("уровни лонгов ниже цены, шортов выше; сработавшие отбрасываются", () => {
    // ровный рынок у 100: лонги 10× ликвидируются около 90.5, шорты около 109.5
    const cs = Array.from({ length: 50 }, (_, i) => mk(i, 100, 100.5, 99.5, 100));
    const m = liquidationMap(cs, growingOi(cs))!;
    expect(m).not.toBeNull();
    expect(m.topLong!.price).toBeLessThan(100);
    expect(m.topShort!.price).toBeGreaterThan(100);
    expect(Math.abs(m.topLong!.price - 90.5)).toBeLessThan(m.step * 1.5);
    // провал до 85 после открытия: лонги 10× (≈90.5) уже ликвидированы
    const crash = [...cs, mk(50, 100, 100, 85, 99)];
    const m2 = liquidationMap(crash, growingOi(crash))!;
    const near = m2.buckets.filter((b) => Math.abs(b.price - 90.5) < m2.step).reduce((s, b) => s + b.long, 0);
    expect(near).toBe(0);
  });

  it("суммы в USDT — прирост открытого интереса, крупнейшие скопления по убыванию", () => {
    const cs = Array.from({ length: 10 }, (_, i) => mk(i, 100, 100.5, 99.5, 100, 2));
    const m = liquidationMap(cs, growingOi(cs, 200))!;
    const total = m.buckets.reduce((s, b) => s + b.long + b.short, 0);
    // 9 приростов по 200 USDT; часть 100× лонгов (≈99.5) уже задета минимумами следующих свечей
    expect(total).toBeLessThanOrEqual(9 * 200);
    expect(total).toBeGreaterThan(9 * 200 * 0.85);
    expect(m.topLongs[0]!.long).toBeGreaterThanOrEqual(m.topLongs.at(-1)!.long);
    expect(m.topShorts.length).toBeLessThanOrEqual(3);
  });

  it("с открытым интересом вес — только прирост OI", () => {
    const cs = Array.from({ length: 20 }, (_, i) => mk(i, 100, 100.5, 99.5, 100));
    const flat = cs.map((c) => ({ t: c.time, v: 1000 }));
    expect(liquidationMap(cs, flat)).toBeNull();
    expect(liquidationMap(cs, growingOi(cs))).not.toBeNull();
  });

  it("без открытого интереса карты нет: объём × цена под названием «Ликвидации» не подставляется", () => {
    const cs = Array.from({ length: 50 }, (_, i) => mk(i, 100, 100.5, 99.5, 100, 1e6));
    expect(liquidationMap(cs, null)).toBeNull();
    expect(liquidationMap(cs, [])).toBeNull();
    expect(oiCoverage(cs, null)).toBe(0);
  });

  it("неделя: OI по четвергам, свечи с понедельника — совпадений нет, карты нет", () => {
    const W = 604800;
    const monday = Date.UTC(2026, 9, 26) / 1000; // пн 26.10.2026
    const cs: Candle[] = Array.from({ length: 30 }, (_, i) => ({ time: monday - (29 - i) * W, open: 100, high: 101, low: 99, close: 100, volume: 1e6, open_: false }));
    const thursdays = cs.map((c, i) => ({ t: c.time + 3 * 86400, v: 1000 + i * 10 }));
    expect(oiCoverage(cs, thursdays)).toBe(0);
    expect(liquidationMap(cs, thursdays)).toBeNull();
    // корзины с понедельника (как теперь отдаёт API) — карта строится
    const mondays = cs.map((c, i) => ({ t: c.time, v: 1000 + i * 10 }));
    expect(oiCoverage(cs, mondays)).toBe(1);
    expect(liquidationMap(cs, mondays)).not.toBeNull();
  });

  it("покрытие меньше половины свечей — карты нет; половина и больше — есть", () => {
    const cs = Array.from({ length: 40 }, (_, i) => mk(i, 100, 100.5, 99.5, 100));
    const oi = growingOi(cs);
    const third = oi.filter((_, i) => i % 3 === 0);
    expect(oiCoverage(cs, third)).toBeLessThan(LIQ_MIN_OI_COVERAGE);
    expect(liquidationMap(cs, third)).toBeNull();
    const half = oi.filter((_, i) => i % 2 === 0);
    expect(oiCoverage(cs, half)).toBe(0.5);
    expect(liquidationMap(cs, half)).not.toBeNull();
  });

  it("незакрытая свеча не влияет на карту (без утечки будущего)", () => {
    const cs = Array.from({ length: 50 }, (_, i) => mk(i, 100, 100.5, 99.5, 100));
    const oi = growingOi(cs);
    const base = liquidationMap(cs, oi);
    const withOpen = liquidationMap([...cs, mk(50, 100, 300, 1, 100, 100, true)], [...oi, { t: 50 * H, v: 99_999 }]);
    expect(withOpen).toEqual(base);
  });
});
