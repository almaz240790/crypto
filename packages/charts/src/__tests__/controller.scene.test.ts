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

function setup(o: { width?: number; device?: "auto" | "cell"; candles?: Candle[] } = {}) {
  const queue: (() => void)[] = [];
  const store = createChartStore();
  const el = fakeElement(o.width ?? 1000);
  let term!: FakeTerminal;
  let themeVersion = 0;
  const ctrl = new ChartController({
    container: el,
    store,
    device: o.device ?? "auto",
    coarse: false,
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

  it("наведение пишет hover с подсказкой и расстоянием от живой цены", () => {
    const { ctrl, store, term, flush } = setup();
    ctrl.set({ text: RU_TEXT, structure: fx.structure });
    flush();
    const obj = ctrl.currentScene!.objects.find((o) => o.layer === "sr")!;
    term.env.chart.moves.forEach((cb) => cb({ hoveredInfo: { objectId: obj.id }, point: { x: 10, y: 20 } }));
    const h = store.getState().hover!;
    expect(h).toMatchObject({ objectId: obj.id, x: 10, y: 20, pinned: false });
    expect(h.info.title).toBe(obj.hover.title);
    expect(h.distancePct).not.toBeNull();
    term.env.chart.moves.forEach((cb) => cb({ point: { x: 10, y: 20 } }));
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
