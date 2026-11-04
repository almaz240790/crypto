import { describe, expect, it } from "vitest";
import { autoBox, gripBox, groupCovers, groupReserve, paneSeparators, PANE_UI, sepAbove, type PaneGeo } from "./paneGeo";

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

  it("свёрнутые пропускаются: одна граница на пару раскрытых — по низу верхней раскрытой (не на заголовке свёрнутой)", () => {
    // основная | [p1 свёрнута] | p2 | [p3 свёрнута] — одна граница основная | p2 по низу основной
    expect(paneSeparators([pane(0, 0), pane(1, 500, true), pane(2, 525), pane(3, 616, true)], false)).toEqual([{ y: 500, above: 0, below: 2, key: "p1" }]);
    // телефон: RSI и MACD свёрнуты, OI раскрыт — одна граница по низу основной
    expect(paneSeparators([pane(0, 0), pane(1, 400, true), pane(2, 445, true), pane(3, 490)], false)).toEqual([{ y: 400, above: 0, below: 3, key: "p1" }]);
    // RSI | [MACD свёрнута] | OI — граница по низу RSI, а не над OI под заголовком MACD
    expect(paneSeparators([pane(0, 0), pane(1, 500), pane(2, 591, true), pane(3, 616)], false)).toEqual([
      { y: 500, above: 0, below: 1, key: "p1" },
      { y: 591, above: 1, below: 3, key: "p2" },
    ]);
  });

  it("ниже нет раскрытой панели, «развернуть» и одна основная — границ нет", () => {
    expect(paneSeparators([pane(0, 0), pane(1, 500, true)], false)).toEqual([]);
    expect(paneSeparators([pane(0, 0), pane(1, 500)], true)).toEqual([]);
    expect(paneSeparators([pane(0, 0)], false)).toEqual([]);
  });
});

describe("места ручки и «A» у шкалы цены", () => {
  it("«A» — в правом нижнем углу области графика, над зоной границы; ручка — левее «A», не на шкале", () => {
    const p = { top: 500, height: 90 };
    expect(autoBox(p, 1000, false)).toEqual({ left: 1000 - 4 - 20, top: 590 - 8 - 4 - 20, size: 20 });
    expect(autoBox(p, 1000, true)).toEqual({ left: 1000 - 4 - 44, top: 590 - 12 - 4 - 44, size: 44 });
    // низкая панель: «A» не выше её верха
    expect(autoBox({ top: 500, height: 30 }, 1000, true).top).toBe(500);
    const g = gripBox(1000, true);
    expect(g).toEqual({ left: 1000 - 4 - 44 - 8 - 44, w: 44, h: 44 });
    // ручка и «A» не пересекаются по горизонтали; ручка — целиком в области графика
    expect(g.left + g.w).toBeLessThanOrEqual(autoBox(p, 1000, true).left - PANE_UI.gap);
    expect(gripBox(1000, false).left + gripBox(1000, false).w).toBeLessThanOrEqual(1000 - 4 - 20 - 8);
    expect(gripBox(10, true).left).toBe(0);
    expect(sepAbove(false)).toBe(8);
    expect(sepAbove(true)).toBe(12);
  });
});

describe("общая строка свёрнутых панелей", () => {
  const sliver = (index: number, top: number): PaneGeo => ({ ...pane(index, top, true), height: 2, grouped: true });
  const host = (index: number, top: number): PaneGeo => ({ ...pane(index, top, true), height: 24, grouped: true, group: [] });

  it("заслонка — над каждой серией подряд идущих полосок (во всю высоту серии и на пиксель выше), host и раскрытые — без", () => {
    // основная | полоска | полоска | RSI раскрыт | полоска | host
    const panes = [pane(0, 0), sliver(1, 300), sliver(2, 303), pane(3, 306), sliver(4, 397), host(5, 400)];
    expect(groupCovers(panes)).toEqual([
      { key: "cover:p1", top: 299, height: 6 },
      { key: "cover:p4", top: 396, height: 3 },
    ]);
    expect(groupCovers([pane(0, 0), pane(1, 500, true)])).toEqual([]);
    expect(groupCovers([])).toEqual([]);
  });

  it("свёрнутые общей строки — не границы: граница только между раскрытыми", () => {
    const panes = [pane(0, 0), sliver(1, 300), sliver(2, 303), pane(3, 306), host(4, 397)];
    expect(paneSeparators(panes, false)).toEqual([{ y: 300, above: 0, below: 3, key: "p1" }]);
  });
});

describe("groupReserve: место справа у общей строки", () => {
  const row = (top: number, height = 44): PaneGeo => ({ ...pane(3, top), height, group: [] });
  const grip = gripBox(330, true); // 390 px: область графика 330, шкала 60

  it("ручка не на середине строки (телефон: граница на 15 px выше строки) — только отступ от края, кнопкам вся ширина", () => {
    expect(groupReserve(row(436), [{ y: 421, above: 0, below: 1, key: "p1" }], grip, 382)).toBe(PANE_UI.edge);
    // строка внизу, далеко от единственной ручки
    expect(groupReserve(row(527), [{ y: 421, above: 0, below: 1, key: "p1" }], grip, 382)).toBe(PANE_UI.edge);
    expect(groupReserve(row(436), [], grip, 382)).toBe(PANE_UI.edge);
  });

  it("ручка ложится на середину строки (граница на её верху) — место под ручку до правого края", () => {
    expect(groupReserve(row(436), [{ y: 436, above: 0, below: 3, key: "p3" }], grip, 382)).toBe(382 - grip.left);
    // мышь: ручка 12 px у верха строки 24 px середину не задевает
    expect(groupReserve(row(436, 24), [{ y: 436, above: 0, below: 3, key: "p3" }], gripBox(1300, false), 1360)).toBe(PANE_UI.edge);
  });
});
