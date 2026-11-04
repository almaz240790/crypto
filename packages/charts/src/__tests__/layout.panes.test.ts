import { describe, expect, it } from "vitest";
import { fitHeights, GROUPED_PX, planPanes, type PaneWant } from "../layout/panes";

/**
 * Раскладка панелей (продовый баг: на телефоне свёрнутые «Открытый интерес», «Ликвидации», «Лонг/шорт» сжимались
 * до 10 px, и их заголовки 24 px налезали друг на друга и на подписи шкалы времени).
 */
const O = { mainMinShare: 0.5, rowPx: 24 };
const open = (want = 90): PaneWant => ({ want, collapsed: false });
const shut = (want = 80): PaneWant => ({ want, collapsed: true });
const sum = (a: readonly number[]) => a.reduce((x, y) => x + y, 0);

describe("высоты раскрытых панелей", () => {
  it("помещаются — желаемые; нет — поровну по множителю, но не ниже строки заголовка", () => {
    expect(fitHeights([90, 80], 200, 24)).toEqual([90, 80]);
    expect(fitHeights([90, 90], 90, 24)).toEqual([45, 45]);
    // маленькая упирается в минимум, остаток — большой
    const h = fitHeights([200, 20], 100, 24);
    expect(h[1]).toBe(24);
    expect(h[0]).toBeCloseTo(76, 9);
    expect(fitHeights([], 50, 24)).toEqual([]);
    expect(fitHeights([10, 10], 10, 24)).toEqual([24, 24]);
  });
});

describe("план панелей", () => {
  it("как у владельца (телефон, 610 px, 6 раскрытых и 3 свёрнутые): у свёрнутых ровно строка, главная — не меньше половины", () => {
    const panes = [open(), open(), open(), open(), open(), open(80), shut(), shut(), shut()];
    const p = planPanes(610, panes, O);
    expect(p.host).toBeNull();
    expect(p.collapse).toEqual([]);
    expect(p.grouped.every((g) => !g)).toBe(true);
    expect(p.heights.slice(6)).toEqual([24, 24, 24]);
    for (const h of p.heights.slice(0, 6)) expect(h).toBeGreaterThanOrEqual(24);
    expect(610 - sum(p.heights)).toBeGreaterThanOrEqual(305);
  });

  it("место есть — желаемые высоты, главной — остаток", () => {
    const p = planPanes(900, [open(), shut()], O);
    expect(p.heights).toEqual([90, 24]);
    expect(planPanes(900, [], O).heights).toEqual([]);
    // график ещё не размечен — без изменений
    expect(planPanes(0, [open(), shut()], O)).toEqual({ heights: [90, 80], grouped: [false, false], host: null, collapse: [] });
  });

  it("строк не хватает (телефон боком): свёрнутые — в одну общую строку у последней свёрнутой, раскрытые — в остатке", () => {
    // 250 px: на панели 125 px — 5 строк, панелей 8
    const panes = [open(), shut(), shut(), open(), shut(), shut(), shut(), shut()];
    const p = planPanes(250, panes, O);
    expect(p.collapse).toEqual([]);
    expect(p.host).toBe(7);
    expect(p.grouped).toEqual([false, true, true, false, true, true, true, true]);
    expect(p.heights[7]).toBe(24);
    for (const i of [1, 2, 4, 5, 6]) expect(p.heights[i]).toBe(GROUPED_PX);
    expect(p.heights[0]).toBeGreaterThanOrEqual(24);
    expect(p.heights[3]).toBeGreaterThanOrEqual(24);
    expect(250 - sum(p.heights)).toBeGreaterThanOrEqual(125);
  });

  it("раскрытым тоже не хватает строк — верхние сворачиваются в общую строку", () => {
    // 160 px: 80 px — 3 строки; раскрытых 4 и свёрнутая 1: остаются 2 нижние раскрытые и общая строка
    const p = planPanes(160, [open(), open(), open(), open(), shut()], O);
    expect(p.collapse).toEqual([0, 1]);
    expect(p.grouped).toEqual([true, true, false, false, true]);
    expect(p.host).toBe(4);
    expect(160 - sum(p.heights)).toBeGreaterThanOrEqual(80);
    // целые пиксели: LWC округляет высоты и остаток отдаёт последней панели
    for (const h of p.heights) expect(Number.isInteger(h)).toBe(true);
    // полоски свёрнутых тоже занимают место: на 150 px две раскрытые уже не влезают
    const tight = planPanes(150, [open(), open(), open(), open(), shut()], O);
    expect(tight.collapse).toEqual([0, 1, 2]);
    expect(150 - sum(tight.heights)).toBeGreaterThanOrEqual(75);
    // все раскрыты и строк не хватает — одна строка уходит под общую
    const q = planPanes(160, [open(), open(), open(), open()], O);
    expect(q.collapse).toEqual([0, 1]);
    expect(q.host).toBe(1);
    // совсем низкий график: всё в общей строке высотой с остаток
    const r = planPanes(30, [open(), shut()], O);
    expect(r.collapse).toEqual([0]);
    expect(r.host).toBe(1);
    expect(r.heights[1]).toBe(15);
  });

  it("панель, которую только что раскрыли из общей строки, остаётся раскрытой, даже если она выше прочих раскрытых", () => {
    // как в отзыве: 230 px — 4 строки, 11 панелей; раскрыты 3, 4, 7, 10 и пользователь раскрывает верхнюю 0
    const at = (expanded: number[], rank: Record<number, number> = {}) => Array.from({ length: 11 }, (_, i) => ({ want: 90, collapsed: !expanded.includes(i), rank: rank[i] ?? 0 }));
    expect(planPanes(230, at([3, 4, 7, 10]), O).collapse).toEqual([3]);
    const p = planPanes(230, at([0, 3, 4, 7, 10], { 0: 1 }), O);
    expect(p.collapse).not.toContain(0);
    expect(p.collapse).toEqual([3, 4]);
    expect(p.grouped[0]).toBe(false);
    expect(p.heights[0]).toBeGreaterThanOrEqual(24);
    // сворачиваются раньше раскрытые, а не верхние
    const q = planPanes(230, at([0, 3, 4, 7, 10], { 0: 5, 3: 4, 4: 1, 7: 3, 10: 2 }), O);
    expect(q.collapse).toEqual([4, 10]);
    // ранги равны — как прежде, верхние
    expect(planPanes(160, [open(), open(), open(), open(), shut()], O).collapse).toEqual([0, 1]);
  });

  it("свёртывание из-за нехватки строк — только раскладка: место вернулось — те же панели раскрыты", () => {
    const panes = [open(), open(), open(), open(), open(), shut()];
    expect(planPanes(150, panes, O).collapse.length).toBeGreaterThan(0);
    const back = planPanes(1200, panes, O);
    expect(back.collapse).toEqual([]);
    expect(back.host).toBeNull();
    expect(back.heights.slice(0, 5)).toEqual([90, 90, 90, 90, 90]);
  });
});
