import { describe, expect, it } from "vitest";
import { layoutAxis } from "../layout/axis";
import { compareCandidates } from "../layout/labels";
import { monoMeasurer } from "../layout/measure";
import { hitTestScreen, projectScene, screenFrameKey, type ProjectOptions, type SceneProjector } from "../layout/project";
import { VIEW } from "../presets";
import type { LabelSpec, Scene, SceneObject } from "../scene/types";
import { DEFAULT_ALPHAS, PLAQUE } from "../theme";
import type { Candle } from "../types";

/** Синтетические объекты на простой проекции: x = время, y = 500 − цена; null вне [−1000, 2000]. */
const W = 800;
const Hh = 500;
const proj = (o: Partial<SceneProjector> = {}): SceneProjector => ({
  x: (t) => (t < -1000 || t > 2000 ? null : t),
  y: (p) => (p < -1000 || p > 2000 ? null : Hh - p),
  visibleLogical: () => ({ from: 0, to: 100 }),
  barSpacing: () => 8,
  lastBarX: () => 680,
  width: W,
  height: Hh,
  ...o,
});
const candles: Candle[] = Array.from({ length: 80 }, (_, i) => ({ time: 40 + i * 8, open: 200, high: 205 + (i % 3), low: 195, close: 201, volume: i % 5 === 0 ? 0 : 3 + (i % 4), open_: false }));
const opts = (o: Partial<ProjectOptions> = {}): ProjectOptions => ({
  view: VIEW.desktop,
  theme: { version: 1, alphas: DEFAULT_ALPHAS, type: { sans: "s", mono: "m", labelPx: 11, labelWeight: 600, axisPx: 12, plaquePadX: PLAQUE.padX, plaquePadY: PLAQUE.padY, plaqueRadius: PLAQUE.radius } },
  measure: monoMeasurer(),
  lastPrice: 200,
  hovered: null,
  ...o,
});
const label = (slots: LabelSpec["slots"], p: Partial<LabelSpec> = {}): LabelSpec => ({ text: "Тест", tone: "up", priority: 50, slots, font: "sans", show: "always", ...p });
const base = { layer: "sr" as const, tone: "up" as const, priority: 50, emphasis: "normal" as const, hover: { title: "x" } };
const scene = (objects: SceneObject[]): Scene => ({ version: 1, key: "k", objects, byId: new Map(objects.map((o) => [o.id, o])), legend: [], index: { version: 1, levels: [], onChart: new Set(), dropped: new Set(), liqUnavailable: false }, selected: null });

