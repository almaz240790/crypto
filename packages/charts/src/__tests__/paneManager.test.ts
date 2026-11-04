import { describe, expect, it } from "vitest";
import { commitPaneHeights, dragSeparator, EMPTY_PANE_LAYOUT, fitHeights, GROUPED_PX, isEmptyPaneLayout, mainMinShareFor, MAXIMIZED_MIN_SHARE, movePaneKey, normalizePaneLayout, orderPaneKeys, PANE_MAX_PX, planMaximized, planPanes, prunePaneLayout, separatorRange, type PaneWant, type SepLimits } from "../controller/paneManager";
import { VIEW } from "../presets";

const open = (want = 90): PaneWant => ({ want, collapsed: false });
const shut = (want = 80): PaneWant => ({ want, collapsed: true });
const sum = (a: readonly number[]) => a.reduce((x, y) => x + y, 0);
/** Опции плана: доля основной и строка заголовка (24 px; под пальцем — 44). */
const at = (mainMinShare: number, rowPx = 24) => ({ mainMinShare, rowPx });
/** Желаемые высоты — все раскрыты (как wants до общей строки). */
const opened = (wants: readonly number[]) => wants.map((w) => open(w));

describe("PaneManager: высоты панелей (план 2A.7, M19)", () => {
  it("доля основной панели: десктоп 0.55, телефон и ячейка 0.6", () => {
    expect(VIEW.desktop.mainMinShare).toBe(0.55);
    expect(VIEW.phone.mainMinShare).toBe(0.6);
    expect(mainMinShareFor("desktop")).toBe(0.55);
    expect(mainMinShareFor("phone")).toBe(0.6);
    expect(mainMinShareFor("cell")).toBe(0.6);
  });

  it("панели помещаются — получают свою высоту, основной — остаток", () => {
    const p = planPanes(800, [open(90), open(80)], at(0.55));
    expect(p.others).toEqual([90, 80]);
    expect(p.main).toBe(630);
    expect(p.k).toBe(1);
  });

  it("не помещаются — сжимаются пропорционально (k), основная — на своей доле с точностью до пикселя", () => {
    // десктоп 816 px, RSI + MACD + OI + фандинг: 90 + 90 + 80 + 80 = 340 ≤ 816 · 0.45 = 367.2 — помещаются
    expect(planPanes(816, opened([90, 90, 80, 80]), at(0.55)).main).toBe(476);
    // пять панелей по 90: 450 > 367 → основная 55 % (целые пиксели: не меньше доли и не больше чем на пиксель)
    const p = planPanes(816, opened([90, 90, 90, 90, 90]), at(0.55));
    expect(p.main).toBeGreaterThanOrEqual(816 * 0.55);
    expect(p.main - 816 * 0.55).toBeLessThan(1);
    expect(Math.abs(p.others[0]! - p.others[4]!)).toBeLessThanOrEqual(1);
    expect(p.k).toBeCloseTo(367 / 450, 9);
    for (const h of p.others) expect(Number.isInteger(h)).toBe(true);
    // телефон: 0.6
    const ph = planPanes(600, opened([90, 90, 90]), at(0.6));
    expect(ph.main).toBe(360);
    expect(sum(ph.others)).toBe(240);
  });

  it("свёрнутая панель — строка заголовка (24 px, под пальцем 44), крайние значения", () => {
    expect(planPanes(700, [shut(), open(90)], at(0.55))).toMatchObject({ main: 586, others: [24, 90], host: null, collapse: [] });
    expect(planPanes(700, [shut(), open(90)], at(0.55, 44)).others).toEqual([44, 90]);
    expect(planPanes(0, [open()], at(0.55))).toMatchObject({ main: 0, others: [] });
    expect(planPanes(500, [], at(0.55))).toMatchObject({ main: 500, others: [] });
    // высота меньше 1 — 1 px; доля вне [0, 1] ограничивается
    expect(planPanes(100, [open(0)], at(0.5)).others).toEqual([1]);
    expect(planPanes(100, [open(80)], at(2)).main).toBe(100);
    expect(planPanes(100, [open(80)], at(-1)).main).toBe(20);
  });
});

