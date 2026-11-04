import { describe, expect, it } from "vitest";
import { LEGEND_GAP_PX, LEGEND_MARGIN_SHARE, LEGEND_ROWS, LEGEND_ROWS_SHARE, LEGEND_STEP, LEGEND_TOP_PX, legendFit, legendListMax, legendRows, legendTopMargin } from "./legendFit";

/** Легенда вписывается в основную панель (ревью LEGEND-OVERFLOW-932, FILL-TOUCH-LEGEND-MARGIN). */
describe("легенда в основной панели", () => {
  it("без размера панели — как раньше: три строки и «ещё N»", () => {
    expect(legendRows(null, 9)).toEqual({ rows: LEGEND_ROWS, more: true, inline: false });
    expect(legendRows(null, 2)).toEqual({ rows: 2, more: false, inline: false });
    expect(legendRows(null, 0)).toEqual({ rows: 0, more: false, inline: false });
  });

  it("мышь, высокая панель: три строки и «ещё N», все помещаются — без «ещё»", () => {
    const fit = legendFit(560, false);
    expect(fit.budget).toBe(Math.floor(560 * LEGEND_ROWS_SHARE) - LEGEND_TOP_PX - LEGEND_GAP_PX);
    expect(legendRows(fit, 6)).toEqual({ rows: 3, more: true, inline: false });
    expect(legendRows(fit, 3)).toEqual({ rows: 3, more: false, inline: false });
  });

  it("телефон в ландшафте 932×430, палец: с панелями (основная 161–163 px) строк нет — «ещё N» в строке символа; без панелей (298 px) — строка", () => {
    expect(legendRows(legendFit(298, true), 1)).toEqual({ rows: 1, more: false, inline: false });
    expect(legendRows(legendFit(298, true), 9)).toEqual({ rows: 0, more: true, inline: true });
    for (const h of [161, 163]) {
      const fit = legendFit(h, true);
      expect(legendRows(fit, 9)).toEqual({ rows: 0, more: true, inline: true });
      expect(legendRows(fit, 1)).toEqual({ rows: 0, more: true, inline: true });
      // раскрытый список — не ниже панели
      expect(LEGEND_TOP_PX + LEGEND_STEP.line + legendListMax(fit, 0, true)).toBeLessThanOrEqual(h);
    }
  });

  it("планшет 1024×768, палец: на высокой панели строка помещается, на сжатой панелями — нет; наложенный инструмент — тоже строка", () => {
    expect(legendRows(legendFit(600, true), 1)).toEqual({ rows: 1, more: false, inline: false });
    expect(legendRows(legendFit(600, true), 4)).toEqual({ rows: 2, more: true, inline: false });
    expect(legendRows(legendFit(400, true), 4)).toEqual({ rows: 1, more: true, inline: false });
    expect(legendRows(legendFit(346, true), 9)).toEqual({ rows: 0, more: true, inline: true });
    expect(legendRows(legendFit(600, false), 3, 1)).toEqual({ rows: 3, more: false, inline: false });
    expect(legendRows(legendFit(200, false), 3, 1)).toEqual({ rows: 0, more: true, inline: true });
  });

  it("верхнее поле: до низа легенды с зазором, не больше доли — палец 20 % (свечам с объёмом 60 %), мышь 35 %", () => {
    expect(legendTopMargin(null, 300, true)).toBe(0);
    expect(legendTopMargin(40, 0, true)).toBe(0);
    expect(legendTopMargin(32, 300, false)).toBeCloseTo((32 + LEGEND_GAP_PX) / 300, 6);
    expect(legendTopMargin(222, 161, true)).toBe(LEGEND_MARGIN_SHARE.coarse);
    expect(legendTopMargin(222, 161, false)).toBe(LEGEND_MARGIN_SHARE.fine);
    expect(1 - legendTopMargin(222, 161, true) - 0.2).toBeGreaterThanOrEqual(0.6 - 1e-9);
  });

  it("раскрытый список: прокрутка в пределах панели, не меньше одной строки", () => {
    const fit = legendFit(400, false);
    expect(legendListMax(fit)).toBe(fit.max - LEGEND_STEP.line - LEGEND_STEP.more.fine);
    expect(legendListMax(legendFit(20, true))).toBe(LEGEND_STEP.row.coarse);
  });
});
