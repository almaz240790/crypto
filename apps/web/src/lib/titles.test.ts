import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOOL_TITLES } from "../../../../packages/charts/src/drawings/types";
import { INDICATORS } from "../../../../packages/charts/src/indicators/registry";
import en from "../i18n/en.json";
import { FIGURE_TITLES, INDICATOR_TITLE_KEYS, PATTERN_TITLES, TOOL_TITLE_KEYS } from "./titles";

/** Значения словаря TITLES из файла движка: строки вида `Type.X: "Название",`. */
function engineTitles(rel: string): string[] {
  const src = readFileSync(new URL(`../../../../packages/engine/engine/${rel}`, import.meta.url), "utf8");
  const block = src.slice(src.indexOf("TITLES"));
  const dict = block.slice(block.indexOf("{"), block.indexOf("}") + 1);
  return [...dict.matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]);
}

describe("названия из движка и графика — ключи перевода", () => {
  it("совпадают с исходниками", () => {
    expect([...PATTERN_TITLES].sort()).toEqual(engineTitles("patterns/types.py").sort());
    expect([...FIGURE_TITLES].sort()).toEqual(engineTitles("figures/types.py").sort());
    expect([...TOOL_TITLE_KEYS].sort()).toEqual(Object.values(TOOL_TITLES).sort());
    expect([...INDICATOR_TITLE_KEYS].sort()).toEqual(INDICATORS.map((i) => i.title).filter((x) => /[А-Яа-яЁё]/.test(x)).sort());
  });

  it("у каждого есть английский перевод", () => {
    const dict = en as Record<string, string>;
    const missing = [...PATTERN_TITLES, ...FIGURE_TITLES, ...TOOL_TITLE_KEYS, ...INDICATOR_TITLE_KEYS].filter((k) => !dict[k]);
    expect(missing).toEqual([]);
  });
});
