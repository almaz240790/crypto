import type { ViewPreset } from "../presets";
import { volumeProfile } from "../scene/layers/profile";
import type { LabelSpec, Scene, SceneObject, SlotKey } from "../scene/types";
import type { ChartTheme } from "../theme";
import type { Candle } from "../types";
import { layoutAxis } from "./axis";
import { layoutLabels } from "./labels";
import type { TextMeasurer } from "./measure";
import type { AxisCandidate, AxisFixed, AxisLayout, CandleBand, LabelCandidate, LayoutResult, Obstacles, Rect, Slot, Viewport } from "./types";

/**
 * Проекция сцены на экран в одном кадре (план 2B.2): координаты объектов, свободная зона и полоса справа,
 * препятствия, раскладка подписей и меток шкалы. Чистая функция над SceneProjector — без LWC; один результат
 * делят отрисовка, метки шкалы и hitTest.
 */

/** Координаты из LWC (в B2 — через TimeProjector из drawings/primitive.ts: время правее данных экстраполируется). */
export interface SceneProjector {
  x(time: number): number | null;
  y(price: number): number | null;
  visibleLogical(): { from: number; to: number } | null;
  barSpacing(): number;
  /** x центра последней свечи буфера. */
  lastBarX(): number | null;
  width: number;
  height: number;
}

export interface ProjectOptions {
  view: ViewPreset;
  theme: Pick<ChartTheme, "version" | "type" | "alphas">;
  measure: TextMeasurer;
  /** Живая цена: полоса текущей цены, сторона меток шкалы. */
  lastPrice: number | null;
  hovered: string | null;
  /** y последнего значения наложенного инструмента (метка LWC) — препятствие на шкале. */
  overlayY?: number | null;
  /** Прямоугольники интерфейса поверх графика (кнопки в углу — C). */
  ui?: readonly Rect[];
  uiRev?: number;
  /** Идёт жест (диапазон менялся меньше 150 мс назад): только подписи с приоритетом ≥ 80 и выбранная (план 2A.7). */
  gesture?: boolean;
}

export type ScreenGeom =
  | { kind: "hline"; x1: number; x2: number; y: number }
  | { kind: "box"; x1: number; x2: number; y1: number; y2: number }
  | { kind: "glyph"; x: number; y: number; r: number }
  | { kind: "polyline"; paths: readonly (readonly (readonly [number, number])[])[]; dots: readonly (readonly [number, number])[] }
  | { kind: "heat"; x1: number; dimmed: boolean; rows: readonly { y1: number; y2: number; w: number; alpha: number; topId: string | null }[] }
  | { kind: "profile"; x1: number; dimmed: boolean; rows: readonly { y1: number; y2: number; w: number; poc: boolean; value: boolean }[] };

export interface ScreenObject {
  obj: SceneObject;
  geom: ScreenGeom;
}

export interface ScreenScene {
  frameKey: string;
  viewport: Viewport;
  objects: readonly ScreenObject[];
  obstacles: Obstacles;
  labels: LayoutResult;
  axis: AxisLayout;
  /** y живой цены; null — цена вне шкалы или неизвестна. */
  yLast: number | null;
  /** Центр отсчёта до закрытия под ценой (DOM-зеркало на шкале); null — не показывается. */
  countdownY: number | null;
}

/** Радиус значка, px. */
export const GLYPH_R = 4;
/** Подпись от линии — на 2 px. */
const LINE_PAD = 2;
/** Свободная зона уже 8 px — её нет. */
const MIN_FREE_PX = 8;
/** Профиль поверх свечей — 25 % ширины панели. */
const PROFILE_OVERLAY_SHARE = 0.25;
/** Ширина колокольчика перед текстом алерта вместе с зазором, в долях кегля. */
const ICON_EM = 1;
/** Приоритет подписи, которая остаётся во время жеста. */
export const GESTURE_MIN_PRIORITY = 80;

