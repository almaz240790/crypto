import { describe, expect, it } from "vitest";
import en from "../i18n/en.json";
import { INTRADAY, TF_LABEL, TIMEFRAMES, tfOrder } from "./timeframes";

/** Подписи таймфреймов (план 2B.9): одни для терминала, мультичарта, снимка, заголовков и карточек. */
describe("TF_LABEL", () => {
  it("русские подписи «1м 5м 15м 1ч 4ч 1Д 1Н» в порядке TIMEFRAMES", () => {
    expect(TIMEFRAMES.map((x) => TF_LABEL[x]).join(" ")).toBe("1м 5м 15м 1ч 4ч 1Д 1Н");
  });

  it("en.json: «1m 5m 15m 1h 4h 1D 1W»", () => {
    const dict = en as Record<string, string>;
    expect(TIMEFRAMES.map((x) => dict[TF_LABEL[x]]).join(" ")).toBe("1m 5m 15m 1h 4h 1D 1W");
  });

  it("подпись есть у каждого таймфрейма и не совпадает с кодом в верхнем регистре (нет «H4», «1D» в RU)", () => {
    for (const x of TIMEFRAMES) {
      expect(TF_LABEL[x]).toBeTruthy();
      expect(TF_LABEL[x]).not.toBe(x.toUpperCase());
    }
    expect(Object.keys(TF_LABEL).sort()).toEqual([...TIMEFRAMES].sort());
  });
});

describe("tfOrder", () => {
  it("минутные закрыты: доступные сначала, минутные после — «1ч 4ч 1Д 1Н 1м 5м 15м»", () => {
    expect(tfOrder(true).map((x) => TF_LABEL[x]).join(" ")).toBe("1ч 4ч 1Д 1Н 1м 5м 15м");
    expect(tfOrder(true).slice(-INTRADAY.length)).toEqual(INTRADAY);
  });

  it("без замков — канонический порядок TIMEFRAMES (как клавиши 1–7)", () => {
    expect(tfOrder(false)).toEqual(TIMEFRAMES);
  });

  it("тот же набор таймфреймов в обоих порядках", () => {
    expect([...tfOrder(true)].sort()).toEqual([...TIMEFRAMES].sort());
  });
});
