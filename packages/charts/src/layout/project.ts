import type { ViewPreset } from "../presets";
import { volumeProfile, type VpRow } from "../scene/layers/profile";
import type { LabelSpec, ProfileObject, Scene, SceneObject, SlotKey } from "../scene/types";
import type { ChartTheme } from "../theme";
import type { Candle } from "../types";
import { layoutAxis } from "./axis";
import { layoutLabels } from "./labels";
import type { TextMeasurer } from "./measure";
import type { AxisCandidate, AxisFixed, AxisLayout, CandleBand, LabelCandidate, LayoutResult, Obstacles, Rect, Slot, Viewport } from "./types";
import { LABEL_GAP } from "./types";

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
  /**
   * Что показывает залитая метка цены LWC: закрытие последней видимой свечи (lastValueData(false)). live —
   * это живая свеча: тогда под меткой отсчёт до закрытия; история прокручена — отсчёта нет, полоса скрытых
   * делений — под меткой LWC, а не под живой ценой. Без поля — живая цена, live.
   */
  plaque?: { price: number; up: boolean; live: boolean } | null;
  hovered: string | null;
  /** y последнего значения наложенного инструмента (метка LWC) — препятствие на шкале. */
  overlayY?: number | null;
  /** Прямоугольники интерфейса поверх графика (кнопки в углу — C). */
  ui?: readonly Rect[];
  uiRev?: number;
  /** Идёт жест (диапазон менялся меньше 150 мс назад): только подписи с приоритетом ≥ 80 и выбранная (план 2A.7). */
  gesture?: boolean;
  /**
   * Строки профиля объёма из кэша на устоявшийся диапазон (OverlayPrimitive: пересчёт через 150 мс после жеста,
   * во время жеста — прежние строки); без него — по видимым свечам этого кадра. profileKey входит в ключ кадра.
   */
  profileRows?: (obj: ProfileObject) => readonly VpRow[];
  profileKey?: string;
  /**
   * Подписи рисунков пользователя (drawings/labels.ts) — в той же раскладке: подписи разметки ниже их приоритета
   * обходят их, они обходят старшие (алерты, уровни сигнала, выбранный объект). externalKey — в ключе кадра.
   */
  external?: readonly LabelCandidate[];
  externalKey?: string;
  /**
   * Видимые свечи, как их рисует основная серия, если они не те, что visibleCandles (Heikin Ashi; то же число и
   * время): значки разметки встают у их хвостов, колонки-препятствия подписей — по ним. Профиль объёма и цена —
   * по visibleCandles. Без поля — visibleCandles.
   */
  shown?: readonly Candle[];
}

export type ScreenGeom =
  | { kind: "hline"; x1: number; x2: number; y: number }
  | { kind: "box"; x1: number; x2: number; y1: number; y2: number }
  | { kind: "glyph"; x: number; y: number; r: number }
  | { kind: "polyline"; paths: readonly (readonly (readonly [number, number])[])[]; dots: readonly (readonly [number, number])[] }
  | { kind: "heat"; x1: number; dimmed: boolean; rows: readonly { y1: number; y2: number; w: number; alpha: number; topId: string | null; selected?: boolean }[] }
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
  /** Залитая метка цены на шкале: её y и направление свечи (цвет образца «Цена» в легенде); null — вне шкалы. */
  plaque: { y: number; up: boolean; live: boolean } | null;
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
/** Приоритет выбранного объекта в раскладке подписей и шкалы. */
export const SELECTED_PRIORITY = 95;

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
    opts.externalKey ?? "",
    r2(opts.overlayY),
    opts.profileKey ?? "",
    opts.plaque ? `${opts.plaque.price}:${opts.plaque.live ? 1 : 0}` : "",
    shownKey(opts.shown),
  ].join("|");
}