const r2 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "-" : (Math.round(v * 100) / 100).toFixed(2));

/** Ключ кадра: пока он тот же, раскладка не пересчитывается (неподвижный график — 0 пересчётов). */
export function screenFrameKey(scene: Scene, proj: SceneProjector, visibleCandles: readonly Candle[], opts: ProjectOptions): string {
  const r = proj.visibleLogical();
  const p1 = opts.lastPrice ?? 1;
  const last = visibleCandles[visibleCandles.length - 1];
  return [
    scene.version,
    opts.theme.version,
    opts.view.device,
    r ? `${r.from.toFixed(2)}:${r.to.toFixed(2)}` : "-",
    `${proj.width}x${proj.height}`,
    r2(proj.y(p1)),
    r2(proj.y(p1 * 1.01)),
    visibleCandles.length,
    last ? `${last.time}:${last.high}:${last.low}` : "-",
    opts.hovered ?? "",
    opts.uiRev ?? 0,
    opts.gesture ? 1 : 0,
    r2(opts.overlayY),
  ].join("|");
}

/** Свободная зона справа от последней свечи и полоса под карту ликвидаций / профиль. */
export function freeAndGutter(proj: SceneProjector, view: ViewPreset): Pick<Viewport, "free" | "gutter"> {
  const width = proj.width;
  const lastX = proj.lastBarX();
  let free: Viewport["free"] = null;
  if (lastX !== null && Number.isFinite(lastX)) {
    const x0 = Math.max(0, lastX + proj.barSpacing() / 2 + 2);
    if (width - x0 >= MIN_FREE_PX) free = { x0, x1: width };
  }
  let gutter: Viewport["gutter"] = null;
  if (view.gutterPx > 0) {
    if (free && free.x1 - free.x0 >= view.gutterPx + MIN_FREE_PX) gutter = { x0: free.x1 - view.gutterPx, x1: free.x1, mode: "reserved" };
    else gutter = { x0: width - view.gutterPx, x1: width, mode: "overlay" };
  }
  return { free, gutter };
}

/** Индекс колонок видимых свечей: y максимума и минимума, полуширина max(1, 0.4·шаг) + 1. */
export function candleBand(proj: SceneProjector, visibleCandles: readonly Candle[]): CandleBand {
  const n = visibleCandles.length;
  const spacing = proj.barSpacing();
  const top = new Float32Array(n);
  const bottom = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = visibleCandles[i]!;
    top[i] = proj.y(c.high) ?? NaN;
    bottom[i] = proj.y(c.low) ?? NaN;
  }
  const x0 = n > 0 ? (proj.x(visibleCandles[0]!.time) ?? 0) : 0;
  return { x0, spacing, halfWidth: Math.max(1, 0.4 * spacing) + 1, top, bottom };
}

type Ctx = {
  proj: SceneProjector;
  vp: Viewport;
  opts: ProjectOptions;
  candleAt: Map<number, Candle>;
  candles: readonly Candle[];
};

