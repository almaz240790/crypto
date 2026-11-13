import type { Candle } from "@platform/charts";
import { describe, expect, it } from "vitest";
import { CROSS_FIT_MAX, CROSS_NO_ZONE, CROSS_SHORT, CROSS_SMALL, CROSS_TIGHT, crossFitKey, crossText } from "./crossText";

/** Пробелы разрядов (узкий неразрывный у formatPrice, обычный у шкалы) — как один пробел. */
const sp = (s: string | null) => (s === null ? null : s.replace(/\s/g, " "));
const T = Date.UTC(2026, 8, 20, 0, 0) / 1000;
const btc: Candle = { time: T, open: 81225.7, high: 81472.6, low: 80095.9, close: 81143.9, volume: 96_700, open_: false };

describe("crossText — значения свечи в строке перекрестия телефона", () => {
  it("полный вид: время UTC, цены по шагу инструмента, изменение со знаком, объём компактно", () => {
    const x = crossText(btc, "0.1", 0);
    expect(x.date).toBe("20.09, 00:00 UTC");
    expect([x.open, x.high, x.low, x.close].map(sp)).toEqual(["81 225.7", "81 472.6", "80 095.9", "81 143.9"]);
    expect(sp(x.change)).toBe("−0.10 %");
    expect(x.up).toBe(false);
    expect(x.volume).toBe("96.7K");
    expect(sp(crossText({ ...btc, close: 81733.4 }, "0.1", 0).change)).toBe("+0.63 %");
  });

  it("шаги до коротких цен цены не меняют; короткие — целым от 10 000, мелкие цены — с шагом инструмента", () => {
    expect(crossText(btc, "0.1", CROSS_SMALL)).toEqual(crossText(btc, "0.1", CROSS_TIGHT));
    expect(sp(crossText(btc, "0.1", CROSS_TIGHT).open)).toBe("81 225.7");
    const short = crossText(btc, "0.1", CROSS_SHORT);
    expect([short.open, short.high, short.low, short.close].map(sp)).toEqual(["81 226", "81 473", "80 096", "81 144"]);
    expect(short.date).toBe("20.09, 00:00 UTC");
    const pepe: Candle = { ...btc, open: 0.00494, high: 0.0049812, low: 0.0048901, close: 0.0049401 };
    expect(crossText(pepe, "1.000E-7", CROSS_SHORT).open).toBe("0.0049400");
    expect(sp(crossText({ ...btc, open: 3456.78 }, "0.01", CROSS_SHORT).open)).toBe("3 456.78");
  });

  it("последний шаг — время без «UTC»; изменения нет при открытии 0", () => {
    expect(crossText(btc, "0.1", CROSS_NO_ZONE).date).toBe("20.09, 00:00");
    expect(CROSS_FIT_MAX).toBe(CROSS_NO_ZONE);
    expect(crossText({ ...btc, open: 0 }, "0.1", 0).change).toBeNull();
  });
});

describe("crossFitKey — когда строку перемерять", () => {
  it("те же длины текстов — тот же ключ; длиннее цена, пометка «не закрыта» или кнопка индикаторов — другой", () => {
    const k = crossFitKey(btc, "0.1", 1);
    expect(crossFitKey({ ...btc, time: T + 14400, open: 80001.2, high: 82999.9, close: 81000.1, volume: 12_300 }, "0.1", 1)).toBe(k);
    expect(crossFitKey({ ...btc, high: 101_472.6 }, "0.1", 1)).not.toBe(k);
    expect(crossFitKey({ ...btc, open_: true }, "0.1", 1)).not.toBe(k);
    expect(crossFitKey(btc, "0.1", 0)).not.toBe(k);
    expect(crossFitKey(btc, "0.1", 12)).not.toBe(k);
    expect(crossFitKey(btc, "0.1", 3)).toBe(k);
  });
});
