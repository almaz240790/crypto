import type {
  AutoscaleInfo,
  IChartApiBase,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  ISeriesPrimitiveAxisView,
  PrimitiveHoveredItem,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";
import { bandsKey, inBands } from "../layout/axis";
import { canvasMeasurer, type TextMeasurer } from "../layout/measure";
import { hitTestScreen, projectScene, screenFrameKey, type ScreenScene } from "../layout/project";
import type { AxisLayout, AxisPlaced, LabelCandidate, LayoutResult, PlacedLabel, Rect, Viewport } from "../layout/types";
import { hitTolerance, type LabelBudget, type ViewPreset } from "../presets";
import { volumeProfile, type VpRow } from "../scene/layers/profile";
import type { ProfileObject, Scene, SceneObject } from "../scene/types";
import { toneColor, type ChartTheme } from "../theme";
import type { Candle } from "../types";
import { AxisViewPool, type AxisViewSpec } from "./axisViews";
import { labelColor, paintBottom, paintNormal, paintTop, type PaintScope } from "./paint";
import { frameProjector } from "./projector";

/**
 * Единственный примитив разметки терминала (план 2B.2, ADR-0008): вместо LevelsPrimitive, BoxPrimitive
 * терминала, VolumeProfilePrimitive, маркеров серии и линий фигур. Один проход в кадре: updateAllViews()
 * считает ScreenScene (координаты, препятствия, раскладку подписей и шкалы, с кэшем по frameKey), и её делят
 * виды панели (bottom / normal / top), постоянный пул видов шкалы и hitTest.
 */

/** Снимок для e2e-переписи подписей (el.__overlay()): дёшево, только чтение. */
export interface OverlayDebug {
  sceneVersion: number;
  frameKey: string;
  labels: readonly (PlacedLabel & { color: string })[];
  axis: readonly AxisPlaced[];
  hiddenBands: AxisLayout["hiddenBands"];
  dropped: LayoutResult["dropped"];
  candles: readonly Rect[];
  lastPrice: Rect | null;
  free: Viewport["free"];
  gutter: Viewport["gutter"];
  budget: LabelBudget;
  minFontPx: number;
  heatRects: readonly Rect[];
  /** Отсчёт до закрытия под ценой (DOM-зеркало на шкале), координаты панели. */
  countdown: Rect | null;
  /** Нарисованные объекты и цвет их линии или заливки (смена темы — перерисовка с новыми цветами). */
  objects: readonly { id: string; layer: string; kind: SceneObject["kind"]; tone: string; color: string; emphasis: SceneObject["emphasis"]; rect: Rect | null }[];
  /** Сколько раз раскладка пересчитывалась (неподвижный график — 0 новых пересчётов). */
  layouts: number;
  /** Подписи рисунков пользователя, размещённые той же раскладкой (их рисует примитив рисунков). */
  drawingLabels: readonly PlacedLabel[];
}

/** Подписи рисунков пользователя для общей раскладки: кандидаты по измерителю текста темы (drawings/labels.ts). */
export type ExternalLabels = (measure: TextMeasurer) => readonly LabelCandidate[];

export interface OverlayOptions {
  view: ViewPreset;
  theme: ChartTheme;
  measure?: TextMeasurer;
  /** Буфер свечей терминала (единственная модель свечей). */
  candles: () => readonly Candle[];
  /** Длительность бара, с (экстраполяция времени правее последней свечи). */
  tfSeconds: () => number;
  /**
   * Свеча, как её рисует основная серия, если она не та, что в буфере (Heikin Ashi): метка цены LWC стоит на её
   * закрытии, и плашка с отсчётом считается от неё. null и без функции — свеча буфера.
   */
  displayed?: (time: number) => { open: number; close: number } | null;
  /**
   * Свечи, как их рисует основная серия (Heikin Ashi; то же число и время, что у буфера): значки разметки и
   * препятствия подписей — у них. null и без функции — свечи буфера.
   */
  shownCandles?: () => readonly Candle[] | null;
  /** y последнего значения наложенного инструмента — его метку на шкале не перекрываем. */
  overlayY?: () => number | null;
  /** false — наведение и клик по объектам выключены (инструмент рисования, рисунок под курсором). */
  hitGate?: (x: number, y: number) => boolean;
  /** Грубый указатель (палец): допуск попадания 12 px и упрощение подписей во время жеста. */
  coarse?: boolean;
  now?: () => number;
}

/** Прямоугольник объекта на экране (для переписи: куда навести и кликнуть). */
function geomRect(g: ScreenScene["objects"][number]["geom"]): Rect | null {
  switch (g.kind) {
    case "box":
      return { x: g.x1, y: g.y1, w: g.x2 - g.x1, h: g.y2 - g.y1 };
    case "hline":
      return { x: g.x1, y: g.y, w: g.x2 - g.x1, h: 0 };
    case "glyph":
      return { x: g.x - g.r, y: g.y - g.r, w: 2 * g.r, h: 2 * g.r };
    default:
      return null;
  }
}

/** Ключ подписей рисунков: раскладка пересчитывается, когда они сдвинулись, сменили текст или размер. */
function externalKey(list: readonly LabelCandidate[]): string {
  return list.map((l) => `${l.id}:${l.text}:${Math.round(l.w)}x${Math.round(l.h)}:${l.slots.map((s) => `${Math.round(s.x)},${Math.round(s.y)}`).join(";")}`).join("|");
}

/** Сколько после изменения видимого диапазона подписи считаются «в жесте» (план 2A.7). */
const GESTURE_SETTLE_MS = 150;

class OverlayRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly src: OverlayPrimitive,
    private readonly part: "bottom" | "normal" | "top",
  ) {}

  draw(target: Parameters<IPrimitivePaneRenderer["draw"]>[0]): void {
    const screen = this.src.screen;
    if (!screen) return;
    target.useBitmapCoordinateSpace((scope) => {
      const s: PaintScope = { ctx: scope.context, hpr: scope.horizontalPixelRatio, vpr: scope.verticalPixelRatio };
      const theme = this.src.theme;
      if (this.part === "bottom") paintBottom(s, screen, theme, this.src.hovered);
      else if (this.part === "normal") paintNormal(s, screen, theme);
      else paintTop(s, screen, theme);
    });
  }
}