/** Нарисованные свечи в ключе кадра: смена типа графика и последняя HA-свеча (её high/low зависят от прошлых). */
function shownKey(shown: readonly Candle[] | undefined): string {
  if (!shown) return "";
  const last = shown[shown.length - 1];
  return last ? `ha:${last.time}:${last.high}:${last.low}` : "ha";
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
  /** Полоса справа (reserved) занята картой ликвидаций или профилем: подписи уровней кончаются левее неё. */
  gutterBusy: boolean;
  /** Карта ликвидаций и профиль вместе: полоса делится пополам (профиль слева, карта справа). */
  gutterShared: boolean;
  profile(obj: ProfileObject): readonly VpRow[];
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
      const width = (g.x1 - g.x0) / (c.gutterShared && g.mode === "reserved" ? 2 : 1);
      // полоса корзины ведёт к скоплению, в которое она входит (выбранное — первым)
      const tops = [...obj.tops].sort((a, b) => (a.id === obj.selectedTop ? -1 : b.id === obj.selectedTop ? 1 : 0));
      const rows = [];
      for (const b of obj.bars) {
        const ya = proj.y(b.price + obj.step / 2);
        const yb = proj.y(b.price - obj.step / 2);
        if (ya === null || yb === null) continue;
        const y1 = Math.min(ya, yb);
        const y2 = Math.max(ya, yb);
        if (y2 < 0 || y1 > H) continue;
        const top = tops.find((t) => b.price >= t.lo - obj.step / 4 && b.price <= t.hi + obj.step / 4) ?? null;
        const selected = top !== null && top.id === obj.selectedTop;
        rows.push({ y1, y2, w: width * b.weight, alpha: k * (selected ? heatMax : heatMin + (heatMax - heatMin) * b.weight), topId: top?.id ?? null, selected });
      }
      return rows.length > 0 ? { kind: "heat", x1: g.x1, dimmed: g.mode === "overlay", rows } : null;
    }
    case "profile": {
      const g = vp.gutter;
      if (!g) return null;
      // делит полосу с картой ликвидаций — левая половина полосы, приглушённо; без полосы — поверх свечей
      const half = obj.emphasis === "dimmed" && g.mode === "reserved";
      const overlay = g.mode === "overlay";
      const maxW = overlay ? W * PROFILE_OVERLAY_SHARE : half ? (g.x1 - g.x0) / 2 : g.x1 - g.x0;
      const prof = c.profile(obj);
      const maxV = prof.reduce((m, r) => Math.max(m, r.volume), 0);
      if (maxV <= 0) return null;
      const rows = [];
      for (const r of prof) {
        const ya = proj.y(r.top);
        const yb = proj.y(r.bottom);
        if (ya === null || yb === null) continue;
        rows.push({ y1: Math.min(ya, yb), y2: Math.max(ya, yb), w: (maxW * r.volume) / maxV, poc: r.poc, value: r.value });
      }
      return rows.length > 0 ? { kind: "profile", x1: overlay ? W : half ? g.x0 + (g.x1 - g.x0) / 2 : g.x1, dimmed: overlay || half, rows } : null;
    }
  }
}