function project(obj: SceneObject, c: Ctx): ScreenGeom | null {
  const { proj, vp } = c;
  const W = proj.width;
  const H = proj.height;
  switch (obj.kind) {
    case "hline": {
      const y = proj.y(obj.price);
      if (y === null || y < -2 || y > H + 2) return null;
      const x1 = obj.from === null ? 0 : (proj.x(obj.from) ?? 0);
      const x2 = obj.to === null ? W : (proj.x(obj.to) ?? W);
      if (x1 > W || x2 < 0 || x2 <= x1) return null;
      return { kind: "hline", x1: Math.max(0, x1), x2: Math.min(W, x2), y };
    }
    case "box": {
      const a = proj.y(obj.top);
      const b = proj.y(obj.bottom);
      if (a === null || b === null) return null;
      const y1 = Math.min(a, b);
      const y2 = Math.max(a, b);
      if (y2 < 0 || y1 > H) return null;
      const x1 = proj.x(obj.from) ?? 0;
      const x2 = obj.to === null ? W : (proj.x(obj.to) ?? W);
      if (x1 > W || x2 < 0 || x2 <= x1) return null;
      return { kind: "box", x1: Math.max(0, x1), x2: Math.min(W, x2), y1, y2 };
    }
    case "glyph": {
      const x = proj.x(obj.time);
      if (x === null || x < -GLYPH_R * 2 || x > W + GLYPH_R * 2) return null;
      const candle = c.candleAt.get(obj.time);
      let y: number | null = null;
      if (candle && obj.side === "above") y = (proj.y(candle.high) ?? NaN) - GLYPH_R - 3;
      else if (candle && obj.side === "below") y = (proj.y(candle.low) ?? NaN) + GLYPH_R + 3;
      else if (obj.price !== null) y = proj.y(obj.price);
      if (y === null || !Number.isFinite(y) || y < -GLYPH_R || y > H + GLYPH_R) return null;
      return { kind: "glyph", x, y, r: GLYPH_R };
    }
    case "polyline": {
      const pt = ([t, p]: readonly [number, number]): [number, number] | null => {
        const x = proj.x(t);
        const y = proj.y(p);
        return x === null || y === null ? null : [x, y];
      };
      const paths = obj.paths.map((ps) => ps.map(pt)).filter((ps): ps is [number, number][] => ps.length >= 2 && ps.every((p) => p !== null));
      if (paths.length === 0) return null;
      const dots = (obj.dots ?? []).map(pt).filter((p): p is [number, number] => p !== null);
      return { kind: "polyline", paths, dots };
    }
    case "heat": {
      const g = vp.gutter;
      if (!g) return null;
      const { heatMin, heatMax, dimmed } = c.opts.theme.alphas;
      const k = g.mode === "overlay" ? dimmed : 1;
      const width = g.x1 - g.x0;
      const tops = new Map(obj.tops.map((t) => [t.price, t.id]));
      const rows = [];
      for (const b of obj.bars) {
        const ya = proj.y(b.price + obj.step / 2);
        const yb = proj.y(b.price - obj.step / 2);
        if (ya === null || yb === null) continue;
        const y1 = Math.min(ya, yb);
        const y2 = Math.max(ya, yb);
        if (y2 < 0 || y1 > H) continue;
        rows.push({ y1, y2, w: width * b.weight, alpha: k * (heatMin + (heatMax - heatMin) * b.weight), topId: tops.get(b.price) ?? null });
      }
      return rows.length > 0 ? { kind: "heat", x1: g.x1, dimmed: g.mode === "overlay", rows } : null;
    }
    case "profile": {
      const g = vp.gutter;
      if (!g) return null;
      const overlay = obj.emphasis === "dimmed" || g.mode === "overlay";
      const maxW = overlay ? W * PROFILE_OVERLAY_SHARE : g.x1 - g.x0;
      const prof = volumeProfile(c.candles, obj.rows, obj.valueArea);
      const maxV = prof.reduce((m, r) => Math.max(m, r.volume), 0);
      if (maxV <= 0) return null;
      const rows = [];
      for (const r of prof) {
        const ya = proj.y(r.top);
        const yb = proj.y(r.bottom);
        if (ya === null || yb === null) continue;
        rows.push({ y1: Math.min(ya, yb), y2: Math.max(ya, yb), w: (maxW * r.volume) / maxV, poc: r.poc, value: r.value });
      }
      return rows.length > 0 ? { kind: "profile", x1: overlay ? W : g.x1, dimmed: overlay, rows } : null;
    }
  }
}