class OverlayPaneView implements IPrimitivePaneView {
  private readonly r: OverlayRenderer;
  constructor(
    src: OverlayPrimitive,
    private readonly part: "bottom" | "normal" | "top",
  ) {
    this.r = new OverlayRenderer(src, part);
  }
  zOrder(): PrimitivePaneViewZOrder {
    return this.part;
  }
  renderer(): IPrimitivePaneRenderer {
    return this.r;
  }
}

export class OverlayPrimitive implements ISeriesPrimitive<Time> {
  /** Кадр, который рисуют виды и по которому работает hitTest. */
  screen: ScreenScene | null = null;
  theme: ChartTheme;
  hovered: string | null = null;
  /** Полосы шкалы изменились без смены масштаба: контроллер заново применяет формат цены (деления под метками). */
  onAxisChanged?: (layout: AxisLayout) => void;
  /** Новый кадр раскладки (контроллер двигает DOM-отсчёт под ценой). */
  onFrame?: (screen: ScreenScene) => void;

  private chart: IChartApiBase<Time> | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: (() => void) | null = null;
  private scene: Scene | null = null;
  private view: ViewPreset;
  private measure: TextMeasurer;
  private pool: AxisViewPool;
  private readonly views: readonly IPrimitivePaneView[];
  private ui: readonly Rect[] = [];
  private uiRev = 0;
  private bands: AxisLayout["hiddenBands"] = [];
  private appliedBands = "";
  private scaleKey = "";
  private lastRange = "";
  private lastMove = -Infinity;
  private settle: ReturnType<typeof setTimeout> | null = null;
  /** Повторное применение формата делений, когда масштаб успокоится (полосы сменились вместе с ним). */
  private axisSettle: ReturnType<typeof setTimeout> | null = null;
  private countdownRect: Rect | null = null;
  private layouts = 0;
  /** Кэш строк профиля объёма на устоявшийся видимый диапазон. */
  private vp: { key: string; rows: readonly VpRow[] } | null = null;
  private external: ExternalLabels | null = null;
  /** Сколько раз считался профиль (тест: во время жеста — 0 новых). */
  profileComputations = 0;

  constructor(private readonly opts: OverlayOptions) {
    this.view = opts.view;
    this.theme = opts.theme;
    this.measure = opts.measure ?? canvasMeasurer(opts.theme.type);
    this.pool = new AxisViewPool(opts.view.axis.total + 2);
    this.views = [new OverlayPaneView(this, "bottom"), new OverlayPaneView(this, "normal"), new OverlayPaneView(this, "top")];
  }

