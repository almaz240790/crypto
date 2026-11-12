import { DRAWING_TEXT, RU_STRINGS, RU_TEXT, type TextKey } from "@platform/charts";
import { describe, expect, it } from "vitest";
import en from "../../../i18n/en.json";
import { makeT } from "../../../i18n";
import { chartText, drawingText } from "./chartText";

/** Тексты графика (ADR-0005, ADR-0008): русский оригинал совпадает с пакетом, у каждой строки есть перевод. */
describe("chartText", () => {
  const ru = chartText(makeT("ru"));
  it("русские строки ≡ RU_TEXT пакета (без рассинхронизации)", () => {
    for (const k of Object.keys(RU_STRINGS) as TextKey[]) expect(ru[k], k).toBe(RU_TEXT[k]);
    expect(ru.pattern("engulfing", "x")).toBe(RU_TEXT.pattern("engulfing", "x"));
    expect(ru.zoneKind("ob", "down")).toBe(RU_TEXT.zoneKind("ob", "down"));
    expect(ru.panel("oi")).toBe("Открытый интерес");
    expect(ru.fill(ru["signal.tp"], { n: 2 })).toBe("Цель 2");
  });

  it("у каждой строки есть английский перевод в en.json", () => {
    const dict = en as Record<string, string>;
    for (const k of Object.keys(RU_STRINGS) as TextKey[]) expect(dict[RU_STRINGS[k]], `${k}: ${RU_STRINGS[k]}`).toBeTruthy();
    const e = chartText(makeT("en"));
    expect(e["sr.resistance"]).toBe("Resistance");
    expect(e.panel("funding")).toBe("Funding");
    expect(e.zoneKind("fvg", "up")).toBe(dict["разрыв цены вверх"]);
  });

  it("кэш по функции перевода", () => {
    const t = makeT("ru");
    expect(chartText(t)).toBe(chartText(t));
  });
});

/** Подписи рисунков на холсте (плашки позиции, измеритель): русский — как DRAWING_TEXT пакета, английский — с числом. */
describe("drawingText", () => {
  const N = [0, 1, 2, 5, 11, 21, 22, 25, 101, 111];
  it("русский — как в пакете: 1 свеча, 21 свеча, 22 свечи, 25 свечей", () => {
    const ru = drawingText(makeT("ru"));
    expect(N.map(ru.bars)).toEqual(N.map(DRAWING_TEXT.bars));
    expect(N.map(ru.bars)).toEqual(["0 свечей", "1 свеча", "2 свечи", "5 свечей", "11 свечей", "21 свеча", "22 свечи", "25 свечей", "101 свеча", "111 свечей"]);
    expect([ru.entry, ru.stop, ru.target, ru.risk, ru.size, ru.day, ru.hour, ru.minute]).toEqual([DRAWING_TEXT.entry, DRAWING_TEXT.stop, DRAWING_TEXT.target, DRAWING_TEXT.risk, DRAWING_TEXT.size, DRAWING_TEXT.day, DRAWING_TEXT.hour, DRAWING_TEXT.minute]);
  });

  it("английский: 1 candle, 21 candles (не «21 candle» — русское «21 свеча»)", () => {
    const e = drawingText(makeT("en"));
    expect(N.map(e.bars)).toEqual(["0 candles", "1 candle", "2 candles", "5 candles", "11 candles", "21 candles", "22 candles", "25 candles", "101 candles", "111 candles"]);
    expect([e.entry, e.stop, e.target, e.day, e.hour, e.minute]).toEqual(["Entry", "Stop", "Target", "d", "h", "min"]);
  });
});
