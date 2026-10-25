import { describe, expect, it } from "vitest";
import { calculate, roundToLot } from "./calc";

describe("calculator", () => {
  it("размер, маржа, ликвидация, цели", () => {
    const out = calculate({ deposit: 10000, riskPct: 1, entry: 100, stop: 98, direction: "long", leverage: 5, marketType: "futures", lotSize: 0.001, tps: [102, 105, 108] });
    expect(out).not.toBeNull();
    expect(out!.riskUsd).toBe(100);
    expect(out!.size).toBe(50);
    expect(out!.notional).toBe(5000);
    expect(out!.margin).toBe(1000);
    expect(out!.liquidation).toBeCloseTo(100 * (1 - 0.2 + 0.005), 6);
    expect(out!.tps.map((t) => t.r)).toEqual([1, 2.5, 4]);
    expect(out!.tps[1].profitUsd).toBe(250);
    expect(out!.rrTp2).toBe(2.5);
    expect(out!.warnings).toEqual([]);
  });
  it("округление под lot size и предупреждения", () => {
    expect(roundToLot(0.123456, 0.001)).toBe(0.123);
    expect(roundToLot(7.9, 1)).toBe(7);
    const spot = calculate({ deposit: 1000, riskPct: 5, entry: 100, stop: 99, direction: "long", leverage: 1, marketType: "spot", lotSize: null, tps: [] });
    expect(spot!.warnings[0]).toMatch(/больше депозита/);
    const bad = calculate({ deposit: 1000, riskPct: 1, entry: 100, stop: 101, direction: "long", leverage: 1, marketType: "futures", lotSize: null, tps: [] });
    expect(bad!.warnings[0]).toMatch(/ниже входа/);
    const liq = calculate({ deposit: 1000, riskPct: 1, entry: 100, stop: 90, direction: "long", leverage: 20, marketType: "futures", lotSize: null, tps: [] });
    expect(liq!.warnings.some((w) => /ликвидация/.test(w))).toBe(true);
  });
});