  attached(p: SeriesAttachedParameter<Time>): void {
    this.chart = p.chart;
    this.series = p.series;
    this.requestUpdate = p.requestUpdate;
    this.screen = null;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
    this.screen = null;
    if (this.settle) clearTimeout(this.settle);
    this.settle = null;
    if (this.axisSettle) clearTimeout(this.axisSettle);
    this.axisSettle = null;
  }

  get sceneVersion(): number {
    return this.scene?.version ?? 0;
  }

  setScene(scene: Scene): void {
    if (scene === this.scene) return;
    this.scene = scene;
    this.requestUpdate?.();
  }

  /** Смена темы — только перерисовка из палитры: сцена не пересобирается. */
  setTheme(theme: ChartTheme): void {
    if (theme === this.theme) return;
    if (theme.type.sans !== this.theme.type.sans || theme.type.mono !== this.theme.type.mono) this.measure = this.opts.measure ?? canvasMeasurer(theme.type);
    this.theme = theme;
    this.requestUpdate?.();
  }

  /** Смена класса устройства: бюджеты, шрифты, полоса справа; пул видов шкалы — под новый бюджет. */
  setView(view: ViewPreset): void {
    if (view === this.view) return;
    this.view = view;
    if (view.axis.total + 2 !== this.pool.size) this.pool = new AxisViewPool(view.axis.total + 2);
    this.requestUpdate?.();
  }

  setHovered(objectId: string | null): void {
    if (objectId === this.hovered) return;
    this.hovered = objectId;
    this.requestUpdate?.();
  }

  /** Прямоугольники интерфейса поверх графика (кнопки в углу, чип панелей — C). */
  setUiObstacles(rects: readonly Rect[]): void {
    if (rects === this.ui) return;
    this.ui = rects;
    this.uiRev++;
    this.requestUpdate?.();
  }

  /**
   * Подписи рисунков пользователя — в той же раскладке, что подписи разметки (ADR-0009, «Рисование»): провайдер
   * зовётся в каждом кадре, его кандидаты и ключ входят в кадр; места — externalPlaced().
   */
  setExternalLabels(provider: ExternalLabels | null): void {
    this.external = provider;
    this.requestUpdate?.();
  }

  /** Места подписей рисунков в текущем кадре; null — кадра нет (сцена ещё не пришла). */
  externalPlaced(): readonly PlacedLabel[] | null {
    return this.screen ? (this.screen.labels.external ?? []) : null;
  }

  /** Шрифт загрузился (document.fonts.ready): ширины подписей перемеряются. */
  remeasure(): void {
    this.measure.clear();
    this.uiRev++;
    this.requestUpdate?.();
  }

  /** Ширина текста шрифтом холста темы (отсчёт до закрытия под ценой — плашка не уже текста). */
  textWidth(text: string, font: "sans" | "mono", px: number, weight?: number): number {
    return text ? this.measure.measure(text, font, px, weight).w : 0;
  }

  /** Положение DOM-отсчёта до закрытия (для переписи подписей). */
  setCountdownRect(rect: Rect | null): void {
    this.countdownRect = rect;
  }

  /** Деление шкалы на высоте y попадает под метку — его текст пустой (withHiddenTicks). */
  isTickHidden(y: number | null): boolean {
    return y !== null && Number.isFinite(y) && inBands(y, this.bands);
  }

