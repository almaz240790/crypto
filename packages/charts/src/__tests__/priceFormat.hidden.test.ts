import type { BarPrice } from "lightweight-charts";
import { describe, expect, it } from "vitest";
import { formatCountdown, formatSignedPercent, formatUsd } from "../format";
import { instrumentPriceFormat, priceFormatter, withHiddenTicks } from "../priceFormat";

const bp = (xs: number[]) => xs as BarPrice[];

describe("withHiddenTicks (M04): деления под метками пустые", () => {
  it("гасит только скрытые деления, число знаков считается по всем", () => {
    const base = instrumentPriceFormat("0.1");
    const f = withHiddenTicks(base, (p) => p === 83500);
    expect(f.tickmarksFormatter!(bp([83400, 83450.5, 83500, 83550]))).toEqual(["83 400.0", "83 450.5", "", "83 550.0"]);
    expect(base.tickmarksFormatter!(bp([83400, 83450.5, 83500, 83550]))).toEqual(["83 400.0", "83 450.5", "83 500.0", "83 550.0"]);
  });

  it("formatter, точность и шаг не меняются", () => {
    const base = instrumentPriceFormat("1.000E-7");
    const f = withHiddenTicks(base, () => true);
    expect(f.formatter).toBe(base.formatter);
    expect(f.precision).toBe(7);
    expect(f.minMove).toBe(base.minMove);
    expect(f.base).toBe(10_000_000);
    expect(f.formatter(0.00494 as BarPrice)).toBe("0.0049400");
    expect(f.tickmarksFormatter!(bp([0.0049, 0.005]))).toEqual(["", ""]);
  });

  it("без tickmarksFormatter — по formatter", () => {
    const f = withHiddenTicks({ type: "custom", precision: 2, minMove: 0.01, formatter: (p: number) => `p${p}` }, (p) => p > 2);
    expect(f.tickmarksFormatter!(bp([1, 2, 3]))).toEqual(["p1", "p2", ""]);
  });
});

describe("priceFormatter: один объект форматов по шагу цены", () => {
  it("BTC: разряды, узкая шкала — целые", () => {
    const f = priceFormatter("0.1000000000", false);
    expect(f.precision).toBe(1);
    expect(f.price(83528.36)).toBe("83 528.4");
    expect(f.axis(83528.36)).toBe("83 528.4");
    expect(priceFormatter("0.1", true).axis(83528.36)).toBe("83 528");
    expect(f.ticks([83400, 83500])).toEqual(["83 400", "83 500"]);
    expect(f.value(0.000123)).toBe("0.000123");
    expect(f.compact(7_820_000_000)).toBe("7.82B");
    expect(f.pct(1.2449)).toBe("+1.24 %");
    expect(f.pct(-0.5, 1)).toBe("−0.5 %");
  });

  it("PEPE (шаг 1.000E-7): 7 знаков, без «0.00»", () => {
    const f = priceFormatter("1.000E-7", true);
    expect(f.precision).toBe(7);
    expect(f.minMove).toBeCloseTo(1e-7, 12);
    expect(f.price(0.00494)).toBe("0.0049400");
    expect(f.axis(0.0049401)).toBe("0.0049401");
    for (const s of f.ticks([0.0049, 0.00495, 0.005])) expect(s).not.toMatch(/^0\.0+$/);
  });

  it("без шага — две цифры", () => {
    expect(priceFormatter(null, false).price(1.23456)).toBe("1.23");
  });
});

describe("суммы и отсчёт", () => {
  it("formatUsd: компактно со знаком доллара", () => {
    expect(formatUsd(285_300_000)).toBe("$285M");
    expect(formatUsd(1_240_000_000)).toBe("$1.24B");
    expect(formatUsd(54_321)).toBe("$54.3K");
    expect(formatUsd(512)).toBe("$512");
    expect(formatUsd(-2_000_000)).toBe("−$2.00M");
  });

  it("formatCountdown: ч:мм:сс и м:сс", () => {
    expect(formatCountdown(5025)).toBe("1:23:45");
    expect(formatCountdown(725)).toBe("12:05");
    expect(formatCountdown(7)).toBe("0:07");
    expect(formatCountdown(-3)).toBe("0:00");
    expect(formatCountdown(59.9)).toBe("0:59");
  });

  it("formatSignedPercent: ноль без знака", () => {
    expect(formatSignedPercent(0.001)).toBe("0.00 %");
    expect(formatSignedPercent(-0.001)).toBe("0.00 %");
    expect(formatSignedPercent(3.14159, 3)).toBe("+3.142 %");
  });
});
