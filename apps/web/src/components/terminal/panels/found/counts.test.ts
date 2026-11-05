import { describe, expect, it } from "vitest";
import { foundCounts, isLiqRow, visibleFigures, visiblePatterns } from "./counts";

const row = (kind: string) => ({ kind }) as never;
const fig = (status: "forming" | "confirmed" | "invalidated", end_t: number) => ({ status, end_t });
const pat = (significant: boolean, t: number) => ({ significant, t });

describe("счётчики «Найдено» (план 2B.9 §8.1)", () => {
  it("ликвидации не входят в уровни", () => {
    const index = { levels: [row("resistance"), row("support"), row("demand"), row("liq-short"), row("liq-long")] };
    expect(foundCounts(index, [], [], null)).toEqual({ levels: 3, figures: 0, patterns: 0, total: 3 });
    expect(isLiqRow("liq-long")).toBe(true);
    expect(isLiqRow("supply")).toBe(false);
  });

  it("фильтр видимого участка: фигуры по концу, паттерны по времени; отменённые и незначимые не считаются", () => {
    const figures = [fig("confirmed", 100), fig("forming", 300), fig("invalidated", 400)];
    const patterns = [pat(true, 150), pat(true, 250), pat(false, 260)];
    expect(foundCounts(null, figures, patterns, 200)).toEqual({ levels: 0, figures: 1, patterns: 1, total: 2 });
    expect(foundCounts(null, figures, patterns, null)).toEqual({ levels: 0, figures: 2, patterns: 2, total: 4 });
    expect(visibleFigures(figures, 200)).toEqual([fig("forming", 300)]);
    expect(visiblePatterns(patterns, 200)).toEqual([pat(true, 250)]);
  });

  it("total = сумма разделов", () => {
    const c = foundCounts({ levels: [row("support"), row("zone")] }, [fig("forming", 10)], [pat(true, 10), pat(true, 20)], 0);
    expect(c.total).toBe(c.levels + c.figures + c.patterns);
    expect(c.total).toBe(5);
  });
});
