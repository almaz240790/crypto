import { describe, expect, it } from "vitest";
import { dragSeparator, EMPTY_PANE_LAYOUT, isEmptyPaneLayout, mainMinShareFor, movePaneKey, normalizePaneLayout, orderPaneKeys, PANE_MAX_PX, planMaximized, planPanes, prunePaneLayout } from "../controller/paneManager";
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

describe("Управление панелями (ADR-0009): раскладка пользователя", () => {
  it("normalizePaneLayout: старое сохранение без поля и мусор — пустая раскладка; высоты в [paneMinPx, PANE_MAX_PX]", () => {
    expect(VIEW.desktop.paneMinPx).toBe(48);
    expect(normalizePaneLayout(undefined)).toEqual({ order: [], heights: {} });
    expect(normalizePaneLayout([1, 2])).toEqual({ order: [], heights: {} });
    expect(normalizePaneLayout({ order: "rsi#1", heights: [3] })).toEqual({ order: [], heights: {} });
    const l = normalizePaneLayout({ order: ["macd#1", "rsi#1", "macd#1", 7, "", "Bad Key", "oi", "x#0"], heights: { "rsi#1": 120.6, oi: 10, "macd#1": 1e9, bad: "90", "Нет": 90, ls: Number.NaN } });
    expect(l.order).toEqual(["macd#1", "rsi#1", "oi"]);
    expect(l.heights).toEqual({ "rsi#1": 121, oi: 48, "macd#1": PANE_MAX_PX });
    // идемпотентно
    expect(normalizePaneLayout(l)).toEqual(l);
    expect(normalizePaneLayout({ order: Array.from({ length: 50 }, (_, i) => `k${i}`) }).order).toHaveLength(32);
    expect(isEmptyPaneLayout(EMPTY_PANE_LAYOUT)).toBe(true);
    expect(isEmptyPaneLayout(l)).toBe(false);
  });

  it("prunePaneLayout: только живые панели; без изменений — та же ссылка", () => {
    const l = { order: ["rsi#1", "oi", "macd#1"], heights: { "rsi#1": 100, oi: 70 } };
    expect(prunePaneLayout(l, ["rsi#1", "oi", "macd#1"])).toBe(l);
    expect(prunePaneLayout(l, ["macd#1", "oi"])).toEqual({ order: ["oi", "macd#1"], heights: { oi: 70 } });
    expect(prunePaneLayout(l, [])).toEqual({ order: [], heights: {} });
  });

  it("orderPaneKeys: сохранённые — в своём порядке, новые — следом в порядке добавления", () => {
    expect(orderPaneKeys(["rsi#1", "macd#1", "oi"], ["oi", "rsi#1"])).toEqual(["oi", "rsi#1", "macd#1"]);
    expect(orderPaneKeys(["rsi#1", "macd#1"], [])).toEqual(["rsi#1", "macd#1"]);
    expect(orderPaneKeys(["a", "b"], ["x", "b", "y", "a"])).toEqual(["b", "a"]);
  });

  it("movePaneKey: выше и ниже; крайние — null", () => {
    const k = ["rsi#1", "macd#1", "oi"];
    expect(movePaneKey(k, "macd#1", -1)).toEqual(["macd#1", "rsi#1", "oi"]);
    expect(movePaneKey(k, "macd#1", 1)).toEqual(["rsi#1", "oi", "macd#1"]);
    expect(movePaneKey(k, "rsi#1", -1)).toBeNull();
    expect(movePaneKey(k, "oi", 1)).toBeNull();
    expect(movePaneKey(k, "nope", 1)).toBeNull();
  });

  it("dragSeparator: пара у границы меняется, сумма та же; доля основной и минимум панели держатся", () => {
    const h = [600, 90, 90];
    // граница основная | RSI: вниз на 30 — основная растёт, RSI сжимается
    expect(dragSeparator(h, 0, 1, 30, 400, 48)).toEqual([630, 60, 90]);
    // RSI не ниже 48
    expect(dragSeparator(h, 0, 1, 80, 400, 48)).toEqual([642, 48, 90]);
    // основная не ниже доли устройства
    expect(dragSeparator(h, 0, 1, -500, 400, 48)).toEqual([400, 290, 90]);
    // граница RSI | MACD: основная не меняется
    expect(dragSeparator(h, 1, 2, -20, 400, 48)).toEqual([600, 70, 110]);
    expect(dragSeparator(h, 1, 2, -200, 400, 48)).toEqual([600, 48, 132]);
    // мало места — без изменений; неверные индексы и NaN — копия
    expect(dragSeparator([600, 40, 40], 1, 2, 10, 400, 48)).toEqual([600, 40, 40]);
    expect(dragSeparator(h, 1, 5, 10, 400, 48)).toEqual(h);
    expect(dragSeparator(h, 1, 1, 10, 400, 48)).toEqual(h);
    expect(dragSeparator(h, 0, 1, Number.NaN, 400, 48)).toEqual(h);
  });

  it("planMaximized: развёрнутая получает всё, остальные и основная — заголовок", () => {
    expect(planMaximized(800, 3, 1, 24)).toEqual({ main: 24, others: [24, 728, 24] });
    const p = planMaximized(800, 1, 0, 24);
    expect(p.main + p.others[0]!).toBe(800);
    // неверный индекс — все свёрнуты, остаток основной
    expect(planMaximized(800, 2, 5, 24)).toEqual({ main: 752, others: [24, 24] });
    expect(planMaximized(0, 2, 0, 24)).toEqual({ main: 0, others: [] });
  });
});
