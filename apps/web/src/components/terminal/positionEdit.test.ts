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

  it("R:R выше 100 — «от 0 до 100», а не «больше нуля»", () => {
    expect(POS_ERROR_TEXT.rr).toBe("R:R от 0 до 100");
    expect(prices(applyField(long, "rr", "150", 0.1))).toBe(POS_ERROR_TEXT.rr);
    expect(prices(applyField(long, "rr", "100", 0.1))).toEqual([100, 95, 600]);
  });

  it("итог R:R и риска проверяется: стоп или цель за нулём или на входе после шага цены — ошибка, позиция не меняется", () => {
    const sh: Pick<Drawing, "type" | "points"> = { type: "position-short", points: [long.points[0]!, { ...long.points[1]!, price: 110 }, { ...long.points[2]!, price: 90 }] };
    // Short: цель на 15 рисков ниже входа — −50; на 10 — ровно 0
    expect(prices(applyField(sh, "rr", "15", 0.1))).toBe(POS_ERROR_TEXT["target-zero"]);
    expect(prices(applyField(sh, "rr", "10", 0.1))).toBe(POS_ERROR_TEXT["target-zero"]);
    expect(prices(applyField(sh, "rr", "9", 0.1))).toEqual([100, 110, 10]);
    // риск 60 % при R:R 2: стоп 160, цель −20
    const sh2 = { ...sh, points: [sh.points[0]!, sh.points[1]!, { ...sh.points[2]!, price: 80 }] };
    expect(prices(applyField(sh2, "risk", "60", 0.1))).toBe(POS_ERROR_TEXT["target-zero"]);
    expect(prices(applyField(sh2, "risk", "40", 0.1))).toEqual([100, 140, 20]);
    // Long у нуля: риск 99.9 % при шаге 0.1 — стоп 0
    const low: Pick<Drawing, "type" | "points"> = { type: "position-long", points: [{ time: T, price: 1 }, { time: T + 3600, price: 0.9 }, { time: T + 3600, price: 1.2 }] };
    expect(prices(applyField(low, "risk", "99.9", 0.1))).toBe(POS_ERROR_TEXT["stop-zero"]);
    // грубый шаг: стоп или цель ложатся на вход
    expect(prices(applyField(long, "risk", "0.4", 1))).toBe(POS_ERROR_TEXT.tick);
    expect(prices(applyField(short, "risk", "0.4", 1))).toBe(POS_ERROR_TEXT.tick);
    expect(prices(applyField(long, "rr", "0.01", 1))).toBe(POS_ERROR_TEXT.tick);
    expect(prices(applyField({ ...long, points: [{ time: T, price: 100 }, { time: T + 3600, price: 99 }, long.points[2]!] }, "risk", "0.01", 0.1))).toBe(POS_ERROR_TEXT.tick);
    // дешёвая монета (шаг 1e-7): риск 0.001 % у 0.0049702 — стоп на входе
    const pepe: Pick<Drawing, "type" | "points"> = { type: "position-long", points: [{ time: T, price: 0.0049702 }, { time: T + 3600, price: 0.0048 }, { time: T + 3600, price: 0.0053 }] };
    expect(prices(applyField(pepe, "risk", "0.001", 0.0000001))).toBe(POS_ERROR_TEXT.tick);
  });

  it("точки совпадают — шага отмены нет", () => {
    expect(samePoints(long.points, long.points.map((p) => ({ ...p })))).toBe(true);
    expect(samePoints(long.points, short.points)).toBe(false);
    expect(samePoints(long.points, long.points.slice(1))).toBe(false);
  });

  it("тексты ошибок, полей и плашек переведены", () => {
    const dict = en as Record<string, string>;
    const keys = [...Object.values(POS_ERROR_TEXT), "Вход", "Стоп", "Цель", "R:R 1:", "Риск, %", "риск", "объём", "параметры", "параметры позиции", "перевернуть в Short", "перевернуть в Long", "цена входа", "цена стопа", "цена цели"];
    expect(keys.filter((k) => !dict[k])).toEqual([]);
  });
});
