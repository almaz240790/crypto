import { describe, expect, it } from "vitest";
import { mainMinShareFor, planPanes } from "../controller/paneManager";
import { VIEW } from "../presets";

describe("PaneManager: высоты панелей (план 2A.7, M19)", () => {
  it("доля основной панели: десктоп 0.55, телефон и ячейка 0.6", () => {
    expect(VIEW.desktop.mainMinShare).toBe(0.55);
    expect(VIEW.phone.mainMinShare).toBe(0.6);
    expect(mainMinShareFor("desktop")).toBe(0.55);
    expect(mainMinShareFor("phone")).toBe(0.6);
    expect(mainMinShareFor("cell")).toBe(0.6);
  });

  it("панели помещаются — получают свою высоту, основной — остаток", () => {
    const p = planPanes(800, [90, 80], 0.55);
    expect(p.others).toEqual([90, 80]);
    expect(p.main).toBe(630);
  });

  it("не помещаются — сжимаются пропорционально, основная — ровно доля", () => {
    // десктоп 816 px, RSI + MACD + OI + фандинг: 90 + 90 + 80 + 80 = 340 > 816 · 0.45 = 367.2? нет — помещаются
    expect(planPanes(816, [90, 90, 80, 80], 0.55).main).toBe(476);
    // пять панелей по 90: 450 > 367.2 → основная 55 %
    const p = planPanes(816, [90, 90, 90, 90, 90], 0.55);
    expect(p.main / 816).toBeCloseTo(0.55, 6);
    expect(p.others[0]).toBeCloseTo(p.others[4]!, 6);
    // телефон: 0.6
    const ph = planPanes(600, [90, 90, 90], 0.6);
    expect(ph.main / 600).toBeCloseTo(0.6, 6);
    expect(ph.others.reduce((a, b) => a + b, 0)).toBeCloseTo(240, 6);
  });

  it("свёрнутая панель 24 px, крайние значения", () => {
    expect(planPanes(700, [24, 90], 0.55)).toEqual({ main: 586, others: [24, 90] });
    expect(planPanes(0, [90], 0.55)).toEqual({ main: 0, others: [] });
    expect(planPanes(500, [], 0.55)).toEqual({ main: 500, others: [] });
    // высота меньше 1 — 1 px; доля вне [0, 1] ограничивается
    expect(planPanes(100, [0], 0.5).others).toEqual([1]);
    expect(planPanes(100, [80], 2).main).toBe(100);
    expect(planPanes(100, [80], -1).main).toBe(20);
  });
});
