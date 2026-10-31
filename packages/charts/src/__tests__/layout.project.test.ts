import { describe, expect, it } from "vitest";
import { inBands } from "../layout/axis";
import { inflate, intersects } from "../layout/labels";
import { monoMeasurer } from "../layout/measure";
import { candleBand, freeAndGutter, hitTestScreen, projectScene, screenFrameKey, type ProjectOptions, type SceneProjector, type ScreenScene } from "../layout/project";
import type { Rect } from "../layout/types";
import { resolvePreset, SELECTABLE_PRESETS, VIEW, type MarkupSettings, type PresetId, type ViewPreset } from "../presets";
import { priceFormatter } from "../priceFormat";
import { buildScene } from "../scene/build";
import { deriveAnalytics, NO_SELECTION, type AlertLine } from "../scene/input";
import { RU_TEXT } from "../scene/text";
import type { Scene, SceneObject } from "../scene/types";
import { DEFAULT_ALPHAS, PLAQUE, type ChartTheme } from "../theme";
import { LAYER_KEYS, TF_SECONDS, type Candle, type Device } from "../types";
import { FIXTURES, loadFixture, type FixtureName } from "./fixtures/scene/load";

/** Линейная проекция как у LWC: шаг бара, отступ справа в пикселях, шкала цены по видимым свечам. */
function fakeProjector(candles: readonly Candle[], o: { width: number; height: number; bars: number; offsetPx: number; scrollBars?: number; priceRange?: [number, number] }) {
  const step = candles.length > 1 ? candles[1]!.time - candles[0]!.time : 14400;
  const t0 = candles[0]!.time;
  const L = candles.length - 1 - (o.scrollBars ?? 0);
  const spacing = (o.width - o.offsetPx) / o.bars;
  const from = L + 1 - o.bars;
  const logical = (t: number) => (t - t0) / step;
  const visible = candles.filter((_, i) => i >= Math.floor(from) && i <= Math.ceil(L + o.offsetPx / spacing));
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of visible) {
    lo = Math.min(lo, c.low);
    hi = Math.max(hi, c.high);
  }
  const pad = (hi - lo) * 0.1;
  const top = o.priceRange ? o.priceRange[1] : hi + pad;
  const bottom = o.priceRange ? o.priceRange[0] : lo - (hi - lo) * 0.25;
  const xOf = (l: number) => (l - from) * spacing + spacing / 2;
  const proj: SceneProjector = {
    x: (t) => xOf(logical(t)),
    y: (p) => ((top - p) / (top - bottom)) * o.height,
    visibleLogical: () => ({ from, to: L + o.offsetPx / spacing }),
    barSpacing: () => spacing,
    lastBarX: () => xOf(candles.length - 1),
    width: o.width,
    height: o.height,
  };
  return { proj, visible };
}

const THEME: ProjectOptions["theme"] = { version: 1, alphas: DEFAULT_ALPHAS, type: { sans: "Manrope", mono: "IBM Plex Mono", labelPx: 11, labelWeight: 600, axisPx: 12, plaquePadX: PLAQUE.padX, plaquePadY: PLAQUE.padY, plaqueRadius: PLAQUE.radius } };
const MEASURE = monoMeasurer();
const ALL_ON: MarkupSettings = { preset: "clean", overrides: Object.fromEntries(LAYER_KEYS.map((k) => [k, true])) };
const SIZE: Record<"desktop" | "phone", { width: number; height: number; bars: number }> = { desktop: { width: 1000, height: 640, bars: 100 }, phone: { width: 334, height: 520, bars: 45 } };

function sceneFor(name: FixtureName, markup: MarkupSettings, device: Device, alerts: readonly AlertLine[] = [], selected: string | null = null): Scene {
  const fx = loadFixture(name);
  return buildScene(
    {
      tf: fx.tf,
      analytics: deriveAnalytics(fx.candles, fx.oi, fx.structure),
      structure: fx.structure,
      patterns: fx.patterns,
      figures: fx.figures,
      signals: fx.signals,
      alerts,
      external: [],
      selection: selected ? { selected, hidden: new Set() } : NO_SELECTION,
      fmt: priceFormatter(fx.tick, device !== "desktop"),
      text: RU_TEXT,
    },
    resolvePreset(markup, device, { authed: true }),
  );
}