/** Места подписи объекта в пикселях, по порядку; места, условие которых не выполнено, пропускаются. */
function slotsFor(obj: SceneObject, geom: ScreenGeom, label: LabelSpec, w: number, h: number, c: Ctx, anchorY?: number): Slot[] {
  const { vp, proj } = c;
  const out: Slot[] = [];
  const add = (key: SlotKey, x: number, y: number, clampX = false) => out.push({ key, x, y, clampX });
  for (const key of label.slots) {
    switch (key) {
      case "free-above":
      case "free-below": {
        if (geom.kind !== "hline" || !vp.free) break;
        const x = vp.free.x1 - 4 - w;
        if (x < vp.free.x0) break;
        add(key, x, key === "free-above" ? geom.y - LINE_PAD - h : geom.y + LINE_PAD);
        break;
      }
      case "line-end-above":
      case "line-end-below":
        if (geom.kind !== "hline") break;
        add(key, Math.min(geom.x2, vp.width) - 4 - w, key === "line-end-above" ? geom.y - LINE_PAD - h : geom.y + LINE_PAD);
        break;
      case "line-start-above":
        if (geom.kind !== "hline") break;
        add(key, Math.max(geom.x1, 0) + 4, geom.y - LINE_PAD - h);
        break;
      case "break-above":
      case "break-below": {
        if (geom.kind !== "hline" || obj.kind !== "hline" || obj.to === null) break;
        const xt = proj.x(obj.to);
        if (xt === null) break;
        add(key, xt - proj.barSpacing() / 2 - 2 - w, key === "break-above" ? geom.y - LINE_PAD - h : geom.y + LINE_PAD);
        break;
      }
      case "box-top-left":
      case "box-bottom-left":
        if (geom.kind !== "box" || geom.y2 - geom.y1 < h) break;
        add(key, Math.max(geom.x1, 0) + 4, key === "box-top-left" ? geom.y1 + 2 : geom.y2 - 2 - h, true);
        break;
      case "box-free": {
        if (geom.kind !== "box" || !vp.free) break;
        const mid = (geom.y1 + geom.y2) / 2;
        add(key, vp.free.x0 + 4, Math.min(Math.max(mid - h / 2, geom.y1), geom.y2 - h));
        break;
      }
      case "glyph-above":
      case "glyph-below":
        if (geom.kind !== "glyph") break;
        add(key, geom.x - w / 2, key === "glyph-above" ? geom.y - geom.r - 2 - h : geom.y + geom.r + 2);
        break;
      case "polyline-end-above":
      case "polyline-start-above": {
        if (geom.kind !== "polyline") break;
        const pts = geom.paths.flat();
        const end = pts.reduce((a, b) => (b[0] > a[0] ? b : a));
        const start = pts.reduce((a, b) => (b[0] < a[0] ? b : a));
        if (key === "polyline-end-above") add(key, end[0] - 2 - w, end[1] - LINE_PAD - h);
        else add(key, start[0] + 2, start[1] - LINE_PAD - h);
        break;
      }
      case "gutter-mid":
        if (!vp.free || vp.gutter?.mode !== "reserved" || anchorY === undefined) break;
        add(key, vp.free.x1 - 2 - w, anchorY - h / 2);
        break;
    }
  }
  return out;
}

function candidate(id: string, objectId: string, obj: SceneObject, label: LabelSpec, geom: ScreenGeom, c: Ctx, bypass: boolean, anchorY?: number): LabelCandidate {
  const t = c.opts.theme.type;
  const px = t.labelPx;
  const textW = c.opts.measure.measure(label.text, label.font, px, label.font === "sans" ? t.labelWeight : 500).w;
  const w = Math.ceil(textW + 2 * t.plaquePadX + (label.icon ? px * ICON_EM : 0));
  const h = px + 2 * t.plaquePadY + 2;
  return {
    id,
    objectId,
    layer: obj.layer,
    text: label.text,
    font: label.font,
    px,
    w,
    h,
    priority: label.priority,
    tone: label.tone,
    slots: slotsFor(obj, geom, label, w, h, c, anchorY),
    bypassBudget: bypass,
    ...(obj.emphasis === "selected" ? { selected: true } : {}),
    ...(label.icon ? { icon: label.icon } : {}),
  };
}

