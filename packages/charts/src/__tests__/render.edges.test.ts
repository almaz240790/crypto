import { afterEach, describe, expect, it, vi } from "vitest";
import { AxisCountdown } from "../controller/axisCountdown";
import { monoMeasurer } from "../layout/measure";
import { VIEW } from "../presets";
import { AxisViewPool } from "../render/axisViews";
import { OverlayPrimitive } from "../render/OverlayPrimitive";
import { timeToIndex } from "../render/projector";
import type { GlyphObject, HeatObject, HLineObject, Scene, SceneObject } from "../scene/types";
import { bars, fakeElement, H, makeEnv, makeTheme, T0 } from "./fakes/lwc";

/** Края отрисовки: проекция времени, жест на телефоне, препятствия интерфейса, тепловая карта, пул и DOM-отсчёт. */

const line = (price: number, id = `sr:S:${price}`, extra: Partial<HLineObject> = {}): HLineObject => ({
  kind: "hline",
  id,
  layer: "sr",
  tone: "up",
  priority: 40,
  hover: { title: "Поддержка", price },
  label: { text: "Подд.", tone: "up", priority: 40, slots: ["free-below", "free-above", "line-end-below"], font: "sans", show: "always" },
  axis: { text: String(price), tone: "up", style: "outline", priority: 40, group: "sr" },
  emphasis: "normal",
  price,
  from: null,
  to: null,
  style: "dashed",
  width: 1,
  ...extra,
});

function sceneOf(objects: SceneObject[], version = 1, selected: string | null = null): Scene {
  return { version, key: `k${version}`, objects, byId: new Map(objects.map((o) => [o.id, o])), legend: [], index: { version, levels: [], onChart: new Set(), dropped: new Set(), liqUnavailable: false }, selected };
}

function setup(o: { coarse?: boolean; now?: () => number; overlayY?: () => number | null; width?: number } = {}) {
  const candles = bars(100);
  const env = makeEnv(() => candles, { range: { from: 0, to: 114 }, width: o.width ?? 800 });
  const prim = new OverlayPrimitive({ view: VIEW.desktop, theme: makeTheme(), measure: monoMeasurer(), candles: () => candles, tfSeconds: () => H, coarse: o.coarse, now: o.now, overlayY: o.overlayY });
  env.series.attachPrimitive(prim as never);
  return { prim, env, candles };
}

afterEach(() => vi.useRealTimers());

describe("timeToIndex", () => {
  const c = [...bars(3), ...bars(2, 5)];
  it("свеча, промежуток между свечами, за краями — шагом таймфрейма", () => {
    expect(timeToIndex(c, T0 + H, H)).toBe(1);
    expect(timeToIndex(c, T0 + 3.5 * H, H)).toBeCloseTo(2 + 1.5 / 3, 9);
    expect(timeToIndex(c, T0 - 2 * H, H)).toBe(-2);
    expect(timeToIndex(c, T0 + 8 * H, H)).toBe(4 + 2);
    expect(timeToIndex([], T0, H)).toBe(0);
  });
});