function run(name: FixtureName, markup: MarkupSettings, device: "desktop" | "phone", extra: Partial<ProjectOptions> & { scrollBars?: number; alerts?: AlertLine[]; selected?: string; priceRange?: [number, number] } = {}) {
  const fx = loadFixture(name);
  const view: ViewPreset = VIEW[device];
  const { proj, visible } = fakeProjector(fx.candles, { ...SIZE[device], offsetPx: view.rightOffsetPx, scrollBars: extra.scrollBars, priceRange: extra.priceRange });
  const scene = sceneFor(name, markup, device, extra.alerts, extra.selected ?? null);
  const lastPrice = fx.candles[fx.candles.length - 1]!.close;
  const opts: ProjectOptions = { view, theme: THEME, measure: MEASURE, lastPrice, hovered: null, ...extra };
  return { scene, screen: projectScene(scene, proj, visible, opts), proj, visible, view, opts };
}

/** Прямоугольники свечей: колонка по высоте от максимума до минимума. */
function candleRects(proj: SceneProjector, visible: readonly Candle[]): Rect[] {
  const half = Math.max(1, 0.4 * proj.barSpacing());
  return visible.map((c) => {
    const x = proj.x(c.time)!;
    const y1 = proj.y(c.high)!;
    const y2 = proj.y(c.low)!;
    return { x: x - half, y: y1, w: 2 * half, h: y2 - y1 };
  });
}

function checkInvariants(screen: ScreenScene, proj: SceneProjector, visible: readonly Candle[], view: ViewPreset) {
  const placed = screen.labels.placed;
  for (let i = 0; i < placed.length; i++) {
    const a = placed[i]!;
    expect(a.px).toBeGreaterThanOrEqual(11);
    expect(a.rect.x).toBeGreaterThanOrEqual(2);
    expect(a.rect.x + a.rect.w).toBeLessThanOrEqual(proj.width - 2 + 1e-9);
    expect(a.rect.y).toBeGreaterThanOrEqual(view.insetTopPx);
    expect(a.rect.y + a.rect.h).toBeLessThanOrEqual(view.volumeTop * proj.height + 1e-9);
    for (let j = i + 1; j < placed.length; j++) expect(intersects(inflate(a.rect, 1.99), placed[j]!.rect), `${a.text} × ${placed[j]!.text}`).toBe(false);
    for (const c of candleRects(proj, visible)) expect(intersects(a.rect, c), `${a.text} на свече`).toBe(false);
    const band = screen.obstacles.rects.find((r) => r.kind === "lastPrice");
    if (band) expect(intersects(a.rect, band.rect), `${a.text} на цене`).toBe(false);
  }
  const counted = placed.filter((p) => !p.bypassBudget);
  expect(counted.length).toBeLessThanOrEqual(view.labels.canvas);
  // шкала: ни одна метка не в полосе соседней, отсчёт вплотную под ценой
  const ys = screen.axis.placed.map((p) => p.y);
  for (let i = 0; i < ys.length; i++) for (let j = i + 1; j < ys.length; j++) expect(Math.abs(ys[i]! - ys[j]!)).toBeGreaterThanOrEqual(view.axisLabelPx + view.axisGapPx - 1e-9);
  if (screen.yLast !== null) {
    for (const y of ys) expect(Math.abs(y - screen.yLast)).toBeGreaterThanOrEqual(view.axisLabelPx + view.axisGapPx - 1e-9);
    expect(inBands(screen.yLast, screen.axis.hiddenBands)).toBe(true);
    if (view.axis.countdown) expect(screen.countdownY).toBe(screen.yLast + view.axisLabelPx);
  }
  // тепловая карта — только в полосе справа
  for (const { geom } of screen.objects)
    if (geom.kind === "heat" && screen.viewport.gutter?.mode === "reserved") {
      expect(geom.x1).toBe(screen.viewport.gutter.x1);
      for (const r of geom.rows) expect(geom.x1 - r.w).toBeGreaterThanOrEqual(screen.viewport.gutter.x0 - 1e-9);
    }
}