/** Проекция сцены, препятствия и раскладка подписей и шкалы одного кадра. */
export function projectScene(scene: Scene, proj: SceneProjector, visibleCandles: readonly Candle[], opts: ProjectOptions): ScreenScene {
  const { view } = opts;
  const { free, gutter } = freeAndGutter(proj, view);
  const viewport: Viewport = { width: proj.width, height: proj.height, insetTop: view.insetTopPx, volumeTopY: view.volumeTop * proj.height, free, gutter };
  const c: Ctx = { proj, vp: viewport, opts, candleAt: new Map(visibleCandles.map((x) => [x.time, x])), candles: visibleCandles };
  const objects: ScreenObject[] = [];
  for (const obj of scene.objects) {
    const geom = project(obj, c);
    if (geom) objects.push({ obj, geom });
  }
  const yLastRaw = opts.lastPrice === null ? null : proj.y(opts.lastPrice);
  const yLast = yLastRaw !== null && Number.isFinite(yLastRaw) && yLastRaw >= 0 && yLastRaw <= proj.height ? yLastRaw : null;
  // подписи
  const cands: LabelCandidate[] = [];
  for (const { obj, geom } of objects) {
    const selected = obj.emphasis === "selected";
    const hovered = opts.hovered !== null && opts.hovered === obj.id;
    if (geom.kind === "heat" && obj.kind === "heat") {
      if (gutter?.mode !== "reserved") continue;
      for (const top of obj.tops) {
        if (opts.gesture && top.label.priority < GESTURE_MIN_PRIORITY && !selected) continue;
        const ym = proj.y(top.price);
        if (ym === null) continue;
        cands.push(candidate(`${top.id}#label`, top.id, obj, top.label, geom, c, selected || opts.hovered === top.id, ym));
      }
      continue;
    }
    const label = obj.label;
    if (!label) continue;
    if (label.show === "hover" && !hovered && !selected) continue;
    if (opts.gesture && label.priority < GESTURE_MIN_PRIORITY && !selected) continue;
    let anchorY: number | undefined;
    if (geom.kind === "profile") {
      if (geom.dimmed) continue;
      const poc = geom.rows.find((r) => r.poc);
      if (!poc) continue;
      anchorY = (poc.y1 + poc.y2) / 2;
    }
    cands.push(candidate(`${obj.id}#label`, obj.id, obj, label, geom, c, selected || (hovered && label.show === "hover"), anchorY));
  }
  const rects: Obstacles["rects"][number][] = [{ rect: { x: 0, y: 0, w: proj.width, h: view.insetTopPx }, kind: "legend" }];
  if (yLast !== null) {
    const x = free?.x0 ?? 0;
    rects.push({ rect: { x, y: yLast - view.axisLabelPx / 2, w: Math.max(0, proj.width - x), h: view.axisLabelPx }, kind: "lastPrice" });
  }
  for (const r of opts.ui ?? []) rects.push({ rect: r, kind: "ui" });
  const obstacles: Obstacles = { candles: candleBand(proj, visibleCandles), rects };
  const labels = layoutLabels(cands, obstacles, viewport, view.labels);
  // шкала
  const axisCands: AxisCandidate[] = [];
  for (const obj of scene.objects) {
    if (!obj.axis || obj.kind !== "hline") continue;
    const y = proj.y(obj.price);
    if (y === null) continue;
    const side = opts.lastPrice !== null ? (obj.price >= opts.lastPrice ? "above" : "below") : y < proj.height / 2 ? "above" : "below";
    axisCands.push({ id: `${obj.id}#axis`, objectId: obj.id, price: obj.price, y, text: obj.axis.text, tone: obj.axis.tone, style: obj.axis.style, priority: obj.emphasis === "selected" ? 95 : obj.axis.priority, group: obj.axis.group, side });
  }
  const fixed: AxisFixed[] = [];
  const countdownY = yLast !== null && view.axis.countdown ? yLast + view.axisLabelPx : null;
  if (yLast !== null) fixed.push({ id: "last", y: yLast, h: view.axisLabelPx });
  if (countdownY !== null) fixed.push({ id: "countdown", y: countdownY, h: view.axisLabelPx });
  if (opts.overlayY != null && Number.isFinite(opts.overlayY)) fixed.push({ id: "overlay", y: opts.overlayY, h: view.axisLabelPx });
  const axis = layoutAxis(axisCands, fixed, { height: proj.height, labelH: view.axisLabelPx, gap: view.axisGapPx, maxShift: 1.5 * view.axisLabelPx, tickFontPx: view.scaleFontPx }, view.axis);
  return { frameKey: screenFrameKey(scene, proj, visibleCandles, opts), viewport, objects, obstacles, labels, axis, yLast, countdownY };
}