describe("OverlayPrimitive: края", () => {
  it("палец: во время жеста только подписи с приоритетом ≥ 80; после паузы — все", () => {
    vi.useFakeTimers();
    let now = 1000;
    const { prim, env } = setup({ coarse: true, now: () => now });
    prim.setScene(sceneOf([line(95), line(97, "sr:S:97", { priority: 80, label: { text: "Подд.", tone: "up", priority: 80, slots: ["free-above", "free-below", "line-end-above"], font: "sans", show: "always" } })]));
    prim.updateAllViews();
    expect(prim.debug().labels).toHaveLength(2);
    env.chart.state.range = { from: 1, to: 115 };
    now += 10;
    prim.updateAllViews();
    expect(prim.debug().labels.map((l) => l.objectId)).toEqual(["sr:S:97"]);
    const before = env.series.updates;
    vi.advanceTimersByTime(200);
    expect(env.series.updates).toBe(before + 1);
    now += 500;
    prim.updateAllViews();
    expect(prim.debug().labels).toHaveLength(2);
  });

  it("мышь: смена диапазона подписи не упрощает", () => {
    let now = 0;
    const { prim, env } = setup({ now: () => now });
    prim.setScene(sceneOf([line(95), line(97, "sr:S:97")]));
    prim.updateAllViews();
    env.chart.state.range = { from: 1, to: 115 };
    now += 10;
    prim.updateAllViews();
    expect(prim.debug().labels).toHaveLength(2);
  });

  it("прямоугольники интерфейса, шрифты и наведение — новый кадр раскладки; те же значения — нет", () => {
    const { prim, env } = setup();
    prim.setScene(sceneOf([line(95)]));
    prim.updateAllViews();
    const n = prim.debug().layouts;
    const ui = [{ x: 700, y: 300, w: 100, h: 200 }];
    const u0 = env.series.updates;
    prim.setUiObstacles(ui);
    prim.setUiObstacles(ui);
    expect(env.series.updates).toBe(u0 + 1);
    prim.updateAllViews();
    expect(prim.debug().layouts).toBe(n + 1);
    prim.remeasure();
    prim.setHovered("sr:S:95");
    prim.setHovered("sr:S:95");
    prim.updateAllViews();
    expect(prim.debug().layouts).toBe(n + 2);
    prim.setScene(prim.screen ? (prim as unknown as { scene: Scene }).scene : sceneOf([]));
    expect(env.series.updates).toBe(u0 + 3);
  });

  it("метка наложенного инструмента — неподвижное препятствие шкалы; onFrame получает кадр", () => {
    const { prim, env } = setup({ overlayY: () => 100 });
    const frames: number[] = [];
    prim.onFrame = (s) => frames.push(s.axis.hiddenBands.length);
    prim.setScene(sceneOf([line(105, "sr:R:105", { tone: "down", axis: { text: "105", tone: "down", style: "outline", priority: 80, group: "sr" } })]));
    prim.updateAllViews();
    // цена, отсчёт, наложение и метка уровня
    expect(frames).toEqual([4]);
    expect(prim.isTickHidden(100)).toBe(true);
    void env;
  });

  it("залитая метка шкалы: фон — цвет тона, текст — плашка", () => {
    const { prim } = setup();
    prim.setScene(sceneOf([line(95, "x", { axis: { text: "95", tone: "up", style: "solid", priority: 80, group: "sr" } })]));
    prim.updateAllViews();
    const v = prim.priceAxisViews().find((x) => x.visible?.())!;
    expect(v.backColor()).toBe(makeTheme().palette.up);
    expect(v.textColor()).toBe(makeTheme().palette.plaque);
  });

  it("тепловая карта: полосы в отладочном снимке; выбранные группа и значок — в автомасштабе", () => {
    const { prim } = setup();
    const heat: HeatObject = { kind: "heat", id: "liq:map", layer: "liq_map", tone: "liq", priority: 25, hover: { title: "Ликвидации" }, emphasis: "normal", step: 1, bars: [{ price: 100, long: 1, short: 0, weight: 1 }, { price: 102, long: 0, short: 1, weight: 0.5 }], tops: [] };
    const glyph: GlyphObject = { kind: "glyph", id: "pat:1", groupId: "g", layer: "patterns", tone: "muted", priority: 10, hover: { title: "x" }, emphasis: "selected", time: T0 + 10 * H, price: 93, side: "at", shape: "diamond" };
    prim.setScene(sceneOf([heat, glyph, line(99, "fig:1:tgt", { groupId: "g" })], 2, "g"));
    prim.updateAllViews();
    expect(prim.debug().heatRects).toHaveLength(2);
    expect(prim.autoscaleInfo()).toEqual({ priceRange: { minValue: 93, maxValue: 99 } });
  });

  it("нулевая ширина панели — кадр не считается; отключение — сброс", () => {
    const { prim, env } = setup({ width: 0 });
    prim.setScene(sceneOf([line(95)]));
    prim.updateAllViews();
    expect(prim.screen).toBeNull();
    env.chart.state.width = 800;
    prim.updateAllViews();
    expect(prim.screen).not.toBeNull();
    env.series.detachPrimitive(prim as never);
    expect(prim.screen).toBeNull();
    prim.updateAllViews();
    expect(prim.priceAxisViews().every((v) => !v.visible?.())).toBe(true);
    expect(prim.debug().frameKey).toBe("");
  });
});

describe("AxisViewPool", () => {
  it("лишние виды невидимы, used считает показанные", () => {
    const pool = new AxisViewPool(3);
    pool.set([{ y: 10, text: "1", textColor: "#fff", backColor: "#000", tick: true }]);
    expect(pool.used()).toBe(1);
    expect(pool.views[1]!.visible()).toBe(false);
    expect(pool.views[1]!.text()).toBe("");
    expect(pool.views[1]!.fixedCoordinate()).toBeUndefined();
    expect(pool.views[1]!.tickVisible()).toBe(false);
    expect(pool.views[1]!.textColor()).toBe("transparent");
    expect(new AxisViewPool(-1).size).toBe(0);
  });
});

describe("AxisCountdown (DOM-зеркало)", () => {
  it("место, цвет по направлению свечи, текст; без текста — скрыт", () => {
    const host = fakeElement();
    const cd = new AxisCountdown(host);
    const st = cd.el.style as unknown as Record<string, string>;
    cd.place({ x: 800, y: 300, w: 60, h: 17 }, true, 12);
    expect(st.display).toBe("none");
    cd.setText("1:23");
    cd.place({ x: 800, y: 300, w: 60, h: 17 }, true, 12);
    expect(st).toMatchObject({ left: "800px", top: "300px", width: "60px", height: "17px", fontSize: "12px", display: "block", background: "var(--chart-up)" });
    expect(cd.shown).toEqual({ x: 800, y: 300, w: 60, h: 17 });
    cd.place({ x: 800, y: 300, w: 60, h: 17 }, false, 12);
    expect(st.background).toBe("var(--chart-down)");
    cd.place(null, false, 12);
    expect(cd.shown).toBeNull();
    cd.setText("");
    expect(st.display).toBe("none");
    cd.destroy();
  });
});
