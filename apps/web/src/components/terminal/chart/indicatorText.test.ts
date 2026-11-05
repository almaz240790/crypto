import { indicatorById, type IndicatorValue } from "@platform/charts";
import { describe, expect, it } from "vitest";
import { indicatorText } from "./indicatorText";

const v = (value: number | null, extra: Partial<IndicatorValue> = {}): IndicatorValue => ({ key: "atr#1.value", uid: "atr#1", label: "ATR 14", value, color: "var(--ind-1)", price: false, ...extra });

describe("значения индикаторов в легенде и заголовках панелей", () => {
  it("ATR — одна линия в цене: «% от цены» на шкале ATR лежала плоской у нуля, а в заголовке было голое «0.953» (D18)", () => {
    expect(indicatorById("atr")!.series.map((s) => s.key)).toEqual(["value"]);
  });

  it("ATR в цене, объём компактно, линия на графике цены — по шагу инструмента, нет значения — тире", () => {
    expect(indicatorText(v(735.584), "0.1")).toBe("735.58");
    expect(indicatorText(v(954920.63), null, true)).toBe("955K");
    expect(indicatorText(v(80399.84, { price: true }), "0.1")).toMatch(/^80\s399\.8$/);
    expect(indicatorText(v(null), "0.1")).toBe("—");
  });
});
