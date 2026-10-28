import { describe, expect, it } from "vitest";
import { formatPriceLabel, formatPriceShort, formatTicks, tickDecimals } from "../format";

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
