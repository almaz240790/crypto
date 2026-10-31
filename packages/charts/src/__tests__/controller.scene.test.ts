import { describe, expect, it } from "vitest";
import { ChartController } from "../controller/ChartController";
import { monoMeasurer } from "../layout/measure";
import { barsForWidth, VIEW, type MarkupSettings } from "../presets";
import { RU_TEXT } from "../scene/text";
import { createChartStore } from "../store/chartStore";
import type { Terminal } from "../terminal";
import type { Candle } from "../types";
import { bars, FakeTerminal, fakeElement, H, makeTheme, T0 } from "./fakes/lwc";
import { loadFixture } from "./fixtures/scene/load";

/** Каркас контроллера (план 2B.2, §11.2): стадии в одном кадре, тема и тик без пересборки сцены, смена устройства. */

function setup(o: { width?: number; device?: "auto" | "cell"; candles?: Candle[]; coarse?: boolean } = {}) {
  const queue: (() => void)[] = [];
  const store = createChartStore();
  const el = fakeElement(o.width ?? 1000);
  let term!: FakeTerminal;
  let themeVersion = 0;
  const ctrl = new ChartController({
    container: el,
    store,
    device: o.device ?? "auto",
    coarse: o.coarse ?? false,
    observe: false,
    onNeedOlder: async () => null,
    createTerminal: () => {
      term = new FakeTerminal(o.candles ?? bars(300), { width: (o.width ?? 1000) - 60 });
      return term as unknown as Terminal;
    },
    readTheme: (_el, _view, version) => {
      themeVersion = version;
      return makeTheme(version);
    },
    measure: monoMeasurer(),
    schedule: (fn) => queue.push(fn),
  });
  const flush = () => {
    while (queue.length) queue.shift()!();
  };
  return { ctrl, store, el, term, flush, queue, theme: () => themeVersion };
}

const fx = loadFixture("btc-4h-rich");

