import { describe, expect, it } from "vitest";
import {
  decimalsFromTick,
  formatDuration,
  formatUsdCompact,
  formatPct,
  formatPrice,
  formatR,
  formatTimeUTC,
  plural,
} from "./format";

const NB = " ";
const MINUS = "−";

describe("decimalsFromTick", () => {
  it("по шагу цены", () => {
    expect(decimalsFromTick("0.01")).toBe(2);
    expect(decimalsFromTick("0.00001000")).toBe(5);
    expect(decimalsFromTick("1")).toBe(0);
    expect(decimalsFromTick("1.00000000")).toBe(0);
    expect(decimalsFromTick(null)).toBe(2);
  });
});

describe("formatPrice", () => {
  it("точность инструмента и группировка", () => {
    expect(formatPrice("65432.10000000", "0.10")).toBe(`65${NB}432.1`);
    expect(formatPrice("0.08123", "0.00001")).toBe("0.08123");
    expect(formatPrice(1234567, "1")).toBe(`1${NB}234${NB}567`);
    expect(formatPrice(null)).toBe("—");
    expect(formatPrice("abc")).toBe("—");
  });
});

describe("formatR / formatPct", () => {
  it("знак и единицы", () => {
    expect(formatR(0.62)).toBe(`+0.62${NB}R`);
    expect(formatR("-1")).toBe(`${MINUS}1.00${NB}R`);
    expect(formatR(0)).toBe(`0.00${NB}R`);
    expect(formatR(null)).toBe("—");
    expect(formatPct(1.234)).toBe(`+1.2${NB}%`);
    expect(formatPct(47, { signed: false })).toBe(`47.0${NB}%`);
    expect(formatPct(-0.04)).toBe(`0.0${NB}%`);
  });
});

describe("formatTimeUTC", () => {
  it("формат 25.10 16:00 UTC", () => {
    const now = new Date("2026-10-25T12:00:00Z");
    expect(formatTimeUTC("2026-10-25T16:00:00+00:00", { now })).toBe("25.10 16:00 UTC");
    expect(formatTimeUTC("2026-10-25T18:00:00+02:00", { now })).toBe("25.10 16:00 UTC");
    expect(formatTimeUTC("2025-03-01T04:00:00Z", { now })).toBe("01.03.2025 04:00 UTC");
    expect(formatTimeUTC("nope")).toBe("—");
  });
});

describe("formatUsdCompact", () => {
  it("коротко в долларах", () => {
    expect(formatUsdCompact(12_400_000)).toBe("$12.4M");
    expect(formatUsdCompact(850_400)).toBe("$850K");
    expect(formatUsdCompact(1_230_000_000)).toBe("$1.2B");
    expect(formatUsdCompact(120.4)).toBe("$120");
  });
});

describe("formatDuration", () => {
  it("часы → читаемо", () => {
    expect(formatDuration(2.233)).toBe(`2${NB}ч 14${NB}мин`);
    expect(formatDuration("0.5")).toBe(`30${NB}мин`);
    expect(formatDuration(77)).toBe(`3${NB}д 5${NB}ч`);
    expect(formatDuration(-1)).toBe("—");
  });
});

describe("plural", () => {
  it("склонение", () => {
    const f = (n: number) => plural(n, "сигнал", "сигнала", "сигналов");
    expect(f(1)).toBe("сигнал");
    expect(f(2)).toBe("сигнала");
    expect(f(5)).toBe("сигналов");
    expect(f(11)).toBe("сигналов");
    expect(f(21)).toBe("сигнал");
  });
});
