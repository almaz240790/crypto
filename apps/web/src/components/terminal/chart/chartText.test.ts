import { RU_STRINGS, RU_TEXT, type TextKey } from "@platform/charts";
import { describe, expect, it } from "vitest";
import en from "../../../i18n/en.json";
import { makeT } from "../../../i18n";
import { chartText } from "./chartText";

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
