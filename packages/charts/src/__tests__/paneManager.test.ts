import { describe, expect, it } from "vitest";
import { commitPaneHeights, dragSeparator, EMPTY_PANE_LAYOUT, isEmptyPaneLayout, mainMinShareFor, movePaneKey, normalizePaneLayout, orderPaneKeys, PANE_MAX_PX, paneSqueeze, planMaximized, planPanes, prunePaneLayout, separatorRange, type SepLimits } from "../controller/paneManager";
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
    const lim: SepLimits = { minMain: 400, minPane: 48, squeezedMin: 24, squeezed: false };
    // граница основная | RSI: вниз на 30 — основная растёт, RSI сжимается
    expect(dragSeparator(h, 0, 1, 30, lim)).toEqual([630, 60, 90]);
    // RSI не ниже 48
    expect(dragSeparator(h, 0, 1, 80, lim)).toEqual([642, 48, 90]);
    // основная не ниже доли устройства
    expect(dragSeparator(h, 0, 1, -500, lim)).toEqual([400, 290, 90]);
    // граница RSI | MACD: основная не меняется
    expect(dragSeparator(h, 1, 2, -20, lim)).toEqual([600, 70, 110]);
    expect(dragSeparator(h, 1, 2, -200, lim)).toEqual([600, 48, 132]);
    // неверные индексы и NaN — копия
    expect(dragSeparator(h, 1, 5, 10, lim)).toEqual(h);
    expect(dragSeparator(h, 1, 1, 10, lim)).toEqual(h);
    expect(dragSeparator(h, 2, 1, 10, lim)).toEqual(h);
    expect(dragSeparator(h, 0, 1, Number.NaN, lim)).toEqual(h);
    // под пальцем предел выше (VIEW.paneMinTouchPx 72): RSI 90 | MACD 90 — ±18
    expect(VIEW.desktop.paneMinTouchPx).toBe(72);
    expect(separatorRange(h, 1, 2, { ...lim, minPane: 72, squeezedMin: 44 })).toEqual([-18, 18]);
  });

  it("сжатые окном панели (8 панелей на 1440×900): граница пары двигается, сжатая панель растёт за счёт соседки", () => {
    // planPanes(790, 8 × ~90, 0.55): основная ровно на доле, панели по 40–46 px — меньше paneMinPx 48
    const total = 790;
    const wants = [90, 90, 90, 90, 90, 90, 80, 80];
    const k = paneSqueeze(total, wants, 0.55);
    expect(k).toBeLessThan(1);
    const plan = planPanes(total, wants, 0.55);
    const h = [plan.main, ...plan.others];
    const lim: SepLimits = { minMain: total * 0.55, minPane: 48, squeezedMin: 24, squeezed: true };
    // RSI | MACD (45.7 + 45.7 < 96): делят место до заголовка 24 px, в обе стороны
    const [up, down] = separatorRange(h, 1, 2, lim);
    expect(up).toBeCloseTo(24 - h[1]!, 6);
    expect(down).toBeCloseTo(h[2]! - 24, 6);
    const next = dragSeparator(h, 1, 2, 15, lim);
    expect(next[1]).toBeCloseTo(h[1]! + 15, 6);
    expect(next[2]).toBeCloseTo(h[2]! - 15, 6);
    expect(next[1]! + next[2]!).toBeCloseTo(h[1]! + h[2]!, 6);
    // основная | RSI: основная на своей доле и при сжатии не растёт — граница стоит (ручка не показывается)
    expect(separatorRange(h, 0, 1, lim)).toEqual([0, 0]);
    expect(dragSeparator(h, 0, 1, 30, lim)).toEqual(h);
    // без сжатия основная растёт: [600, 40, 40] — пара ниже 48, делит место до 24
    expect(dragSeparator([600, 40, 40], 1, 2, 10, { ...lim, minMain: 400, squeezed: false })).toEqual([600, 50, 30]);
    // панель уже ниже предела, у соседки место есть: в начале не «прыгает» к 48, только растёт
    expect(separatorRange([600, 45, 100], 1, 2, { ...lim, squeezed: false })).toEqual([0, 52]);
    expect(dragSeparator([600, 45, 100], 1, 2, -10, { ...lim, squeezed: false })).toEqual([600, 45, 100]);
  });

  it("commitPaneHeights: только пара у границы, в желаемых px (÷ k); остальные записи и основная — без изменений", () => {
    // 1024×768, RSI | MACD без сжатия: OI в раскладку не попадает
    expect(commitPaneHeights({}, [["rsi#1", 70], ["macd#1", 110]], 1)).toEqual({ "rsi#1": 70, "macd#1": 110 });
    // основная записи не имеет; чужие записи остаются
    expect(commitPaneHeights({ oi: 120 }, [[null, 400], ["rsi#1", 60]], 1)).toEqual({ oi: 120, "rsi#1": 60 });
    // пять панелей сжаты (k = 0.651): 69 и 49 px на экране — 106 и 75 в раскладке; план их возвращает к 69 и 49
    const total = 651;
    const before = [90, 90, 90, 90, 90];
    const k = paneSqueeze(total, before, 0.55);
    const saved = commitPaneHeights({}, [["rsi#1", 90 * k + 10], ["macd#1", 90 * k - 10]], k);
    expect(Object.keys(saved)).toEqual(["rsi#1", "macd#1"]);
    const replanned = planPanes(total, [saved["rsi#1"]!, saved["macd#1"]!, 90, 90, 90], 0.55);
    expect(replanned.others[0]).toBeCloseTo(90 * k + 10, 0);
    expect(replanned.others[1]).toBeCloseTo(90 * k - 10, 0);
    // нетронутые панели — та же сжатая высота, а на высоком окне — свои 90, а не сжатые px
    expect(replanned.others[2]).toBeCloseTo(90 * k, 0);
    expect(planPanes(1200, [saved["rsi#1"]!, saved["macd#1"]!, 90, 90, 90], 0.55).others.slice(2)).toEqual([90, 90, 90]);
    // пределы записи: не ниже paneMinPx, не выше PANE_MAX_PX; NaN не пишется
    expect(commitPaneHeights({}, [["rsi#1", 10], ["oi", 1e9], ["ls", Number.NaN]], 1)).toEqual({ "rsi#1": 48, oi: PANE_MAX_PX });
    expect(paneSqueeze(0, [90], 0.55)).toBe(1);
    expect(paneSqueeze(800, [], 0.55)).toBe(1);
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