/**
 * Строки панелей (продовый баг из PR 139: на телефоне свёрнутые «Открытый интерес», «Ликвидации», «Лонг/шорт»
 * сжимались до 10 px, и их заголовки налезали друг на друга и на подписи шкалы времени).
 */
describe("PaneManager: строки заголовков и общая строка «ещё N панелей»", () => {
  const O = at(0.5);

  it("высоты раскрытых: помещаются — желаемые; нет — по множителю, но не ниже строки заголовка", () => {
    expect(fitHeights([90, 80], 200, 24)).toEqual({ heights: [90, 80], k: 1 });
    expect(fitHeights([90, 90], 90, 24)).toEqual({ heights: [45, 45], k: 0.5 });
    // маленькая упирается в минимум, остаток — большой
    const h = fitHeights([200, 20], 100, 24);
    expect(h.heights[1]).toBe(24);
    expect(h.heights[0]).toBeCloseTo(76, 9);
    expect(h.k).toBeCloseTo(76 / 200, 9);
    expect(fitHeights([], 50, 24).heights).toEqual([]);
    // все упёрлись в строку: k — доля бюджета
    expect(fitHeights([10, 10], 10, 24)).toEqual({ heights: [24, 24], k: 0.5 });
  });

  it("как у владельца (телефон, 610 px, 6 раскрытых и 3 свёрнутые): у свёрнутых ровно строка, главная — не меньше доли", () => {
    const p = planPanes(610, [open(), open(), open(), open(), open(), open(80), shut(), shut(), shut()], O);
    expect(p.host).toBeNull();
    expect(p.collapse).toEqual([]);
    expect(p.grouped.every((g) => !g)).toBe(true);
    expect(p.others.slice(6)).toEqual([24, 24, 24]);
    for (const h of p.others.slice(0, 6)) expect(h).toBeGreaterThanOrEqual(24);
    expect(p.main).toBeGreaterThanOrEqual(305);
    expect(p.k).toBeLessThan(1);
  });

  it("место есть — желаемые высоты, главной — остаток; график не размечен — без изменений", () => {
    expect(planPanes(900, [open(), shut()], O).others).toEqual([90, 24]);
    expect(planPanes(900, [], O).others).toEqual([]);
    expect(planPanes(0, [open(), shut()], O)).toEqual({ main: 0, others: [], grouped: [], host: null, collapse: [], k: 1 });
  });

  it("строк не хватает (телефон боком): свёрнутые — в одну общую строку у последней свёрнутой, раскрытые — в остатке", () => {
    // 250 px: на панели 125 px — 5 строк, панелей 8
    const p = planPanes(250, [open(), shut(), shut(), open(), shut(), shut(), shut(), shut()], O);
    expect(p.collapse).toEqual([]);
    expect(p.host).toBe(7);
    expect(p.grouped).toEqual([false, true, true, false, true, true, true, true]);
    expect(p.others[7]).toBe(24);
    for (const i of [1, 2, 4, 5, 6]) expect(p.others[i]).toBe(GROUPED_PX);
    expect(p.others[0]).toBeGreaterThanOrEqual(24);
    expect(p.others[3]).toBeGreaterThanOrEqual(24);
    expect(p.main).toBeGreaterThanOrEqual(125);
    // под пальцем строка 44 px: те же 250 px — 2 строки, общая строка 44
    const touch = planPanes(250, [open(), shut(), shut(), open(), shut()], at(0.5, 44));
    expect(touch.others[touch.host!]).toBe(44);
    expect(touch.main).toBeGreaterThanOrEqual(125);
  });

  it("раскрытым тоже не хватает строк — верхние сворачиваются в общую строку", () => {
    // 160 px: 80 px — 3 строки; раскрытых 4 и свёрнутая 1: остаются 2 нижние раскрытые и общая строка
    const p = planPanes(160, [open(), open(), open(), open(), shut()], O);
    expect(p.collapse).toEqual([0, 1]);
    expect(p.grouped).toEqual([true, true, false, false, true]);
    expect(p.host).toBe(4);
    expect(p.main).toBeGreaterThanOrEqual(80);
    // целые пиксели: LWC округляет высоты и остаток отдаёт последней панели
    for (const h of p.others) expect(Number.isInteger(h)).toBe(true);
    // полоски свёрнутых тоже занимают место: на 150 px две раскрытые уже не влезают
    const tight = planPanes(150, [open(), open(), open(), open(), shut()], O);
    expect(tight.collapse).toEqual([0, 1, 2]);
    expect(tight.main).toBeGreaterThanOrEqual(75);
    // все раскрыты и строк не хватает — одна строка уходит под общую
    const q = planPanes(160, [open(), open(), open(), open()], O);
    expect(q.collapse).toEqual([0, 1]);
    expect(q.host).toBe(1);
    // совсем низкий график: всё в общей строке высотой с остаток
    const r = planPanes(30, [open(), shut()], O);
    expect(r.collapse).toEqual([0]);
    expect(r.host).toBe(1);
    expect(r.others[1]).toBe(15);
  });

  it("панель, которую только что раскрыли из общей строки, остаётся раскрытой, даже если она выше прочих раскрытых", () => {
    // 230 px: 4 строки, 11 панелей; раскрыты 3, 4, 7, 10 и пользователь раскрывает верхнюю 0
    const of = (expanded: number[], rank: Record<number, number> = {}) => Array.from({ length: 11 }, (_, i) => ({ want: 90, collapsed: !expanded.includes(i), rank: rank[i] ?? 0 }));
    expect(planPanes(230, of([3, 4, 7, 10]), O).collapse).toEqual([3]);
    const p = planPanes(230, of([0, 3, 4, 7, 10], { 0: 1 }), O);
    expect(p.collapse).not.toContain(0);
    expect(p.collapse).toEqual([3, 4]);
    expect(p.grouped[0]).toBe(false);
    expect(p.others[0]).toBeGreaterThanOrEqual(24);
    // сворачиваются раньше раскрытые, а не верхние
    expect(planPanes(230, of([0, 3, 4, 7, 10], { 0: 5, 3: 4, 4: 1, 7: 3, 10: 2 }), O).collapse).toEqual([4, 10]);
    // ранги равны — как прежде, верхние
    expect(planPanes(160, [open(), open(), open(), open(), shut()], O).collapse).toEqual([0, 1]);
  });

  it("свёртывание из-за нехватки строк — только раскладка: место вернулось — те же панели раскрыты", () => {
    const panes = [open(), open(), open(), open(), open(), shut()];
    expect(planPanes(150, panes, O).collapse.length).toBeGreaterThan(0);
    const back = planPanes(1200, panes, O);
    expect(back.collapse).toEqual([]);
    expect(back.host).toBeNull();
    expect(back.others.slice(0, 5)).toEqual([90, 90, 90, 90, 90]);
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
    // planPanes(790, 8 × ~90, 0.55): основная на доле (с точностью до пикселя), панели по 40–46 px — меньше paneMinPx 48
    const total = 790;
    const wants = [90, 90, 90, 90, 90, 90, 80, 80];
    const plan = planPanes(total, opened(wants), at(0.55));
    expect(plan.k).toBeLessThan(1);
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
    // пять панелей сжаты (k = 0.649): 68 и 48 px на экране — 106 и 75 в раскладке; план их возвращает к 68 и 48
    // (целые пиксели — с точностью до пикселя)
    const total = 651;
    const k = planPanes(total, opened([90, 90, 90, 90, 90]), at(0.55)).k;
    expect(k).toBeLessThan(1);
    const saved = commitPaneHeights({}, [["rsi#1", 90 * k + 10], ["macd#1", 90 * k - 10]], k);
    expect(Object.keys(saved)).toEqual(["rsi#1", "macd#1"]);
    const replanned = planPanes(total, opened([saved["rsi#1"]!, saved["macd#1"]!, 90, 90, 90]), at(0.55));
    expect(Math.abs(replanned.others[0]! - (90 * k + 10))).toBeLessThanOrEqual(1);
    expect(Math.abs(replanned.others[1]! - (90 * k - 10))).toBeLessThanOrEqual(1);
    // нетронутые панели — та же сжатая высота, а на высоком окне — свои 90, а не сжатые px
    expect(Math.abs(replanned.others[2]! - 90 * k)).toBeLessThanOrEqual(1);
    expect(planPanes(1200, opened([saved["rsi#1"]!, saved["macd#1"]!, 90, 90, 90]), at(0.55)).others.slice(2)).toEqual([90, 90, 90]);
    // пределы записи: не ниже paneMinPx, не выше PANE_MAX_PX; NaN не пишется
    expect(commitPaneHeights({}, [["rsi#1", 10], ["oi", 1e9], ["ls", Number.NaN]], 1)).toEqual({ "rsi#1": 48, oi: PANE_MAX_PX });
    expect(planPanes(0, [open()], at(0.55)).k).toBe(1);
    expect(planPanes(800, [], at(0.55)).k).toBe(1);
  });

  it("planMaximized: развёрнутая получает всё, остальные и основная — заголовок", () => {
    expect(planMaximized(800, 3, 1, 24)).toMatchObject({ main: 24, others: [24, 728, 24], host: null });
    const p = planMaximized(800, 1, 0, 24);
    expect(p.main + p.others[0]!).toBe(800);
    // неверный индекс — все свёрнуты, остаток основной
    expect(planMaximized(800, 2, 5, 24)).toMatchObject({ main: 752, others: [24, 24] });
    expect(planMaximized(0, 2, 0, 24)).toMatchObject({ main: 0, others: [] });
  });

  it("planMaximized на низком экране: строк на все заголовки нет — остальные в общей строке, развёрнутая не налезает", () => {
    // телефон боком под пальцем: 11 панелей по строке 44 px не помещаются в 300 px
    const p = planMaximized(300, 11, 2, 44);
    expect(p.main).toBe(44);
    expect(p.host).toBe(10);
    expect(p.grouped.filter(Boolean)).toHaveLength(10);
    expect(p.grouped[2]).toBe(false);
    expect(p.others[10]).toBe(44);
    for (const i of [0, 1, 3, 4, 5, 6, 7, 8, 9]) expect(p.others[i]).toBe(GROUPED_PX);
    expect(p.others[2]).toBe(300 - 44 - 44 - 9 * GROUPED_PX);
    expect(p.main + sum(p.others)).toBe(300);
    // развёрнута последняя — общая строка у предпоследней
    expect(planMaximized(300, 11, 10, 44).host).toBe(9);
    // место есть — у каждой своя строка
    expect(planMaximized(800, 11, 2, 24).host).toBeNull();
  });

  it("planMaximized на телефоне: заголовки остальных оставили бы развёрнутой меньше 60 % — общая строка", () => {
    // iPhone SE 375×667 и 390×844: семь панелей под пальцем — раньше развёрнутой 77 и 255 px под шестью заголовками
    for (const total of [385, 571]) {
      const p = planMaximized(total, 7, 6, 44);
      expect(p.host).toBe(5);
      expect(p.grouped.filter(Boolean)).toHaveLength(6);
      expect(p.others[6]).toBe(total - 44 - 44 - 5 * GROUPED_PX);
      expect(p.others[6]).toBeGreaterThanOrEqual(MAXIMIZED_MIN_SHARE * total);
      expect(p.main + sum(p.others)).toBe(total);
    }
    // две панели — заголовков мало, у каждой своя строка
    expect(planMaximized(571, 2, 1, 44).host).toBeNull();
    // десктоп: семь заголовков по 24 px в 700 px — своя строка у каждой
    expect(planMaximized(700, 7, 3, 24).host).toBeNull();
  });
});
