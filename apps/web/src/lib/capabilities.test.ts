import { describe, expect, it } from "vitest";
import { INDICATORS } from "../../../../packages/charts/src/indicators/registry";
import { TOOL_TITLES } from "../../../../packages/charts/src/drawings/types";
import { LAYER_KEYS } from "../../../../packages/charts/src/types";
import { TIMEFRAMES } from "./timeframes";
import { COUNTS, INDICATOR_LIST } from "./capabilities";

describe("витрина возможностей графика совпадает с кодом", () => {
  it("индикаторы: то же число и те же названия", () => {
    expect(COUNTS.indicators).toBe(INDICATORS.length);
    const short = (t: string) => t.replace(" (дневной)", "").replace(" Channels", "");
    expect(INDICATOR_LIST.map((i) => i.name).sort()).toEqual(INDICATORS.map((i) => short(i.title)).sort());
  });

  it("индикатор на графике или в панели — как в реестре", () => {
    for (const spec of INDICATORS) {
      const item = INDICATOR_LIST.find((i) => spec.title.startsWith(i.name));
      expect(item?.pane).toBe(spec.pane);
    }
  });

  it("слои автоматической разметки — все слои графика, кроме сигналов", () => {
    expect(COUNTS.layers).toBe(LAYER_KEYS.filter((k) => k !== "signals").length);
  });

  it("инструменты рисования и таймфреймы", () => {
    expect(COUNTS.tools).toBe(Object.keys(TOOL_TITLES).length);
    expect(COUNTS.timeframes).toBe(TIMEFRAMES.length);
  });
});