export interface SceneHit {
  objectId: string;
  distance: number;
  /** Значок и плашка 2, линия 1, коробка и полосы 0 (hitTestPriority LWC). */
  priority: 0 | 1 | 2;
}

function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

const distToRect = (px: number, py: number, x1: number, y1: number, x2: number, y2: number) => Math.hypot(Math.max(x1 - px, 0, px - x2), Math.max(y1 - py, 0, py - y2));

/**
 * Попадание по объектам кадра: в пределах допуска побеждает больший приоритет (значок и плашка, затем линия,
 * затем коробка), при равном — ближний, при равном расстоянии — верхний по порядку отрисовки.
 */
export function hitTestScreen(screen: ScreenScene, x: number, y: number, tolerancePx: number): SceneHit | null {
  let best: (SceneHit & { z: number }) | null = null;
  const offer = (objectId: string, distance: number, priority: 0 | 1 | 2, z: number) => {
    if (!(distance <= tolerancePx)) return;
    if (!best || priority > best.priority || (priority === best.priority && (distance < best.distance || (distance === best.distance && z > best.z)))) best = { objectId, distance, priority, z };
  };
  screen.objects.forEach(({ obj, geom }, z) => {
    switch (geom.kind) {
      case "hline":
        if (x >= geom.x1 - tolerancePx && x <= geom.x2 + tolerancePx) offer(obj.id, Math.abs(y - geom.y), 1, z);
        break;
      case "box":
        offer(obj.id, distToRect(x, y, geom.x1, geom.y1, geom.x2, geom.y2), 0, z);
        break;
      case "glyph":
        offer(obj.id, Math.max(0, Math.hypot(x - geom.x, y - geom.y) - geom.r), 2, z);
        break;
      case "polyline": {
        let d = Infinity;
        for (const ps of geom.paths) for (let i = 1; i < ps.length; i++) d = Math.min(d, distToSegment(x, y, ps[i - 1]![0], ps[i - 1]![1], ps[i]![0], ps[i]![1]));
        offer(obj.id, d, 1, z);
        break;
      }
      case "heat":
        for (const r of geom.rows) if (x >= geom.x1 - r.w && x <= geom.x1 && y >= r.y1 && y <= r.y2) offer(r.topId ?? obj.id, 0, 0, z);
        break;
      case "profile":
        for (const r of geom.rows) if (x >= geom.x1 - r.w && x <= geom.x1 && y >= r.y1 && y <= r.y2) offer(obj.id, 0, 0, z);
        break;
    }
  });
  const top = screen.objects.length;
  screen.labels.placed.forEach((p, i) => {
    if (x >= p.rect.x && x <= p.rect.x + p.rect.w && y >= p.rect.y && y <= p.rect.y + p.rect.h) offer(p.objectId, 0, 2, top + i);
  });
  const b = best as (SceneHit & { z: number }) | null;
  return b ? { objectId: b.objectId, distance: b.distance, priority: b.priority } : null;
}
