import type { Candle } from "@platform/charts";
import { describe, expect, it } from "vitest";
import { CROSS_FULL, CROSS_NO_DAY, CROSS_NO_ZONE, CROSS_SHED, CROSS_SHORT, CROSS_SMALL, CROSS_TIGHT, CROSS_TINY, crossFitKey, crossText, nextCrossFit, type CrossFit, type CrossPart, type CrossShed } from "./crossText";

/** Пробелы разрядов (узкий неразрывный у formatPrice, обычный у шкалы) — как один пробел. */
const sp = (s: string | null) => (s === null ? null : s.replace(/\s/g, " "));
const T = Date.UTC(2026, 8, 20, 0, 0) / 1000;
const btc: Candle = { time: T, open: 81225.7, high: 81472.6, low: 80095.9, close: 81143.9, volume: 96_700, open_: false };
const at = (level: number, shed: CrossShed[] = []): CrossFit => ({ level, shed });

describe("crossText — значения свечи в строке перекрестия телефона", () => {
  it("полный вид: время UTC, цены по шагу инструмента, изменение со знаком, объём компактно", () => {
    const x = crossText(btc, "0.1", CROSS_FULL);
    expect(x.date).toBe("20.09, 00:00 UTC");
    expect([x.open, x.high, x.low, x.close].map(sp)).toEqual(["81 225.7", "81 472.6", "80 095.9", "81 143.9"]);
    expect(sp(x.change)).toBe("−0.10 %");
    expect(x.up).toBe(false);
    expect(x.volume).toBe("96.7K");
    expect(x.note).toBeNull();
    expect(sp(crossText({ ...btc, close: 81733.4 }, "0.1", CROSS_FULL).change)).toBe("+0.63 %");
  });

  it("шаги до коротких цен цены не меняют; короткие — целым от 10 000, мелкие цены — с шагом инструмента", () => {
    expect(crossText(btc, "0.1", at(CROSS_SMALL))).toEqual(crossText(btc, "0.1", at(CROSS_TIGHT)));
    expect(sp(crossText(btc, "0.1", at(CROSS_TIGHT)).open)).toBe("81 225.7");
    const short = crossText(btc, "0.1", at(CROSS_SHORT));
    expect([short.open, short.high, short.low, short.close].map(sp)).toEqual(["81 226", "81 473", "80 096", "81 144"]);
    expect(short.date).toBe("20.09, 00:00 UTC");
    const pepe: Candle = { ...btc, open: 0.00494, high: 0.0049812, low: 0.0048901, close: 0.0049401 };
    expect(crossText(pepe, "1.000E-7", at(CROSS_SHORT)).open).toBe("0.0049400");
    expect(sp(crossText({ ...btc, open: 3456.78 }, "0.01", at(CROSS_SHORT)).open)).toBe("3 456.78");
  });

  it("шаг 4 — время без «UTC»; изменения нет при открытии 0", () => {
    expect(crossText(btc, "0.1", at(CROSS_NO_ZONE)).date).toBe("20.09, 00:00");
    expect(crossText({ ...btc, open: 0 }, "0.1", CROSS_FULL).change).toBeNull();
  });

  it("шаг 5 — у идущей свечи без дня: время, а у свечи от 00:00 (сутки, неделя) — дата; закрытая — как на шаге 4", () => {
    const forming: Candle = { ...btc, time: T + 16 * 3600, open_: true };
    expect(crossText(forming, "0.1", at(CROSS_NO_ZONE)).date).toBe("20.09, 16:00");
    expect(crossText(forming, "0.1", at(CROSS_NO_DAY)).date).toBe("16:00");
    expect(crossText({ ...btc, open_: true }, "0.1", at(CROSS_NO_DAY)).date).toBe("20.09");
    expect(crossText(btc, "0.1", at(CROSS_NO_DAY)).date).toBe("20.09, 00:00");
    expect(crossText({ ...btc, time: T + 16 * 3600 }, "0.1", at(CROSS_NO_DAY)).date).toBe("20.09, 16:00");
    // цены и остальное — как на шаге 4
    expect({ ...crossText(forming, "0.1", at(CROSS_NO_DAY)), date: "" }).toEqual({ ...crossText(forming, "0.1", at(CROSS_NO_ZONE)), date: "" });
  });

  it("пометка идущей свечи: «свеча не закрыта» → «не закрыта» (шаг 1) → «не закр.» → точка; у закрытой — нет", () => {
    const forming: Candle = { ...btc, open_: true };
    expect(crossText(forming, "0.1", CROSS_FULL).note).toBe("full");
    expect(crossText(forming, "0.1", at(CROSS_TIGHT)).note).toBe("tight");
    expect(crossText(forming, "0.1", at(CROSS_NO_DAY, ["noteShort"])).note).toBe("short");
    expect(crossText(forming, "0.1", at(CROSS_NO_DAY, ["noteShort", "change", "noteDot"])).note).toBe("dot");
    expect(crossText(btc, "0.1", at(CROSS_NO_DAY, ["noteShort", "noteDot"])).note).toBeNull();
  });

  it("уступленные изменение и объём — нет; цены и время остаются при любых уступках и шрифте 10 px", () => {
    const all = at(CROSS_TINY, CROSS_SHED.map((x) => x.id));
    const x = crossText({ ...btc, open_: true, time: T + 16 * 3600 }, "0.1", all);
    expect(x.change).toBeNull();
    expect(x.volume).toBeNull();
    expect(x.date).toBe("16:00");
    expect([x.open, x.high, x.low, x.close].map(sp)).toEqual(["81 226", "81 473", "80 096", "81 144"]);
    expect(x.up).toBe(false);
    expect(crossText(btc, "0.1", at(CROSS_NO_DAY, ["volume"])).change).not.toBeNull();
  });
});

