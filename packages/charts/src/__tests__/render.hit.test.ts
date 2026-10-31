import { describe, expect, it } from "vitest";
import { monoMeasurer } from "../layout/measure";
import { VIEW } from "../presets";
import { OverlayPrimitive } from "../render/OverlayPrimitive";
import type { BoxObject, GlyphObject, HLineObject, Scene, SceneObject } from "../scene/types";
import { bars, H, makeEnv, makeTheme, T0 } from "./fakes/lwc";

/** hitTest примитива (план 2B.2, §10.1): допуск 5 / 12 px, значок важнее линии, коробка изнутри — 0, плашка ведёт к объекту. */

const support: HLineObject = {
  kind: "hline",
  id: "sr:S:98.0",
  layer: "sr",
  tone: "up",
  priority: 80,
  hover: { title: "Поддержка", price: 98 },
  label: { text: "Поддержка", tone: "up", priority: 80, slots: ["free-below", "free-above"], font: "sans", show: "always" },
  axis: { text: "98.0", tone: "up", style: "outline", priority: 80, group: "sr" },
  emphasis: "normal",
  price: 98,
  from: null,
  to: null,
  style: "dashed",
  width: 1,
};
const glyph: GlyphObject = { kind: "glyph", id: "pat:1", layer: "patterns", tone: "muted", priority: 10, hover: { title: "поглощение" }, emphasis: "normal", time: T0 + 50 * H, price: 98, side: "at", shape: "triangle-up" };
const box: BoxObject = { kind: "box", id: "zone:1:102", layer: "zones", tone: "down", priority: 70, hover: { title: "Предложение", price: 102, priceTo: 104 }, emphasis: "normal", top: 104, bottom: 102, from: T0 + 10 * H, to: null };

function sceneOf(objects: SceneObject[], version = 1): Scene {
  return { version, key: `k${version}`, objects, byId: new Map(objects.map((o) => [o.id, o])), legend: [], index: { version, levels: [], onChart: new Set(), dropped: new Set(), liqUnavailable: false }, selected: null };
}

function setup(o: { coarse?: boolean; gate?: (x: number, y: number) => boolean; objects?: SceneObject[] } = {}) {
  const candles = bars(100);
  // 100 свечей и свободная зона ~100 px справа, как после сброса вида на десктопе
  const env = makeEnv(() => candles, { range: { from: 0, to: 114 } });
  const prim = new OverlayPrimitive({ view: VIEW.desktop, theme: makeTheme(), measure: monoMeasurer(), candles: () => candles, tfSeconds: () => H, coarse: o.coarse, hitGate: o.gate });
  env.series.attachPrimitive(prim as never);
  prim.setScene(sceneOf(o.objects ?? [box, support, glyph]));
  prim.updateAllViews();
  const x = (t: number) => env.chart.timeScale().logicalToCoordinate((t - T0) / H);
  const y = (p: number) => env.series.priceToCoordinate(p);
  return { prim, env, x, y, candles };
}

describe("OverlayPrimitive.hitTest", () => {
  it("линия — в пределах 5 px мышью и 12 px пальцем", () => {
    const { prim, y } = setup();
    expect(prim.hitTest(100, y(98) + 3)).toMatchObject({ externalId: "sr:S:98.0", hitTestPriority: 1, cursorStyle: "pointer", zOrder: "top" });
    expect(prim.hitTest(100, y(98) + 7)).toBeNull();
    const touch = setup({ coarse: true });
    expect(touch.prim.hitTest(100, touch.y(98) + 11)?.externalId).toBe("sr:S:98.0");
    expect(touch.prim.hitTest(100, touch.y(98) + 14)).toBeNull();
  });

  it("значок выигрывает у линии при равном расстоянии", () => {
    const { prim, x, y } = setup();
    expect(prim.hitTest(x(T0 + 50 * H), y(98))).toMatchObject({ externalId: "pat:1", hitTestPriority: 2 });
  });

  it("коробка изнутри — попадание с расстоянием 0", () => {
    const { prim, y } = setup();
    expect(prim.hitTest(300, (y(104) + y(102)) / 2)).toMatchObject({ externalId: "zone:1:102", distance: 0, hitTestPriority: 0 });
  });

  it("плашка подписи ведёт к своему объекту", () => {
    const { prim } = setup();
    const label = prim.debug().labels.find((l) => l.objectId === "sr:S:98.0")!;
    expect(label).toBeDefined();
    const hit = prim.hitTest(label.rect.x + label.rect.w / 2, label.rect.y + label.rect.h / 2);
    expect(hit).toMatchObject({ externalId: "sr:S:98.0", hitTestPriority: 2 });
  });

  it("инструмент рисования или рисунок под курсором — попаданий нет", () => {
    const { prim, y } = setup({ gate: () => false });
    expect(prim.hitTest(100, y(98))).toBeNull();
  });

  it("без сцены и без кадра — null", () => {
    const candles = bars(10);
    const prim = new OverlayPrimitive({ view: VIEW.desktop, theme: makeTheme(), measure: monoMeasurer(), candles: () => candles, tfSeconds: () => H });
    expect(prim.hitTest(1, 1)).toBeNull();
    prim.updateAllViews();
    expect(prim.screen).toBeNull();
  });
});