describe("projectScene: свойства на фикстурах", () => {
  for (const name of FIXTURES)
    for (const device of ["desktop", "phone"] as const)
      for (const id of [...SELECTABLE_PRESETS, "custom"] as (PresetId | "custom")[]) {
        it(`${name} · ${device} · ${id}`, () => {
          const markup = id === "custom" ? ALL_ON : { preset: id, overrides: {} };
          const fx = loadFixture(name);
          const close = fx.candles[fx.candles.length - 1]!.close;
          const alerts: AlertLine[] = id === "custom" ? [{ id: 1, price: close * 1.002, op: "cross_up" }] : [];
          const { screen, proj, visible, view } = run(name, markup, device, { alerts });
          checkInvariants(screen, proj, visible, view);
        });
      }

  it("«Чистый», desktop: не больше 3 подписей и 2 контурных меток, без тепловой карты", () => {
    const { screen } = run("btc-4h-rich", { preset: "clean", overrides: {} }, "desktop");
    expect(screen.labels.placed.length).toBeLessThanOrEqual(3);
    expect(screen.labels.placed.length).toBeGreaterThanOrEqual(2);
    expect(screen.axis.placed.filter((p) => p.style === "outline").length).toBeLessThanOrEqual(2);
    expect(screen.objects.some((o) => o.geom.kind === "heat")).toBe(false);
    expect(screen.labels.placed.map((p) => p.text)).toEqual(expect.arrayContaining(["Сопротивление", "Поддержка"]));
  });

  it("«Карта ликвидаций», desktop: полоса reserved, суммы в полосе, полоса правее последней свечи", () => {
    const { screen, proj, visible, view } = run("btc-4h-rich", { preset: "liquidity", overrides: {} }, "desktop", { priceRange: [70000, 92000] });
    checkInvariants(screen, proj, visible, view);
    const g = screen.viewport.gutter!;
    const free = screen.viewport.free!;
    expect(g.mode).toBe("reserved");
    expect(g.x0).toBeGreaterThanOrEqual(free.x0);
    const last = visible[visible.length - 1]!;
    expect(free.x0).toBeGreaterThanOrEqual(proj.x(last.time)! + proj.barSpacing() / 2 + 2 - 1e-9);
    // ширина свободной зоны ≈ rightOffsetPixels − 2 (приёмка: 101 ± 3)
    expect(Math.abs(free.x1 - free.x0 - 101)).toBeLessThanOrEqual(3);
    const sums = screen.labels.placed.filter((p) => p.layer === "liq_map");
    expect(sums.length).toBeGreaterThan(0);
    for (const s of sums) {
      expect(s.text).toMatch(/^≈ \$/);
      expect(s.font).toBe("mono");
      expect(s.slot).toBe("gutter-mid");
    }
  });

  it("история прокручена (последняя свеча за краем): нет свободной зоны, карта приглушена и без сумм", () => {
    const { screen } = run("btc-4h-rich", { preset: "liquidity", overrides: {} }, "desktop", { scrollBars: 40 });
    expect(screen.viewport.free).toBeNull();
    expect(screen.viewport.gutter?.mode).toBe("overlay");
    const heat = screen.objects.find((o) => o.geom.kind === "heat")!.geom;
    if (heat.kind !== "heat") throw new Error("heat");
    expect(heat.dimmed).toBe(true);
    for (const r of heat.rows) expect(r.alpha).toBeLessThanOrEqual(DEFAULT_ALPHAS.dimmed * DEFAULT_ALPHAS.heatMax + 1e-9);
    expect(screen.labels.placed.some((p) => p.layer === "liq_map")).toBe(false);
  });

  it("профиль: один — в полосе с подписью POC; с картой — поверх свечей, без подписи", () => {
    const alone = run("btc-4h-rich", { preset: "clean", overrides: { volume_profile: true } }, "desktop").screen;
    const vp = alone.objects.find((o) => o.geom.kind === "profile")!.geom;
    if (vp.kind !== "profile") throw new Error("profile");
    expect(vp.dimmed).toBe(false);
    expect(vp.x1).toBe(alone.viewport.gutter!.x1);
    expect(vp.rows.filter((r) => r.poc)).toHaveLength(1);
    expect(alone.labels.placed.some((p) => p.text === "Макс. объём") || alone.labels.dropped.some((d) => d.id === "vp#label")).toBe(true);
    const both = run("btc-4h-rich", { preset: "liquidity", overrides: { volume_profile: true } }, "desktop").screen;
    const vp2 = both.objects.find((o) => o.geom.kind === "profile")!.geom;
    if (vp2.kind !== "profile") throw new Error("profile");
    expect(vp2.dimmed).toBe(true);
    expect(vp2.x1).toBe(1000);
    expect(Math.max(...vp2.rows.map((r) => r.w))).toBeCloseTo(250, 6);
    expect(both.labels.placed.some((p) => p.objectId === "vp")).toBe(false);
  });

  it("подпись значка — только при наведении и сверх бюджета", () => {
    const base = run("btc-4h-rich", ALL_ON, "desktop");
    const glyph = base.screen.objects.find((o) => o.obj.layer === "patterns")!;
    expect(base.screen.labels.placed.some((p) => p.objectId === glyph.obj.id)).toBe(false);
    const hovered = run("btc-4h-rich", ALL_ON, "desktop", { hovered: glyph.obj.id }).screen;
    const label = hovered.labels.placed.find((p) => p.objectId === glyph.obj.id);
    if (label) expect(label.bypassBudget).toBe(true);
    else expect(hovered.labels.dropped.find((d) => d.id === `${glyph.obj.id}#label`)?.reason).not.toBe("budget");
  });

  it("выбранная далёкая зона: подпись сверх бюджета, x прижат к области (M09)", () => {
    const s = run("btc-4h-rich", { preset: "clean", overrides: {} }, "desktop").scene;
    const far = s.index.levels.find((r) => r.layer === "zones" && !r.onChart)!;
    const { screen } = run("btc-4h-rich", { preset: "clean", overrides: {} }, "desktop", { selected: far.id });
    const box = screen.objects.find((o) => o.obj.id === far.id);
    if (!box) return; // зона вне видимого диапазона цен
    const label = screen.labels.placed.find((p) => p.objectId === far.id);
    if (label) {
      expect(label.bypassBudget).toBe(true);
      expect(label.selected).toBe(true);
      expect(label.rect.x).toBeGreaterThanOrEqual(2);
    }
  });

  it("жест: остаются только подписи с приоритетом ≥ 80", () => {
    const { screen } = run("btc-4h-rich", { preset: "detailed", overrides: {} }, "desktop", { gesture: true });
    expect(screen.labels.placed.length).toBeGreaterThan(0);
    for (const p of [...screen.labels.placed]) expect(p.priority).toBeGreaterThanOrEqual(80);
  });

  it("интерфейс поверх графика — препятствие", () => {
    const base = run("btc-4h-rich", { preset: "clean", overrides: {} }, "desktop").screen;
    const first = base.labels.placed[0]!;
    const blocked = run("btc-4h-rich", { preset: "clean", overrides: {} }, "desktop", { ui: [inflate(first.rect, 10)], uiRev: 1 }).screen;
    for (const p of blocked.labels.placed) expect(intersects(p.rect, inflate(first.rect, 10))).toBe(false);
  });

  it("ключ кадра: тот же вход — тот же ключ; наведение, цена, размер — другой", () => {
    const a = run("btc-4h-rich", { preset: "clean", overrides: {} }, "desktop");
    const k = (o: Partial<ProjectOptions>) => screenFrameKey(a.scene, a.proj, a.visible, { ...a.opts, ...o });
    expect(k({})).toBe(a.screen.frameKey);
    expect(k({ hovered: "x" })).not.toBe(a.screen.frameKey);
    expect(k({ lastPrice: (a.opts.lastPrice ?? 0) * 1.01 })).not.toBe(a.screen.frameKey);
    expect(k({ gesture: true })).not.toBe(a.screen.frameKey);
    expect(k({ theme: { ...THEME, version: 2 } })).not.toBe(a.screen.frameKey);
    expect(screenFrameKey(a.scene, { ...a.proj, width: 999 }, a.visible, a.opts)).not.toBe(a.screen.frameKey);
    // детерминированность
    expect(JSON.stringify(projectScene(a.scene, a.proj, a.visible, a.opts).labels)).toBe(JSON.stringify(a.screen.labels));
  });

  it("без цены — нет полосы цены и отсчёта", () => {
    const { screen } = run("btc-4h-rich", { preset: "clean", overrides: {} }, "desktop", { lastPrice: null, overlayY: 200 });
    expect(screen.yLast).toBeNull();
    expect(screen.countdownY).toBeNull();
    expect(screen.obstacles.rects.some((r) => r.kind === "lastPrice")).toBe(false);
    expect(inBands(200, screen.axis.hiddenBands)).toBe(true);
  });
});