/** Строки строки перекрестия: какие части в каждой и переполнена ли она. */
type Row = { parts: CrossPart[]; over: boolean };
const overOf = (rows: Row[]) => (part?: CrossPart) => (part ? rows.some((r) => r.over && r.parts.includes(part)) : rows.some((r) => r.over));

/** Все шаги подгонки подряд, пока rowsAt(вид) переполнена (как useCrossFit: замер после каждого шага). */
function fitAll(rowsAt: (fit: CrossFit) => Row[]): CrossFit[] {
  const out: CrossFit[] = [CROSS_FULL];
  for (let next = nextCrossFit(CROSS_FULL, overOf(rowsAt(CROSS_FULL))); next; next = nextCrossFit(out.at(-1)!, overOf(rowsAt(out.at(-1)!)))) out.push(next);
  return out;
}

describe("nextCrossFit — шаги подгонки строки", () => {
  it("влезла — дальше не сжимается; общие шаги — по порядку", () => {
    expect(nextCrossFit(CROSS_FULL, () => false)).toBeNull();
    expect(nextCrossFit(at(CROSS_SHORT), () => false)).toBeNull();
    const over = () => true;
    expect(nextCrossFit(CROSS_FULL, over)).toEqual(at(CROSS_TIGHT));
    expect(nextCrossFit(at(CROSS_SHORT), over)).toEqual(at(CROSS_NO_ZONE));
    expect(nextCrossFit(at(CROSS_NO_ZONE), over)).toEqual(at(CROSS_NO_DAY));
  });

  it("одна строка (ландшафт), знаки намного шире: «не закр.», без изменения, точка, без объёма, шрифт 10 px — и всё", () => {
    const steps = fitAll(() => [{ parts: ["note", "change", "volume"], over: true }]);
    expect(steps.slice(CROSS_NO_DAY)).toEqual([
      at(CROSS_NO_DAY),
      at(CROSS_NO_DAY, ["noteShort"]),
      at(CROSS_NO_DAY, ["noteShort", "change"]),
      at(CROSS_NO_DAY, ["noteShort", "change", "noteDot"]),
      at(CROSS_NO_DAY, ["noteShort", "change", "noteDot", "volume"]),
      at(CROSS_TINY, ["noteShort", "change", "noteDot", "volume"]),
    ]);
    // после шрифта 10 px сжимать нечем: дальше строка обрезается у правого края
    expect(nextCrossFit(steps.at(-1)!, () => true)).toBeNull();
  });

  it("две строки: не влезает только первая (длинные цены и пометка) — уступает пометка, а изменение и объём остаются", () => {
    // первая строка влезает с «не закр.» (как в CI: знаки на 6 % шире здешних, цены 1000PEPE)
    const steps = fitAll((f) => [
      { parts: ["note"], over: f.level < CROSS_NO_DAY || !f.shed.includes("noteShort") },
      { parts: ["change", "volume"], over: false },
    ]);
    expect(steps.at(-1)).toEqual(at(CROSS_NO_DAY, ["noteShort"]));
    // и с точкой: изменение из второй строки уступать не за что
    const dot = fitAll((f) => [
      { parts: ["note"], over: !f.shed.includes("noteDot") },
      { parts: ["change", "volume"], over: false },
    ]);
    expect(dot.at(-1)).toEqual(at(CROSS_NO_DAY, ["noteShort", "noteDot"]));
  });

  it("две строки: не влезает только вторая — уступают изменение, потом объём, пометка остаётся словами", () => {
    const steps = fitAll((f) => [
      { parts: ["note"], over: false },
      { parts: ["change", "volume"], over: !f.shed.includes("volume") },
    ]);
    expect(steps.at(-1)).toEqual(at(CROSS_NO_DAY, ["change", "volume"]));
    expect(crossText({ ...btc, open_: true }, "0.1", steps.at(-1)!).note).toBe("tight");
  });

  it("закрытая свеча: пометки нет — сразу изменение; изменения нет (открытие 0) — объём", () => {
    expect(nextCrossFit(at(CROSS_NO_DAY), overOf([{ parts: ["change", "volume"], over: true }]))).toEqual(at(CROSS_NO_DAY, ["change"]));
    expect(nextCrossFit(at(CROSS_NO_DAY), overOf([{ parts: ["volume"], over: true }]))).toEqual(at(CROSS_NO_DAY, ["volume"]));
    // переполнена строка без уступаемых частей — шрифт 10 px
    expect(nextCrossFit(at(CROSS_NO_DAY), overOf([{ parts: [], over: true }]))).toEqual(at(CROSS_TINY));
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
