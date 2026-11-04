import { describe, expect, it } from "vitest";
import { paneSeparators, type PaneGeo } from "./paneGeo";

/** Границы панелей (ADR-0009, «Управление панелями»): какая пара панелей меняется при перетаскивании. */
const pane = (index: number, top: number, collapsed = false): PaneGeo => ({ key: index === 0 ? "main" : `p${index}`, index, title: "", top, height: 90, collapsed, testId: "", values: false, compactValues: false, inst: null, manual: false, scalable: true });

describe("paneSeparators", () => {
  it("между каждой парой раскрытых соседей — граница на верху нижней панели", () => {
    const s = paneSeparators([pane(0, 0), pane(1, 500), pane(2, 591)], false);
    expect(s).toEqual([
      { y: 500, above: 0, below: 1, key: "p1" },
      { y: 591, above: 1, below: 2, key: "p2" },
    ]);
  });

  it("свёрнутые пропускаются: тянется пара ближайших раскрытых выше и ниже", () => {
    const s = paneSeparators([pane(0, 0), pane(1, 500, true), pane(2, 525), pane(3, 616, true)], false);
    expect(s).toEqual([
      { y: 500, above: 0, below: 2, key: "p1" },
      { y: 525, above: 0, below: 2, key: "p2" },
    ]);
  });

  it("ниже нет раскрытой панели, «развернуть» и одна основная — границ нет", () => {
    expect(paneSeparators([pane(0, 0), pane(1, 500, true)], false)).toEqual([]);
    expect(paneSeparators([pane(0, 0), pane(1, 500)], true)).toEqual([]);
    expect(paneSeparators([pane(0, 0)], false)).toEqual([]);
  });
});