describe("свободная зона и полоса", () => {
  const view = VIEW.desktop;
  const proj = (lastX: number | null, width = 1000): SceneProjector => ({ x: () => 0, y: () => 0, visibleLogical: () => null, barSpacing: () => 8, lastBarX: () => lastX, width, height: 500 });
  it("reserved при достаточной зоне, overlay при узкой, нет — без последней свечи", () => {
    expect(freeAndGutter(proj(896), view)).toEqual({ free: { x0: 902, x1: 1000 }, gutter: { x0: 952, x1: 1000, mode: "reserved" } });
    expect(freeAndGutter(proj(950), view)).toEqual({ free: { x0: 956, x1: 1000 }, gutter: { x0: 952, x1: 1000, mode: "overlay" } });
    expect(freeAndGutter(proj(995), view)).toEqual({ free: null, gutter: { x0: 952, x1: 1000, mode: "overlay" } });
    expect(freeAndGutter(proj(null), view).free).toBeNull();
    expect(freeAndGutter(proj(896), VIEW.cell).gutter).toBeNull();
    expect(freeAndGutter(proj(-50), view).free).toEqual({ x0: 0, x1: 1000 });
  });

  it("колонки свечей: полуширина max(1, 0.4·шаг) + 1", () => {
    const c: Candle[] = [0, 1].map((i) => ({ time: i, open: 1, high: 2, low: 0, close: 1, volume: 1, open_: false }));
    const b = candleBand({ x: (t) => 10 + t * 8, y: (p) => 100 - p * 10, visibleLogical: () => null, barSpacing: () => 8, lastBarX: () => 18, width: 100, height: 100 }, c);
    expect(b).toMatchObject({ x0: 10, spacing: 8, halfWidth: 4.2 });
    expect([...b.top]).toEqual([80, 80]);
    expect(candleBand({ x: () => null, y: () => null, visibleLogical: () => null, barSpacing: () => 1, lastBarX: () => null, width: 1, height: 1 }, []).top.length).toBe(0);
  });
});