  updateAllViews(): void {
    const { chart, series, scene } = this;
    if (!chart || !series || !scene) {
      this.screen = null;
      this.pool.set([]);
      return;
    }
    const candles = this.opts.candles();
    const proj = frameProjector(chart, series, candles, this.opts.tfSeconds());
    if (!(proj.width > 0) || !(proj.height > 0)) return;
    const r = proj.visibleLogical();
    const now = this.opts.now?.() ?? Date.now();
    const rangeKey = r ? `${r.from}:${r.to}` : "-";
    if (rangeKey !== this.lastRange) {
      if (this.lastRange !== "") this.lastMove = now;
      this.lastRange = rangeKey;
    }
    const moving = now - this.lastMove < GESTURE_SETTLE_MS;
    const gesture = !!this.opts.coarse && moving;
    if (gesture) this.scheduleSettle();
    const last = candles[candles.length - 1];
    // метка цены LWC — закрытие последней видимой свечи; живая свеча за краем — отсчёта под ней нет
    const shown = proj.visible[proj.visible.length - 1];
    const bar = shown ?? last;
    const drawn = bar ? (this.opts.displayed?.(bar.time) ?? bar) : null;
    const profile = this.profileFor(scene, proj.visible, r, last, moving);
    const external = this.external?.(this.measure) ?? [];
    // свечи, как они нарисованы (Heikin Ashi): видимые — тем же срезом, что proj.visible
    const drawnAll = this.opts.shownCandles?.() ?? null;
    const drawnVisible = drawnAll && drawnAll.length === candles.length ? drawnAll.slice(proj.visibleFrom, proj.visibleFrom + proj.visible.length) : null;
    const opts = {
      view: this.view,
      theme: this.theme,
      measure: this.measure,
      lastPrice: last ? last.close : null,
      plaque: bar && drawn ? { price: drawn.close, up: drawn.close >= drawn.open, live: bar === last } : null,
      hovered: this.hovered,
      overlayY: this.opts.overlayY?.() ?? null,
      ui: this.ui,
      uiRev: this.uiRev,
      gesture,
      ...profile,
      ...(external.length ? { external, externalKey: externalKey(external) } : {}),
      ...(drawnVisible ? { shown: drawnVisible } : {}),
    };
    const key = screenFrameKey(scene, proj, proj.visible, opts);
    if (this.screen && this.screen.frameKey === key) return;
    const screen = projectScene(scene, proj, proj.visible, opts);
    this.layouts++;
    this.screen = screen;
    this.pool.set(screen.axis.placed.map((p) => this.axisSpec(p)));
    this.bands = screen.axis.hiddenBands;
    // масштаб шкалы сменился — LWC сам перестроит деления в этом кадре; иначе — повторно применить формат
    const p1 = opts.lastPrice ?? 1;
    const scaleKey = `${proj.y(p1)}|${proj.y(p1 * 1.01)}|${proj.height}`;
    const bk = bandsKey(this.bands);
    if (bk !== this.appliedBands) {
      const sameScale = scaleKey === this.scaleKey;
      this.appliedBands = bk;
      const layout = screen.axis;
      if (sameScale && this.onAxisChanged) queueMicrotask(() => this.onAxisChanged?.(layout));
      // масштаб сменился вместе с полосами (поле шкалы под карточку рисунка, жест): LWC перестраивает деления в том же
      // кадре, но бывает — по полосам прошлого кадра, и деление остаётся под меткой; когда масштаб успокоится, формат
      // применяется заново — один раз, а не в каждом кадре жеста
      else if (this.onAxisChanged) this.scheduleAxis(layout);
    }
    this.scaleKey = scaleKey;
    this.onFrame?.(screen);
  }

  /**
   * Строки профиля объёма на устоявшийся диапазон (spec §4.2): пересчёт, когда видимый диапазон не менялся
   * GESTURE_SETTLE_MS; во время перетаскивания и щипка — прежние строки, а через 150 мс после жеста — кадр с новыми.
   */
  private profileFor(scene: Scene, visible: readonly Candle[], r: { from: number; to: number } | null, last: Candle | undefined, moving: boolean): { profileRows?: () => readonly VpRow[]; profileKey?: string } {
    const obj = scene.objects.find((o): o is ProfileObject => o.kind === "profile");
    if (!obj) {
      this.vp = null;
      return {};
    }
    const tail = visible[visible.length - 1];
    const want = [scene.version, obj.rows, obj.valueArea, r ? `${r.from.toFixed(2)}:${r.to.toFixed(2)}` : "-", visible.length, tail ? `${tail.time}:${tail.high}:${tail.low}:${tail.volume}` : "-", last?.time ?? "-"].join("|");
    if (!this.vp || (this.vp.key !== want && !moving)) {
      this.vp = { key: want, rows: volumeProfile(visible, obj.rows, obj.valueArea) };
      this.profileComputations++;
    }
    else if (this.vp.key !== want) this.scheduleSettle();
    const rows = this.vp.rows;
    return { profileRows: () => rows, profileKey: this.vp.key };
  }

  private scheduleAxis(layout: AxisLayout): void {
    if (this.axisSettle) clearTimeout(this.axisSettle);
    this.axisSettle = setTimeout(() => {
      this.axisSettle = null;
      this.onAxisChanged?.(layout);
    }, GESTURE_SETTLE_MS + 10);
  }