describe("ChartController: стадии сцены", () => {
  it("первый кадр строит сцену и публикует каталог и легенду", () => {
    const { ctrl, store, flush } = setup();
    ctrl.set({ text: RU_TEXT, tf: "4h", structure: fx.structure });
    flush();
    expect(ctrl.stats.sceneBuilds).toBe(1);
    expect(store.getState().sceneIndex).toBe(ctrl.currentScene!.index);
    expect(store.getState().legend.map((l) => l.key)).toContain("price");
    expect(store.getState().status).toMatchObject({ ready: true, device: "desktop", themeVersion: 1 });
  });

  it("без текстов сцены нет (ждём chartText из web)", () => {
    const { ctrl, flush } = setup();
    flush();
    expect(ctrl.currentScene).toBeUndefined();
  });

  it("смена темы не вызывает buildScene: только перерисовка из палитры", () => {
    const { ctrl, store, term, flush } = setup();
    ctrl.set({ text: RU_TEXT, structure: fx.structure });
    flush();
    const scene = ctrl.currentScene;
    ctrl.themeChanged();
    flush();
    expect(ctrl.currentScene).toBe(scene);
    expect(ctrl.stats.sceneBuilds).toBe(1);
    expect(term.calls).toContain("setTheme");
    expect(store.getState().status.themeVersion).toBe(2);
    expect(ctrl.overlay.theme.version).toBe(2);
  });

  it("notifyCandles('tick') не пересобирает сцену и не планирует кадр", () => {
    const { ctrl, flush, queue, term } = setup();
    ctrl.set({ text: RU_TEXT, structure: fx.structure });
    flush();
    term.candlesArr = [...term.candlesArr.slice(0, -1), { ...term.candlesArr.at(-1)!, close: 101, open_: true }];
    ctrl.notifyCandles("tick");
    expect(queue).toHaveLength(0);
    flush();
    expect(ctrl.stats.sceneBuilds).toBe(1);
  });

  it("закрытие свечи (append) — ровно одна пересборка", () => {
    const { ctrl, flush, term } = setup();
    ctrl.set({ text: RU_TEXT, structure: fx.structure });
    flush();
    term.candlesArr = [...term.candlesArr, ...bars(1, 300)];
    ctrl.notifyCandles("append");
    ctrl.notifyCandles("append");
    flush();
    expect(ctrl.stats.sceneBuilds).toBe(2);
    expect(ctrl.stats.flushes).toBe(2);
  });

  it("set с теми же значениями ничего не делает", () => {
    const { ctrl, flush, queue } = setup();
    const markup: MarkupSettings = { preset: "clean", overrides: {} };
    ctrl.set({ text: RU_TEXT, markup, structure: fx.structure });
    flush();
    ctrl.set({ markup, text: RU_TEXT, structure: fx.structure });
    expect(queue).toHaveLength(0);
    // новый объект с тем же содержимым — кадр есть, но сцена та же (ключ сцены не изменился)
    ctrl.set({ markup: { preset: "clean", overrides: {} } });
    flush();
    expect(ctrl.stats.sceneBuilds).toBe(1);
  });

  it("смена пресета пересобирает сцену", () => {
    const { ctrl, flush } = setup();
    ctrl.set({ text: RU_TEXT, structure: fx.structure });
    flush();
    ctrl.set({ markup: { preset: "detailed", overrides: {} } });
    flush();
    expect(ctrl.stats.sceneBuilds).toBe(2);
  });

  it("смена устройства: шрифт шкалы, отступ справа в пикселях, формат и пересборка сцены", () => {
    const { ctrl, el, term, store, flush } = setup({ width: 1000 });
    ctrl.set({ text: RU_TEXT, structure: fx.structure });
    flush();
    term.calls.length = 0;
    (el as { clientWidth: number }).clientWidth = 390;
    ctrl.resized();
    flush();
    expect(term.calls).toContain(`setRightOffsetPx:${VIEW.phone.rightOffsetPx}`);
    expect(term.calls).toContain(`setFontSize:${VIEW.phone.scaleFontPx}`);
    expect(term.calls).toContain("setPriceFormat");
    expect(ctrl.stats.sceneBuilds).toBe(2);
    expect(store.getState().status.device).toBe("phone");
    // та же ширина — ничего
    ctrl.resized();
    flush();
    expect(ctrl.stats.sceneBuilds).toBe(2);
  });

  it("ячейка мультичарта — всегда cell, независимо от ширины", () => {
    const { ctrl, store, flush } = setup({ device: "cell", width: 1200 });
    ctrl.set({ text: RU_TEXT });
    flush();
    expect(store.getState().status.device).toBe("cell");
    ctrl.resized();
    flush();
    expect(store.getState().status.device).toBe("cell");
  });

  it("replace сбрасывает вид по ширине области (barsForWidth); ⟲ и двойной клик — так же", () => {
    const { ctrl, term } = setup();
    ctrl.set({ tf: "4h" });
    ctrl.notifyCandles("replace");
    const n = barsForWidth(940, VIEW.desktop, "4h");
    expect(term.calls).toContain(`resetView:${n}`);
    term.calls.length = 0;
    ctrl.handle.reset();
    expect(term.calls).toEqual([`resetView:${n}`]);
    ctrl.handle.zoom(1.25);
    expect(term.calls).toContain("zoom:1.25");
  });

  it("выбор в store пересобирает сцену с выбранным объектом; клик мимо снимает выбор", () => {
    const { ctrl, store, term, flush } = setup();
    ctrl.set({ text: RU_TEXT, structure: fx.structure });
    flush();
    const id = ctrl.currentScene!.objects.find((o) => o.kind === "hline")!.id;
    store.select(id);
    flush();
    expect(ctrl.currentScene!.selected).toBe(id);
    expect(ctrl.sceneObject(id)?.emphasis).toBe("selected");
    // клик по объекту (hoveredInfo.objectId) — выбор; повторный клик — снятие; клик мимо — снятие
    const click = (objectId?: string) => term.env.chart.clicks.forEach((cb) => cb({ hoveredInfo: objectId ? { objectId } : undefined, point: { x: 1, y: 1 } }));
    click(id);
    expect(store.getState().selection).toBeNull();
    click(id);
    expect(store.getState().selection).toBe(id);
    click();
    expect(store.getState().selection).toBeNull();
  });

  it("новый инструмент (replace) снимает выбор и считает аналитику заново", () => {
    const { ctrl, store, flush } = setup();
    ctrl.set({ text: RU_TEXT, structure: fx.structure });
    flush();
    store.select(ctrl.currentScene!.objects[0]!.id);
    flush();
    ctrl.notifyCandles("replace");
    expect(store.getState().selection).toBeNull();
    flush();
    expect(ctrl.currentScene!.selected).toBeNull();
  });

  it("наведение пишет hover раз в кадр: подсказка, тон, цена по шагу, расстояние от живой цены", () => {
    const { ctrl, store, term, flush } = setup();
    ctrl.set({ text: RU_TEXT, structure: fx.structure, tick: "0.1" });
    flush();
    const obj = ctrl.currentScene!.objects.find((o) => o.layer === "sr")!;
    const move = (p: unknown) => term.env.chart.moves.forEach((cb) => cb(p));
    move({ hoveredInfo: { objectId: obj.id }, point: { x: 5, y: 5 } });
    move({ hoveredInfo: { objectId: obj.id }, point: { x: 10, y: 20 } });
    expect(store.getState().hover).toBeNull(); // запись — в следующем кадре, последним положением
    flush();
    const h = store.getState().hover!;
    expect(h).toMatchObject({ objectId: obj.id, x: 10, y: 20, pinned: false, tone: obj.tone });
    expect(h.info.title).toBe(obj.hover.title);
    expect(h.priceText).toMatch(/^\d[\d\s\u202f]*\.\d$/);
    expect(h.distancePct).not.toBeNull();
    expect(h.plot.width).toBeGreaterThan(0);
    move({ point: { x: 10, y: 20 } });
    flush();
    expect(store.getState().hover).toBeNull();
  });

  it("зона: в подсказке диапазон «от … до …»; объект пропал из сцены — подсказка тоже", () => {
    const { ctrl, store, term, flush } = setup();
    ctrl.set({ text: RU_TEXT, structure: fx.structure, markup: { preset: "levels", overrides: {} } });
    flush();
    const zone = ctrl.currentScene!.objects.find((o) => o.kind === "box")!;
    term.env.chart.moves.forEach((cb) => cb({ hoveredInfo: { objectId: zone.id }, point: { x: 1, y: 1 } }));
    flush();
    expect(store.getState().hover!.priceText).toMatch(/^от .+ до .+$/);
    ctrl.set({ markup: { preset: "clean", overrides: { zones: false } } });
    flush();
    expect(store.getState().hover).toBeNull();
  });

  it("палец: тап по объекту выбирает и закрепляет карточку, тап мимо — снимает; движение перекрестия подсказку не трогает", () => {
    const { ctrl, store, term, flush } = setup({ coarse: true });
    ctrl.set({ text: RU_TEXT, structure: fx.structure });
    flush();
    ctrl.overlay.updateAllViews();
    const sr = ctrl.currentScene!.objects.find((o) => o.kind === "hline" && o.layer === "sr")!;
    const y = term.env.series.priceToCoordinate((sr as { price: number }).price) as number;
    const id = ctrl.overlay.hitTest(100, y)?.externalId;
    expect(id).toBeDefined();
    const tap = (p: unknown) => term.env.chart.clicks.forEach((cb) => cb(p));
    // у тапа LWC не делает hitTest: hoveredInfo устарел или пуст — контроллер считает попадание сам
    tap({ point: { x: 100, y }, hoveredInfo: { objectId: "устарел" } });
    expect(store.getState().selection).toBe(id);
    expect(store.getState().hover).toMatchObject({ objectId: id, pinned: true });
    term.env.chart.moves.forEach((cb) => cb({ point: { x: 3, y: 3 } }));
    flush();
    expect(store.getState().hover?.pinned).toBe(true);
    tap({ point: { x: 100, y: y + 200 } });
    expect(store.getState().selection).toBeNull();
    expect(store.getState().hover).toBeNull();
    // Esc или крестик карточки: select(null) снимает и закреплённую подсказку
    tap({ point: { x: 100, y } });
    expect(store.getState().hover?.pinned).toBe(true);
    store.select(null);
    expect(store.getState().hover).toBeNull();
    // повторный тап по выбранному объекту — снять выбор
    tap({ point: { x: 100, y } });
    tap({ point: { x: 100, y } });
    expect(store.getState().selection).toBeNull();
    expect(store.getState().hover).toBeNull();
  });

  it("focus: строка «Найдено» выбирает объект и прокручивает к нему; отрезанный лимитом — после пересборки сцены", () => {
    const { ctrl, store, term, flush } = setup({ candles: fx.candles });
    ctrl.set({ text: RU_TEXT, structure: fx.structure });
    flush();
    const row = ctrl.currentScene!.index.levels.find((r) => r.layer === "zones" && !r.onChart)!;
    expect(row).toBeDefined();
    term.env.chart.state.range = { from: 0, to: 10 };
    ctrl.handle.focus({ objectId: row.id });
    expect(store.getState().selection).toBe(row.id);
    expect(term.env.chart.state.range).toEqual({ from: 0, to: 10 }); // объекта ещё нет в сцене
    flush();
    expect(ctrl.sceneObject(row.id)?.emphasis).toBe("selected");
    const r = term.env.chart.state.range;
    expect(r.to - r.from).toBeCloseTo(10);
    expect(r.from).not.toBe(0); // время зоны — на 70 % ширины (зона старше буфера: левее первой свечи)
    // нарисованный объект в кадре — вид не двигается
    const before = { ...term.env.chart.state.range };
    ctrl.handle.focus({ objectId: row.id });
    expect(term.env.chart.state.range).toEqual(before);
  });

  it("ширина области сменилась, а вид после сброса не трогали — сброс заново; после масштаба или прокрутки — нет", () => {
    const { ctrl, term, flush } = setup();
    ctrl.set({ text: RU_TEXT, structure: fx.structure });
    ctrl.notifyCandles("replace");
    flush();
    const resets = () => term.calls.filter((c) => c.startsWith("resetView")).length;
    const size = (w: number) => {
      term.env.chart.state.width = w;
      term.env.chart.timeScale().sizeCbs.forEach((cb) => cb(w, 400));
      flush(); // проверка — в следующем кадре
    };
    const n0 = resets();
    size(930);
    expect(resets()).toBe(n0 + 1);
    // прокрутка (правый край сдвинулся) — вид пользователя не сбрасывается
    term.env.chart.state.range = { from: 10, to: 100 };
    size(920);
    expect(resets()).toBe(n0 + 1);
    // ⟲ — снова «нетронутый» вид; масштаб кнопкой — уже нет
    ctrl.handle.reset();
    size(910);
    expect(resets()).toBe(n0 + 3);
    ctrl.handle.zoom(1.25);
    size(900);
    expect(resets()).toBe(n0 + 3);
  });

  it("мышь: клик без hoveredInfo — попадание по кадру примитива", () => {
    const { ctrl, store, term, flush } = setup();
    ctrl.set({ text: RU_TEXT, structure: fx.structure });
    flush();
    ctrl.overlay.updateAllViews();
    const sr = ctrl.currentScene!.objects.find((o) => o.kind === "hline" && o.layer === "sr")!;
    const y = term.env.series.priceToCoordinate((sr as { price: number }).price) as number;
    term.env.chart.clicks.forEach((cb) => cb({ point: { x: 100, y } }));
    expect(store.getState().selection).toBe(ctrl.overlay.hitTest(100, y)!.externalId);
    expect(store.getState().hover).toBeNull();
  });

  it("подгрузка истории: addOlder и historyRev; устаревший ответ после смены инструмента отбрасывается", async () => {
    let resolve!: (v: { candles: Candle[]; hasOlder: boolean }) => void;
    const store = createChartStore();
    let term!: FakeTerminal;
    const ctrl = new ChartController({
      container: fakeElement(),
      store,
      device: "auto",
      coarse: false,
      observe: false,
      onNeedOlder: () => new Promise((r) => (resolve = r)),
      createTerminal: (_el, opts) => {
        term = new FakeTerminal(bars(10));
        (term as unknown as { need: (b: number) => void }).need = opts.onNeedOlder!;
        return term as unknown as Terminal;
      },
      readTheme: () => makeTheme(),
      measure: monoMeasurer(),
      schedule: () => {},
    });
    const need = (term as unknown as { need: (b: number) => void }).need;
    need(T0);
    resolve({ candles: bars(5, -5), hasOlder: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(term.calls).toContain("addOlder");
    expect(store.getState().status.historyRev).toBe(1);
    need(T0 - 5 * H);
    ctrl.notifyCandles("replace");
    resolve({ candles: bars(5, -10), hasOlder: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(term.calls.filter((c) => c === "addOlder")).toHaveLength(1);
    ctrl.destroy();
    expect(term.calls).toContain("destroy");
  });
});