describe("OverlayPrimitive: кадр, шкала, автомасштаб", () => {
  it("неподвижный график — раскладка не пересчитывается (кэш по frameKey)", () => {
    const { prim } = setup();
    const n = prim.debug().layouts;
    prim.updateAllViews();
    prim.updateAllViews();
    expect(prim.debug().layouts).toBe(n);
  });

  it("priceAxisViews — один и тот же массив пула; метка на итоговом y через fixedCoordinate", () => {
    const { prim, y } = setup();
    const views = prim.priceAxisViews();
    expect(views).toHaveLength(VIEW.desktop.axis.total + 2);
    prim.setScene(sceneOf([support, box], 2));
    prim.updateAllViews();
    expect(prim.priceAxisViews()).toBe(views);
    const shown = views.filter((v) => v.visible?.());
    expect(shown).toHaveLength(1);
    expect(shown[0]!.text()).toBe("98.0");
    expect(shown[0]!.fixedCoordinate?.()).toBeCloseTo(y(98), 6);
    expect(shown[0]!.coordinate()).toBe(-10000);
    expect(shown[0]!.tickVisible?.()).toBe(true);
    // контурная метка: фон поверхности, текст — цвет тона
    expect(shown[0]!.backColor()).toBe(makeTheme().palette.surface);
    expect(shown[0]!.textColor()).toBe(makeTheme().palette.up);
  });

  it("смена устройства — новый пул под бюджет шкалы", () => {
    const { prim } = setup();
    const views = prim.priceAxisViews();
    prim.setView(VIEW.phone);
    expect(prim.priceAxisViews()).not.toBe(views);
    expect(prim.priceAxisViews()).toHaveLength(VIEW.phone.axis.total + 2);
  });

  it("деления под меткой и под ценой пустые: isTickHidden по полосам раскладки", () => {
    const { prim, y, candles } = setup();
    expect(prim.isTickHidden(y(98))).toBe(true);
    expect(prim.isTickHidden(y(candles.at(-1)!.close))).toBe(true);
    expect(prim.isTickHidden(5)).toBe(false);
    expect(prim.isTickHidden(null)).toBe(false);
  });

  it("полосы сменились без смены масштаба — onAxisChanged в микрозадаче, один раз", async () => {
    const { prim } = setup({ objects: [box] });
    let calls = 0;
    prim.onAxisChanged = () => calls++;
    prim.setScene(sceneOf([box, support], 2));
    prim.updateAllViews();
    prim.updateAllViews();
    await Promise.resolve();
    expect(calls).toBe(1);
  });

  it("автомасштаб включает только выбранный объект", () => {
    const { prim } = setup();
    expect(prim.autoscaleInfo()).toBeNull();
    const far: HLineObject = { ...support, id: "sr:S:60.0", price: 60, emphasis: "selected" };
    prim.setScene({ ...sceneOf([box, far], 3), selected: "sr:S:60.0" });
    expect(prim.autoscaleInfo()).toEqual({ priceRange: { minValue: 60, maxValue: 60 } });
  });

  it("отладочный снимок: свечи, полоса цены, свободная зона, цвета объектов", () => {
    const { prim } = setup();
    const d = prim.debug();
    expect(d.sceneVersion).toBe(1);
    expect(d.candles.length).toBeGreaterThan(50);
    expect(d.lastPrice).not.toBeNull();
    expect(d.minFontPx).toBeGreaterThanOrEqual(11);
    expect(d.objects.find((o) => o.id === "zone:1:102")?.color).toBe(makeTheme().palette.down);
    expect(d.labels.every((l) => l.color.startsWith("#"))).toBe(true);
  });

  it("смена темы — перерисовка из новой палитры без новой сцены", () => {
    const { prim } = setup();
    const v = prim.debug().sceneVersion;
    const light = makeTheme(2, "light", { ...makeTheme().tokens, up: "#1f8a5b" });
    prim.setTheme(light);
    prim.updateAllViews();
    const d = prim.debug();
    expect(d.sceneVersion).toBe(v);
    expect(d.labels.find((l) => l.objectId === "sr:S:98.0")?.color).toBe("#1f8a5b");
  });
});