  private scheduleSettle(): void {
    if (this.settle) clearTimeout(this.settle);
    this.settle = setTimeout(() => {
      this.settle = null;
      this.requestUpdate?.();
    }, GESTURE_SETTLE_MS + 10);
  }

  private axisSpec(p: AxisPlaced): AxisViewSpec {
    const color = toneColor(this.theme, p.tone);
    return p.style === "solid"
      ? { y: p.y, text: p.text, textColor: this.theme.palette.plaque, backColor: color, tick: true }
      : { y: p.y, text: p.text, textColor: color, backColor: this.theme.palette.surface, tick: true };
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  /** Один и тот же массив пула: LWC сохраняет обёртки видов и их координаты (причина M04). */
  priceAxisViews(): readonly ISeriesPrimitiveAxisView[] {
    return this.pool.views;
  }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    const screen = this.screen;
    if (!screen) return null;
    if (this.opts.hitGate && !this.opts.hitGate(x, y)) return null;
    const hit = hitTestScreen(screen, x, y, hitTolerance(this.view, !!this.opts.coarse));
    if (!hit) return null;
    return { externalId: hit.objectId, zOrder: "top", cursorStyle: "pointer", hitTestPriority: hit.priority, distance: hit.distance, itemType: "primitive" };
  }

  /** Автомасштаб цены включает только выбранный объект: дальний уровень из «Найдено» попадает в кадр. */
  autoscaleInfo(): AutoscaleInfo | null {
    const scene = this.scene;
    const id = scene?.selected;
    if (!scene || !id) return null;
    let lo = Infinity;
    let hi = -Infinity;
    const take = (p: number | null | undefined) => {
      if (p == null || !Number.isFinite(p)) return;
      lo = Math.min(lo, p);
      hi = Math.max(hi, p);
    };
    for (const o of scene.objects) {
      if (o.id !== id && o.groupId !== id) continue;
      if (o.kind === "hline") take(o.price);
      else if (o.kind === "box") {
        take(o.top);
        take(o.bottom);
      } else if (o.kind === "glyph") take(o.price);
      else if (o.kind === "polyline") for (const path of o.paths) for (const [, p] of path) take(p);
    }
    return lo <= hi ? { priceRange: { minValue: lo, maxValue: hi } } : null;
  }

  debug(): OverlayDebug {
    const s = this.screen;
    const theme = this.theme;
    const band = s?.obstacles.candles;
    const candles: Rect[] = [];
    if (band) {
      for (let i = 0; i < band.top.length; i++) {
        const top = band.top[i]!;
        const bottom = band.bottom[i]!;
        if (!Number.isFinite(top) || !Number.isFinite(bottom)) continue;
        candles.push({ x: band.x0 + i * band.spacing - band.halfWidth, y: Math.min(top, bottom), w: 2 * band.halfWidth, h: Math.abs(bottom - top) });
      }
    }
    const heatRects: Rect[] = [];
    const objects: OverlayDebug["objects"][number][] = [];
    for (const { obj, geom } of s?.objects ?? []) {
      objects.push({ id: obj.id, layer: obj.layer, kind: obj.kind, tone: obj.tone, color: toneColor(theme, obj.tone), emphasis: obj.emphasis, rect: geomRect(geom) });
      if (geom.kind === "heat") for (const r of geom.rows) if (r.w > 0) heatRects.push({ x: geom.x1 - r.w, y: r.y1, w: r.w, h: r.y2 - r.y1 });
    }
    const lp = s?.obstacles.rects.find((o) => o.kind === "lastPrice")?.rect ?? null;
    return {
      sceneVersion: this.sceneVersion,
      frameKey: s?.frameKey ?? "",
      labels: (s?.labels.placed ?? []).map((p) => ({ ...p, color: labelColor(theme, p) })),
      axis: s?.axis.placed ?? [],
      hiddenBands: s?.axis.hiddenBands ?? [],
      dropped: s?.labels.dropped ?? [],
      candles,
      lastPrice: lp,
      free: s?.viewport.free ?? null,
      gutter: s?.viewport.gutter ?? null,
      budget: this.view.labels,
      minFontPx: theme.type.labelPx,
      heatRects,
      countdown: this.countdownRect,
      objects,
      layouts: this.layouts,
      drawingLabels: s?.labels.external ?? [],
    };
  }
}
