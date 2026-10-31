import { describe, expect, it } from "vitest";
import { formatCompactValue, formatIndicatorValue, formatPercentValue, formatPriceLabel, formatPriceShort, formatTicks, tickDecimals, tickFormat, tickPrecision } from "../format";
import type { PriceFormat } from "lightweight-charts";
import { COMPACT_FORMAT, instrumentPriceFormat, PERCENT_FORMAT, VALUE_FORMAT } from "../priceFormat";

/** Подпись тем же форматтером, что рисует шкалу серии (у LWC цена — брендированный number). */
const fmt = (f: PriceFormat, v: number): string => (f.type === "custom" ? f.formatter(v as never) : "не custom");
const ticks = (f: PriceFormat, vs: number[]): string[] => (f.type === "custom" && f.tickmarksFormatter ? f.tickmarksFormatter(vs as never) : []);

const T = " ";

describe("подписи цен", () => {
  it("разряды и точность инструмента", () => {
    expect(formatPriceLabel(80813, 1)).toBe(`80${T}813.0`);
    expect(formatPriceLabel(0.12345, 5)).toBe("0.12345");
    expect(formatPriceLabel(-1234.5, 2)).toBe(`−1${T}234.50`);
  });
  it("деления без лишних нулей", () => {
    expect(formatTicks([91000, 90000, 89000])).toEqual([`91${T}000`, `90${T}000`, `89${T}000`]);
    expect(formatTicks([2.5, 2.25, 2])).toEqual(["2.50", "2.25", "2.00"]);
    expect(tickDecimals([0.0012, 0.0011])).toBe(4);
  });
  it("на телефоне крупные цены — целым числом", () => {
    expect(formatPriceShort(80723.7, 1)).toBe(`80${T}724`);
    expect(formatPriceShort(2534.56, 2)).toBe(`2${T}534.56`);
    expect(formatPriceShort(0.1234, 4)).toBe("0.1234");
  });
  it("большие значения компактно", () => {
    expect(formatTicks([7817858292.4])).toEqual(["7.82B"]);
    expect(formatPriceLabel(781_000_000, 1)).toBe("781.00M");
  });
});

describe("точность по шагу цены", () => {
  it("обычная и экспоненциальная запись (str(Decimal) отдаёт 1.000E-7)", () => {
    expect(tickPrecision("1.000E-7")).toBe(7);
    expect(tickPrecision("1E-7")).toBe(7);
    expect(tickPrecision(1e-7)).toBe(7);
    expect(tickPrecision("0.0000001")).toBe(7);
    expect(tickPrecision("2.5E-6")).toBe(7);
    expect(tickPrecision("0.00001000")).toBe(5);
    expect(tickPrecision("0.1")).toBe(1);
    expect(tickPrecision("0.10")).toBe(1);
    expect(tickPrecision("1")).toBe(0);
    expect(tickPrecision("10")).toBe(0);
    expect(tickPrecision("1E+1")).toBe(0);
    expect(tickPrecision(null)).toBe(2);
    expect(tickPrecision("abc")).toBe(2);
    expect(tickPrecision("0")).toBe(2);
  });
  it("минимальный шаг — сам шаг цены", () => {
    expect(tickFormat("1.000E-7")).toEqual({ precision: 7, minMove: 1e-7 });
    expect(tickFormat("0.1")).toEqual({ precision: 1, minMove: 0.1 });
    expect(tickFormat(null)).toEqual({ precision: 2, minMove: 0.01 });
  });
});

describe("формат цены основной серии", () => {
  it("монета дешевле цента, шаг 1e-7: 7 знаков, minMove 1e-7, деления строятся", () => {
    const f = instrumentPriceFormat("1.000E-7");
    expect(f.type).toBe("custom");
    expect(f.precision).toBe(7);
    expect(f.minMove).toBe(1e-7);
    expect(f.base).toBe(10_000_000);
    expect(fmt(f, 0.004928)).toBe("0.0049280");
    expect(ticks(f, [0.0045, 0.005, 0.0055])).toEqual(["0.0045", "0.0050", "0.0055"]);
  });
  it("BTC, шаг 0.1: один знак и разряды; на телефоне — целым числом", () => {
    const f = instrumentPriceFormat("0.1");
    expect(f.precision).toBe(1);
    expect(f.minMove).toBe(0.1);
    expect(f.base).toBe(10);
    expect(fmt(f, 77365.12)).toBe(`77${T}365.1`);
    expect(fmt(instrumentPriceFormat("0.1", true), 77365.12)).toBe(`77${T}365`);
  });
  it("DOGE, шаг 0.00001", () => {
    const f = instrumentPriceFormat("0.00001");
    expect(f.precision).toBe(5);
    expect(f.base).toBe(100_000);
    expect(fmt(f, 0.18234)).toBe("0.18234");
  });
});

describe("форматы панелей", () => {
  it("фандинг — проценты с четырьмя знаками, а не «0.0»", () => {
    expect(formatPercentValue(0.01)).toBe("0.0100 %");
    expect(formatPercentValue(-0.0111)).toBe("−0.0111 %");
    expect(fmt(PERCENT_FORMAT, 0.01)).toBe("0.0100 %");
  });
  it("OI и объём — компактно", () => {
    expect(formatCompactValue(7_817_858_292)).toBe("7.82B");
    expect(formatCompactValue(78_200_000)).toBe("78.2M");
    expect(formatCompactValue(781_000_000)).toBe("781M");
    expect(formatCompactValue(54_300)).toBe("54.3K");
    expect(formatCompactValue(-2000)).toBe("−2.00K");
    expect(formatCompactValue(512.345)).toBe("512.35");
    expect(fmt(COMPACT_FORMAT, 1_500_000)).toBe("1.50M");
  });
  it("значения индикаторов: разряды, малые — три значащие цифры", () => {
    expect(formatIndicatorValue(55.234)).toBe("55.23");
    expect(formatIndicatorValue(-312.5)).toBe("−312.50");
    expect(formatIndicatorValue(0.0000123456)).toBe("0.0000123");
    expect(formatIndicatorValue(0)).toBe("0.00");
    expect(formatIndicatorValue(12_345_678)).toBe("12.3M");
    expect(fmt(VALUE_FORMAT, 70.5)).toBe("70.50");
  });
});
