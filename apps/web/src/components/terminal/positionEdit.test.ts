import type { Drawing } from "@platform/charts";
import { describe, expect, it } from "vitest";
import en from "@/i18n/en.json";
import { POS_ERROR_TEXT, applyField, formatField, parseNumber, positionMetrics, samePoints } from "./positionEdit";

/** Поля позиции в карточке (ADR-0009, «Рисование», дополнение «Позиция»): разбор, проверка, новые точки. */

const T = 1_790_000_000;
const long: Pick<Drawing, "type" | "points"> = {
  type: "position-long",
  points: [
    { time: T, price: 100 },
    { time: T + 3600, price: 95 },
    { time: T + 3600, price: 110 },
  ],
};
const short: Pick<Drawing, "type" | "points"> = { type: "position-short", points: [long.points[0]!, { ...long.points[1]!, price: 104 }, { ...long.points[2]!, price: 92 }] };
const prices = (r: ReturnType<typeof applyField>) => ("points" in r ? r.points.map((p) => p.price) : r.error);

describe("поля позиции", () => {
  it("число: запятая, пробелы разрядов, неразрывные пробелы; не число — null", () => {
    expect(parseNumber("65 000,5")).toBe(65000.5);
    expect(parseNumber("65 000.5")).toBe(65000.5);
    expect(parseNumber(".5")).toBe(0.5);
    expect(parseNumber("1e3")).toBeNull();
    expect(parseNumber("abc")).toBeNull();
    expect(parseNumber("")).toBeNull();
  });

  it("показ: цены с точностью инструмента, R:R и риск — без лишних нулей", () => {
    const p = { dir: "long" as const, entry: 100, stop: 95, target: 110, start: T, end: T + 3600 };
    expect(formatField(p, "entry", 1)).toBe("100.0");
    expect(formatField(p, "rr", 1)).toBe("2");
    expect(formatField(p, "risk", 1)).toBe("5");
    expect(positionMetrics({ ...p, stop: 100 })).toEqual({ rr: 0, riskPct: 0 });
  });

  it("вход, стоп, цель: по свои стороны от входа, иначе — ошибка и позиция не меняется", () => {
    expect(prices(applyField(long, "stop", "97", 0.1))).toEqual([100, 97, 110]);
    expect(prices(applyField(long, "stop", "101", 0.1))).toBe(POS_ERROR_TEXT["stop-below"]);
    expect(prices(applyField(long, "target", "99", 0.1))).toBe(POS_ERROR_TEXT["target-above"]);
    expect(prices(applyField(long, "entry", "96,04", 0.1))).toEqual([96, 95, 110]);
    expect(prices(applyField(long, "entry", "120", 0.1))).toBe(POS_ERROR_TEXT["entry-between"]);
    expect(prices(applyField(short, "stop", "99", 0.1))).toBe(POS_ERROR_TEXT["stop-above"]);
    expect(prices(applyField(short, "target", "101", 0.1))).toBe(POS_ERROR_TEXT["target-below"]);
    expect(prices(applyField(short, "target", "-1", 0.1))).toBe(POS_ERROR_TEXT.positive);
    expect(prices(applyField(long, "stop", "x", 0.1))).toBe(POS_ERROR_TEXT.number);
    expect(prices(applyField({ type: "trend", points: [] }, "stop", "1", 0.1))).toBe(POS_ERROR_TEXT.number);
  });

  it("R:R — цель; риск, % — стоп и цель (R:R тот же); вне пределов — ошибка", () => {
    expect(prices(applyField(long, "rr", "3", 0.1))).toEqual([100, 95, 115]);
    expect(prices(applyField(long, "risk", "2", 0.1))).toEqual([100, 98, 104]);
    expect(prices(applyField(short, "risk", "2", 0.1))).toEqual([100, 102, 96]);
    expect(prices(applyField(long, "rr", "0", 0.1))).toBe(POS_ERROR_TEXT.rr);
    expect(prices(applyField(long, "risk", "100", 0.1))).toBe(POS_ERROR_TEXT.risk);
  });

  it("точки совпадают — шага отмены нет", () => {
    expect(samePoints(long.points, long.points.map((p) => ({ ...p })))).toBe(true);
    expect(samePoints(long.points, short.points)).toBe(false);
    expect(samePoints(long.points, long.points.slice(1))).toBe(false);
  });

  it("тексты ошибок, полей и плашек переведены", () => {
    const dict = en as Record<string, string>;
    const keys = [...Object.values(POS_ERROR_TEXT), "Вход", "Стоп", "Цель", "R:R 1:", "Риск, %", "риск", "объём", "параметры позиции", "перевернуть в Short", "перевернуть в Long", "цена входа", "цена стопа", "цена цели"];
    expect(keys.filter((k) => !dict[k])).toEqual([]);
  });
});