/** Места подписи объекта в пикселях, по порядку; места, условие которых не выполнено, пропускаются. */
function slotsFor(obj: SceneObject, geom: ScreenGeom, label: LabelSpec, w: number, h: number, c: Ctx, anchorY?: number): Slot[] {
  const { vp, proj } = c;
  const out: Slot[] = [];
  const add = (key: SlotKey, x: number, y: number, clampX = false) => out.push({ key, x, y, clampX });
  // полоса справа занята картой или профилем — подписи уровней кончаются у её левого края, а не на полосах;
  // алерт пользователя, вход/стоп сигнала и выбранный, если левее места нет, — последним вариантом на полосе
  // (плашка тогда непрозрачная, render/paint.ts); уровни и зоны полосы карты не закрывают
  const busy = c.gutterBusy && vp.gutter !== null ? vp.gutter.x0 - LABEL_GAP : null;
  const rightEdge = busy ?? vp.width - 4;
  const overGutter = busy !== null && (obj.layer === "alerts" || obj.layer === "signals" || obj.emphasis === "selected");
  const late: Slot[] = [];
  // колонка свечи с запасом раскладки: место у свечи пробоя или у свинга начинается за ней, а не на ней
  const col = Math.max(1, 0.4 * proj.barSpacing()) + 1 + LABEL_GAP + 1;
  for (const key of label.slots) {
    switch (key) {
      case "free-above":
      case "free-below": {
        if (geom.kind !== "hline" || !vp.free) break;
        const x = (busy ?? vp.free.x1 - 4) - w;
        const y = key === "free-above" ? geom.y - LINE_PAD - h : geom.y + LINE_PAD;
        // у занятой полосы подпись может выйти левее свободной зоны: свечи там проверяет раскладка
        if (busy === null && x < vp.free.x0) break;
        add(key, x, y);
        if (overGutter) late.push({ key, x: vp.free.x1 - 4 - w, y, clampX: false });
        break;
      }
      case "line-end-above":
      case "line-end-below":
        if (geom.kind !== "hline") break;
        add(key, Math.min(geom.x2 - 4, rightEdge) - w, key === "line-end-above" ? geom.y - LINE_PAD - h : geom.y + LINE_PAD);
        if (overGutter) late.push({ key, x: Math.min(geom.x2, vp.width) - 4 - w, y: key === "line-end-above" ? geom.y - LINE_PAD - h : geom.y + LINE_PAD, clampX: false });
        break;
      case "line-start-above":
      case "line-start-below":
        if (geom.kind !== "hline") break;
        add(key, Math.max(geom.x1, 0) + (obj.kind === "hline" && obj.from !== null && geom.x1 > 0 ? col : 4), key === "line-start-above" ? geom.y - LINE_PAD - h : geom.y + LINE_PAD);
        break;
      case "break-above":
      case "break-below": {
        if (geom.kind !== "hline" || obj.kind !== "hline" || obj.to === null) break;
        const xt = proj.x(obj.to);
        if (xt === null) break;
        add(key, xt - col - w, key === "break-above" ? geom.y - LINE_PAD - h : geom.y + LINE_PAD);
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
        add(key, busy !== null ? Math.min(vp.free.x0 + 4, busy - w) : vp.free.x0 + 4, Math.min(Math.max(mid - h / 2, geom.y1), geom.y2 - h));
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
  return late.length > 0 ? [...out, ...late] : out;
}

function candidate(id: string, objectId: string, obj: SceneObject, label: LabelSpec, geom: ScreenGeom, c: Ctx, bypass: boolean, anchorY?: number, extra: Pick<LabelCandidate, "rank" | "cap" | "selected"> = obj.emphasis === "selected" ? { selected: true } : {}): LabelCandidate {
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
    // выбранный раскладывается первым: его место не займёт подпись соседнего уровня (как у метки шкалы — 95)
    priority: extra.selected ? Math.max(label.priority, SELECTED_PRIORITY) : label.priority,
    tone: label.tone,
    slots: slotsFor(obj, geom, label, w, h, c, anchorY),
    bypassBudget: bypass,
    ...extra,
    ...(label.icon ? { icon: label.icon } : {}),
  };
}

/** Проекция сцены, препятствия и раскладка подписей и шкалы одного кадра. */
export function projectScene(scene: Scene, proj: SceneProjector, visibleCandles: readonly Candle[], opts: ProjectOptions): ScreenScene {
  const { view } = opts;
  const { free, gutter } = freeAndGutter(proj, view);
  const viewport: Viewport = { width: proj.width, height: proj.height, insetTop: view.insetTopPx, volumeTopY: view.volumeTop * proj.height, free, gutter };
  const shared = scene.objects.some((o) => o.kind === "profile" && o.emphasis === "dimmed") && scene.objects.some((o) => o.kind === "heat");
  // значки и препятствия — у свечей, как они нарисованы (Heikin Ashi), профиль — по настоящим
  const drawn = opts.shown ?? visibleCandles;
  const c: Ctx = {
    proj,
    vp: viewport,
    opts,
    candleAt: new Map(drawn.map((x) => [x.time, x])),
    candles: drawn,
    gutterBusy: false,
    gutterShared: shared,
    profile: (obj) => opts.profileRows?.(obj) ?? volumeProfile(visibleCandles, obj.rows, obj.valueArea),
  };
  const objects: ScreenObject[] = [];
  for (const obj of scene.objects) {
    const geom = project(obj, c);
    if (geom) objects.push({ obj, geom });
  }
  c.gutterBusy = gutter?.mode === "reserved" && objects.some((o) => o.geom.kind === "heat" || o.geom.kind === "profile");
  const onScale = (p: number | null) => {
    const y = p === null ? null : proj.y(p);
    return y !== null && Number.isFinite(y) && y >= 0 && y <= proj.height ? y : null;
  };
  const yLast = onScale(opts.lastPrice);
  const pl = opts.plaque === undefined ? (opts.lastPrice === null ? null : { price: opts.lastPrice, up: true, live: true }) : opts.plaque;
  const yPlaque = pl ? onScale(pl.price) : null;
  const plaque = pl && yPlaque !== null ? { y: yPlaque, up: pl.up, live: pl.live } : null;
  // подписи
  const cands: LabelCandidate[] = [];
  for (const { obj, geom } of objects) {
    const selected = obj.emphasis === "selected";
    const hovered = opts.hovered !== null && opts.hovered === obj.id;
    if (geom.kind === "heat" && obj.kind === "heat") {
      if (gutter?.mode !== "reserved") continue;
      // кандидаты по убыванию суммы на каждой стороне: крупнейшее за кадром или под объёмом уступает
      // следующему видимому; не больше topsPerSide на сторону; рамка и «сверх бюджета» — только у выбранного
      const rank = { long: 0, short: 0 };
      for (const top of obj.tops) {
        const r = rank[top.side]++;
        const isSel = obj.selectedTop === top.id;
        if (opts.gesture && top.label.priority < GESTURE_MIN_PRIORITY && !isSel) continue;
        const ym = proj.y(top.price);
        if (ym === null || ym < 0 || ym > proj.height) continue;
        cands.push(candidate(`${top.id}#label`, top.id, obj, top.label, geom, c, isSel || opts.hovered === top.id, ym, { rank: r, cap: { key: `${obj.id}:${top.side}`, max: obj.topsPerSide }, ...(isSel ? { selected: true } : {}) }));
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
  const obstacles: Obstacles = { candles: candleBand(proj, drawn), rects };
  const labels = layoutLabels(opts.external?.length ? [...cands, ...opts.external] : cands, obstacles, viewport, view.labels);
  // шкала
  const axisCands: AxisCandidate[] = [];
  for (const obj of scene.objects) {
    if (!obj.axis || obj.kind !== "hline") continue;
    const y = proj.y(obj.price);
    if (y === null) continue;
    const side = opts.lastPrice !== null ? (obj.price >= opts.lastPrice ? "above" : "below") : y < proj.height / 2 ? "above" : "below";
    axisCands.push({ id: `${obj.id}#axis`, objectId: obj.id, price: obj.price, y, text: obj.axis.text, tone: obj.axis.tone, style: obj.axis.style, priority: obj.emphasis === "selected" ? SELECTED_PRIORITY : obj.axis.priority, group: obj.axis.group, side });
  }
  const fixed: AxisFixed[] = [];
  // отсчёт — только под живой ценой: у метки последней видимой свечи истории отсчёта нет
  const countdownY = plaque !== null && plaque.live && view.axis.countdown ? plaque.y + view.axisLabelPx : null;
  if (plaque !== null) fixed.push({ id: "last", y: plaque.y, h: view.axisLabelPx });
  if (countdownY !== null) fixed.push({ id: "countdown", y: countdownY, h: view.axisLabelPx });
  if (opts.overlayY != null && Number.isFinite(opts.overlayY)) fixed.push({ id: "overlay", y: opts.overlayY, h: view.axisLabelPx });
  const axis = layoutAxis(axisCands, fixed, { height: proj.height, labelH: view.axisLabelPx, gap: view.axisGapPx, maxShift: 1.5 * view.axisLabelPx, tickFontPx: view.scaleFontPx }, view.axis);
  return { frameKey: screenFrameKey(scene, proj, visibleCandles, opts), viewport, objects, obstacles, labels, axis, yLast, countdownY, plaque };
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