describe("projectScene: пограничные случаи геометрии", () => {
  it("объекты вне области и без координат пропускаются", () => {
    const objs: SceneObject[] = [
      { ...base, id: "h-off-y", kind: "hline", price: 3000, from: null, to: null, style: "solid", width: 1 },
      { ...base, id: "h-right", kind: "hline", price: 300, from: 900, to: null, style: "solid", width: 1 },
      { ...base, id: "h-left", kind: "hline", price: 300, from: 0, to: -10, style: "solid", width: 1 },
      { ...base, id: "h-nullx", kind: "hline", price: 300, from: -5000, to: 5000, style: "solid", width: 1 },
      { ...base, id: "b-null", kind: "box", top: 3000, bottom: 100, from: 0, to: null },
      { ...base, id: "b-above", kind: "box", top: 1900, bottom: 1800, from: 0, to: null },
      { ...base, id: "b-right", kind: "box", top: 300, bottom: 250, from: 900, to: null },
      { ...base, id: "b-to", kind: "box", top: 300, bottom: 250, from: 100, to: 5000 },
      { ...base, id: "g-nullx", kind: "glyph", time: 5000, price: 100, side: "at", shape: "dot" },
      { ...base, id: "g-noprice", kind: "glyph", time: 3, price: null, side: "at", shape: "dot" },
      { ...base, id: "g-offy", kind: "glyph", time: 10, price: 1900, side: "at", shape: "dot" },
      { ...base, id: "g-at", kind: "glyph", time: 10, price: 300, side: "above", shape: "ring" },
      { ...base, id: "g-below", kind: "glyph", time: 48, price: 300, side: "below", shape: "ring" },
      { ...base, id: "p-null", kind: "polyline", paths: [[[0, 100], [5000, 100]]], style: "dashed", width: 1, dots: [[5000, 1]] },
      { ...base, id: "p-ok", kind: "polyline", paths: [[[100, 100], [200, 150]], [[300, 50]]], style: "dashed", width: 1 },
    ];
    const s = projectScene(scene(objs), proj(), candles, opts());
    const got = Object.fromEntries(s.objects.map((o) => [o.obj.id, o.geom]));
    expect(Object.keys(got).sort()).toEqual(["b-to", "g-at", "g-below", "h-nullx", "p-ok"]);
    expect(got["h-nullx"]).toEqual({ kind: "hline", x1: 0, x2: W, y: 200 });
    expect(got["b-to"]).toMatchObject({ x1: 100, x2: W });
    expect(got["g-at"]).toMatchObject({ x: 10, y: 200 }); // свечи на этом времени нет — по цене
    expect(got["g-below"]).toMatchObject({ x: 48, y: Hh - 195 + 4 + 3 }); // под минимумом свечи
    expect(got["p-ok"]).toMatchObject({ kind: "polyline", dots: [] });
  });

  it("без полосы — ни карты, ни профиля; плоские свечи — без профиля", () => {
    const heat: SceneObject = { ...base, layer: "liq_map", tone: "liq", id: "liq:map", kind: "heat", step: 10, bars: [{ price: 2500, long: 1, short: 0, weight: 1 }], tops: [] };
    const prof: SceneObject = { ...base, layer: "volume_profile", tone: "muted", id: "vp", kind: "profile", rows: 10, valueArea: 0.7, label: label(["gutter-mid"]) };
    expect(projectScene(scene([heat, prof]), proj(), candles, opts({ view: VIEW.cell })).objects).toHaveLength(0);
    // карта вне цен — без строк
    expect(projectScene(scene([heat]), proj(), candles, opts()).objects).toHaveLength(0);
    const zeroVol = candles.map((c) => ({ ...c, volume: 0 }));
    expect(projectScene(scene([prof]), proj(), zeroVol, opts()).objects).toHaveLength(0);
    // профиль вне цен — без строк
    const high = candles.map((c) => ({ ...c, high: 2500, low: 2400 }));
    expect(projectScene(scene([prof]), proj(), high, opts()).objects).toHaveLength(0);
  });

  it("подписи: все места по очереди, условия мест, выбранный флаг", () => {
    const sel = { ...base, emphasis: "selected" as const };
    const objs: SceneObject[] = [
      { ...sel, id: "h", kind: "hline", price: 350, from: 100, to: 300, style: "solid", width: 2, label: label(["box-top-left", "glyph-above", "polyline-end-above", "gutter-mid", "break-above", "line-start-above"], { priority: 95 }) },
      { ...base, id: "st", kind: "hline", price: 160, from: 300, to: 500, style: "solid", width: 1, label: label(["line-start-above"]) },
      { ...base, id: "seg", kind: "hline", price: 120, from: 100, to: 5000, style: "solid", width: 1, label: label(["break-below", "line-end-below"]) },
      { ...base, id: "box", kind: "box", top: 420, bottom: 400, from: 50, to: null, label: label(["free-above", "box-top-left", "box-free"]) },
      { ...base, layer: "zones", id: "thin", kind: "box", top: 101, bottom: 100, from: 50, to: null, label: label(["box-bottom-left"]) },
      { ...base, id: "poly", kind: "polyline", paths: [[[200, 300], [100, 280]]], style: "dashed", width: 1, label: label(["polyline-start-above", "line-end-above"]) },
      { ...base, id: "gl", kind: "glyph", time: 400, price: 260, side: "at", shape: "dot", label: label(["glyph-below", "free-below"], { show: "hover" }) },
    ];
    const s = projectScene(scene(objs), proj(), [], opts({ hovered: "gl" }));
    const at = Object.fromEntries(s.labels.placed.map((p) => [p.objectId, p]));
    // коробка, значок, ломаная и полоса к линии не подходят — первое подходящее место «у свечи пробоя»
    expect(at.h).toMatchObject({ slot: "break-above", selected: true, bypassBudget: true });
    expect(at.st?.slot).toBe("line-start-above");
    expect(at.seg?.slot).toBe("line-end-below");
    expect(at.box?.slot).toBe("box-top-left");
    expect(at.poly?.slot).toBe("polyline-start-above");
    expect(at.gl).toMatchObject({ slot: "glyph-below", bypassBudget: true });
    expect(s.labels.dropped.find((d) => d.id === "thin#label")?.reason).toBe("offscreen");
    // без свободной зоны и break-слот без времени
    const s2 = projectScene(scene([objs.find((o) => o.id === "box")!, { ...base, id: "nb", kind: "hline", price: 350, from: 0, to: null, style: "solid", width: 1, label: label(["break-above", "free-below"]) }]), proj({ lastBarX: () => null }), [], opts());
    expect(s2.labels.placed.find((p) => p.objectId === "box")?.slot).toBe("box-top-left");
    expect(s2.labels.dropped.find((d) => d.id === "nb#label")?.reason).toBe("offscreen");
    // break-слот: время пробоя за пределами проекции
    const s3 = projectScene(scene([{ ...base, id: "far", kind: "hline", price: 350, from: 0, to: 1999, style: "solid", width: 1, label: label(["break-above"]) }]), proj({ x: (t) => (t > 1500 ? null : t) }), [], opts());
    expect(s3.labels.dropped[0]?.reason).toBe("offscreen");
  });

  it("сумма ликвидаций без координаты и профиль без POC-подписи в overlay", () => {
    const heat: SceneObject = {
      ...base,
      layer: "liq_map",
      tone: "liq",
      id: "liq:map",
      kind: "heat",
      step: 10,
      bars: [{ price: 300, long: 1, short: 0, weight: 1 }],
      tops: [
        { id: "liq:L:1", side: "long", price: 300, amountUsd: 1e6, label: label(["gutter-mid"], { priority: 25, font: "mono" }), hover: { title: "t" } },
        { id: "liq:L:2", side: "long", price: 5000, amountUsd: 1e6, label: label(["gutter-mid"], { priority: 25 }), hover: { title: "t" } },
      ],
    };
    const s = projectScene(scene([heat]), proj(), [], opts({ hovered: "liq:L:1" }));
    expect(s.labels.placed.map((p) => [p.objectId, p.bypassBudget])).toEqual([["liq:L:1", true]]);
    const g = projectScene(scene([heat]), proj(), [], opts({ gesture: true }));
    expect(g.labels.placed).toHaveLength(0);
    const prof: SceneObject = { ...base, layer: "volume_profile", tone: "muted", id: "vp", kind: "profile", rows: 10, valueArea: 0.7, label: label(["gutter-mid"]) };
    const over = projectScene(scene([prof]), proj({ lastBarX: () => 790 }), candles, opts());
    expect(over.viewport.gutter?.mode).toBe("overlay");
    expect(over.labels.placed).toHaveLength(0);
  });

  it("метки шкалы: без y пропускаются, сторона без цены — по половине высоты, выбранный — 95", () => {
    const ax = (id: string, price: number, emphasis: SceneObject["emphasis"] = "normal"): SceneObject => ({ ...base, emphasis, id, kind: "hline", price, from: null, to: null, style: "solid", width: 1, axis: { text: id, tone: "up", style: "outline", priority: 40, group: "sr" } });
    const s = projectScene(scene([ax("hi", 450), ax("lo", 50, "selected"), ax("none", 5000)]), proj(), [], opts({ lastPrice: null }));
    expect(s.axis.placed.map((p) => p.id).sort()).toEqual(["hi#axis", "lo#axis"]);
    const s2 = projectScene(scene([ax("hi", 450)]), proj({ y: (p) => (p === 200 ? null : Hh - p) }), [], opts());
    expect(s2.yLast).toBeNull();
  });

  it("ключ кадра без диапазона и без свечей", () => {
    const k = screenFrameKey(scene([]), proj({ visibleLogical: () => null }), [], opts({ lastPrice: null }));
    expect(k).toContain("|-|");
  });

  it("hitTest по отрезку нулевой длины", () => {
    const s = projectScene(scene([{ ...base, id: "dot", kind: "polyline", paths: [[[100, 100], [100, 100]]], style: "solid", width: 1 }]), proj(), [], opts());
    expect(hitTestScreen(s, 103, 400, 5)?.distance).toBeCloseTo(3, 6);
  });
});

describe("сортировки раскладки: неизвестный слой и равные id", () => {
  it("compareCandidates и layoutAxis детерминированы при равенствах", () => {
    const c = (id: string, layer: string) => ({ id, objectId: id, layer, text: id, font: "sans", px: 11, w: 10, h: 17, priority: 1, tone: "up", slots: [], bypassBudget: false }) as never;
    expect(compareCandidates(c("a", "zz"), c("a", "zz"))).toBe(0);
    expect(compareCandidates(c("b", "zz"), c("a", "zz"))).toBe(1);
    const a = (id: string) => ({ id, objectId: id, price: 1, y: 100, text: id, tone: "up" as const, style: "outline" as const, priority: 1, group: "sr" as const, side: "above" as const });
    const r = layoutAxis([a("b"), a("a"), a("a")], [], { height: 300, labelH: 18, gap: 1, maxShift: 27, tickFontPx: 12 }, { srPerSide: 9, alerts: 0, positions: 0, topdown: 0, total: 9, countdown: false });
    expect(r.placed[0]!.id).toBe("a");
    expect(r.placed[0]!.merged).toEqual(["a"]);
  });
});