describe("hitTestScreen", () => {
  const obj = (id: string, kind: SceneObject["kind"]): SceneObject => ({ id, kind, layer: "sr", tone: "up", priority: 50, emphasis: "normal", hover: { title: id } }) as SceneObject;
  const screen = (objects: ScreenScene["objects"], placed: ScreenScene["labels"]["placed"] = []): ScreenScene =>
    ({ frameKey: "", viewport: { width: 500, height: 400, insetTop: 0, volumeTopY: 400, free: null, gutter: null }, objects, obstacles: { candles: candleBand({ x: () => 0, y: () => 0, visibleLogical: () => null, barSpacing: () => 8, lastBarX: () => null, width: 1, height: 1 }, []), rects: [] }, labels: { placed, dropped: [] }, axis: { placed: [], hiddenBands: [], dropped: [] }, yLast: null, countdownY: null }) as ScreenScene;

  const line = { obj: obj("line", "hline"), geom: { kind: "hline" as const, x1: 0, x2: 500, y: 100 } };
  const glyph = { obj: obj("glyph", "glyph"), geom: { kind: "glyph" as const, x: 200, y: 108, r: 4 } };
  const box = { obj: obj("box", "box"), geom: { kind: "box" as const, x1: 50, x2: 450, y1: 150, y2: 250 } };

  it("допуск: 5 мышью, 12 пальцем", () => {
    const s = screen([line]);
    expect(hitTestScreen(s, 300, 104, 5)).toEqual({ objectId: "line", distance: 4, priority: 1 });
    expect(hitTestScreen(s, 300, 108, 5)).toBeNull();
    expect(hitTestScreen(s, 300, 111, 12)?.objectId).toBe("line");
  });

  it("значок выигрывает у линии при равном расстоянии; коробка изнутри — 0, но линия важнее", () => {
    const s = screen([line, glyph, box]);
    expect(hitTestScreen(s, 200, 102, 5)).toEqual({ objectId: "glyph", distance: 2, priority: 2 });
    expect(hitTestScreen(s, 300, 200, 5)).toEqual({ objectId: "box", distance: 0, priority: 0 });
    const lineInBox = { obj: obj("in", "hline"), geom: { kind: "hline" as const, x1: 0, x2: 500, y: 200 } };
    expect(hitTestScreen(screen([box, lineInBox]), 300, 203, 5)?.objectId).toBe("in");
    // при равных — верхний по порядку
    const twin = { obj: obj("twin", "hline"), geom: { kind: "hline" as const, x1: 0, x2: 500, y: 100 } };
    expect(hitTestScreen(screen([line, twin]), 10, 100, 5)?.objectId).toBe("twin");
  });

  it("плашка ведёт к своему объекту; полоса карты — к сумме", () => {
    const placed = [{ id: "line#label", objectId: "line", layer: "sr" as const, text: "Поддержка", rect: { x: 400, y: 70, w: 70, h: 17 }, slot: "free-above" as const, tone: "up" as const, font: "sans" as const, px: 11, priority: 80, bypassBudget: false }];
    expect(hitTestScreen(screen([line], placed), 420, 75, 5)).toEqual({ objectId: "line", distance: 0, priority: 2 });
    const heat = { obj: obj("liq:map", "heat"), geom: { kind: "heat" as const, x1: 500, dimmed: false, rows: [{ y1: 300, y2: 310, w: 40, alpha: 0.2, topId: "liq:L:3" }, { y1: 310, y2: 320, w: 10, alpha: 0.1, topId: null }] } };
    expect(hitTestScreen(screen([heat]), 470, 305, 5)?.objectId).toBe("liq:L:3");
    expect(hitTestScreen(screen([heat]), 495, 315, 5)?.objectId).toBe("liq:map");
    expect(hitTestScreen(screen([heat]), 470, 315, 5)).toBeNull();
    const prof = { obj: obj("vp", "profile"), geom: { kind: "profile" as const, x1: 500, dimmed: false, rows: [{ y1: 0, y2: 10, w: 40, poc: true, value: true }] } };
    expect(hitTestScreen(screen([prof]), 480, 5, 5)?.objectId).toBe("vp");
    const poly = { obj: obj("fig:1", "polyline"), geom: { kind: "polyline" as const, paths: [[[0, 0], [100, 100]] as const], dots: [] } };
    expect(hitTestScreen(screen([poly]), 50, 53, 5)?.objectId).toBe("fig:1");
    expect(hitTestScreen(screen([]), 1, 1, 5)).toBeNull();
  });
});

describe("TF_SECONDS и шаг фейкового проектора", () => {
  it("фикстура 4h идёт шагом 4 часа", () => {
    const fx = loadFixture("btc-4h-rich");
    expect(fx.candles[1]!.time - fx.candles[0]!.time).toBe(TF_SECONDS["4h"]);
  });
});

/** Тип темы используется только частично: проверяем совместимость с полной ChartTheme. */
export type _ThemeCompat = ProjectOptions["theme"] extends Pick<ChartTheme, "version"> ? true : never;
