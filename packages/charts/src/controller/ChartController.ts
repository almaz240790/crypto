import type { IChartApi, LogicalRange, MouseEventParams, PriceFormat, Time } from "lightweight-charts";
import { formatCountdown } from "../format";
import type { Layer, LayerContext } from "../layers";
import type { PlacedLabel, Rect } from "../layout/types";
import type { TextMeasurer } from "../layout/measure";
import type { ScreenScene } from "../layout/project";
import { countdownSeconds } from "../live";
import { barsForWidth, DEFAULT_PRESET, deviceFor, INTERACTION, resolvePreset, VIEW, type MarkupSettings, type ResolvedPreset, type ViewPreset } from "../presets";
import { instrumentPriceFormat, priceFormatter, withHiddenTicks, type PriceFormatter } from "../priceFormat";
import { timeToIndex } from "../render/projector";
import { OverlayPrimitive, type ExternalLabels } from "../render/OverlayPrimitive";
import { buildScene, sceneHover, selectionId } from "../scene/build";
import { deriveAnalytics, NONE, type AlertLine, type Analytics, type ExternalObject, type SceneInput, type SceneSelection } from "../scene/input";
import type { SceneText } from "../scene/text";
import type { HoverInfo, LegendEntry, LegendKey, Scene, SceneObject } from "../scene/types";
import type { SceneFigure, ScenePattern, SceneSignal, SceneStructure } from "../scene/wire";
import type { ChartStore, HoverSnapshot } from "../store/chartStore";
import { createTerminal, type Terminal, type TerminalOptions } from "../terminal";
import { contrastText, readChartTheme, seriesColors, tokensFromElement, toneColor, type ChartTheme } from "../theme";
import { TF_SECONDS, type Candle, type ChartType, type Device, type Timeframe } from "../types";
import { AxisCountdown } from "./axisCountdown";
import { composeSnapshot } from "./snapshot";
import { Dirty } from "./stages";

/**
 * Контроллер графика (план 2B.2, architecture §12) — каркас PR B. Владеет Terminal и OverlayPrimitive, темой,
 * классом устройства по ширине контейнера, сценой и раскладкой, форматом шкалы (деления под метками пустые),
 * наведением и кликом, отсчётом до закрытия. React меняет его только через set(patch) и handle, обратно — только
 * ChartStore. Данные, индикаторы, панели и рисунки до PR D остаются в ChartSurface (через terminal и notifyCandles).
 */

/** Что задаёт React. Поля сравниваются по ссылке: неизменные ничего не отмечают. */
export interface ChartInputs {
  tf: Timeframe;
  markup: MarkupSettings;
  authed: boolean;
  structure: SceneStructure | null;
  patterns: readonly ScenePattern[];
  figures: readonly SceneFigure[];
  signals: readonly SceneSignal[];
  alerts: readonly AlertLine[];
  /** «Разбор сверху вниз» (резерв): в B всегда пустой массив-константа. */
  external: readonly ExternalObject[];
  text: SceneText | null;
  uiObstacles: readonly Rect[];
  /** Производные (нужен открытый интерес для карты ликвидаций); null — не загружены. */
  derivatives: { oi: readonly { t: number; v: string | number }[] } | null;
  /** Шаг цены инструмента (переходное поле до ChartPage в D). */
  tick: string | null;
}

export interface FocusTarget {
  objectId?: string;
  time?: number;
}

/** Управление видом для React (кнопки «+/−/⟲», «Найдено»). */
export interface ChartHandle {
  readonly store: ChartStore;
  zoom(factor: number): void;
  /** Последние свечи по ширине области (barsForWidth) — то же, что двойной клик. */
  reset(): void;
  clearCrosshair(): void;
  /** Строка «Найдено» → выбрать объект и показать его время на 70 % ширины, если оно за кадром. */
  focus(target: FocusTarget): void;
  /** Снимок PNG (data URL): кадр графика, сверху caption, снизу footer (слова — из web через t()). */
  snapshot(caption: string, footer: string): string;
}

export interface ChartControllerOptions {
  container: HTMLElement;
  store: ChartStore;
  /** "auto" — по ширине контейнера; мультичарт передаёт "cell". */
  device: Device | "auto";
  type?: ChartType;
  onNeedOlder(before: number): Promise<{ candles: Candle[]; hasOlder: boolean } | null>;
  /** Грубый указатель (палец); по умолчанию — matchMedia("(pointer: coarse)"). */
  coarse?: boolean;
  /** Для тестов: подделка терминала, темы, измерителя и планировщика кадра. */
  createTerminal?(el: HTMLElement, opts: TerminalOptions): Terminal;
  readTheme?(el: HTMLElement, view: ViewPreset, version: number): ChartTheme;
  measure?: TextMeasurer;
  schedule?(fn: () => void): void;
  /** false — без наблюдателей темы, размера, шрифтов и таймера (vitest). */
  observe?: boolean;
}

/** Слой-обёртка: LayerManager терминала сам переподключает примитив при смене типа графика. */
class PrimitiveLayer implements Layer {
  private main: LayerContext["main"] | null = null;
  constructor(
    readonly id: string,
    private readonly primitive: OverlayPrimitive,
  ) {}
  attach(ctx: LayerContext): void {
    this.main = ctx.main;
    ctx.main.attachPrimitive(this.primitive);
  }
  detach(): void {
    this.main?.detachPrimitive(this.primitive);
    this.main = null;
  }
  setVisible(): void {}
}

const NO_UI: readonly Rect[] = [];
const NO_HIDDEN: ReadonlySet<string> = new Set();
/** Высота метки LWC на шкале: fontSize · 17 / 12 (development.mjs). */
const axisLabelHeight = (fontPx: number) => Math.round((fontPx * 17) / 12);
/** Отступы текста отсчёта: 8 px слева (как у метки LWC) и 4 px справа. */
const COUNTDOWN_PAD_PX = 12;

type HoveredParam = MouseEventParams<Time> & { hoveredInfo?: { objectId?: unknown } };

export class ChartController {
  readonly store: ChartStore;
  readonly terminal: Terminal;
  readonly overlay: OverlayPrimitive;
  readonly handle: ChartHandle;
  /** Счётчики для тестов и отладки: сколько раз собиралась сцена и выполнялся кадр стадий. */
  readonly stats = { sceneBuilds: 0, flushes: 0 };

  private readonly el: HTMLElement;
  private readonly opts: ChartControllerOptions;
  private readonly forced: Device | undefined;
  private readonly coarse: boolean;
  private device: Device;
  private view: ViewPreset;
  private theme: ChartTheme;
  private themeVersion = 1;
  private inputs: ChartInputs;
  private dirty = 0;
  private pending = false;
  private destroyed = false;
  private gen = 0;
  /** Сброс вида после новой страницы повторяется в следующем кадре: к нему LWC уже знает ширину шкалы цены. */
  private resetAgain = false;
  private fmt: PriceFormatter;
  private priceFormat: PriceFormat | null = null;
  private analytics: Analytics | undefined;
  private scene: Scene | undefined;
  private resolved: { key: string; value: ResolvedPreset } | null = null;
  private selection: SceneSelection = { selected: null, hidden: NO_HIDDEN };
  private oi: { src: ChartInputs["derivatives"]; points: { t: number; v: number }[] | null } = { src: null, points: null };
  private hitGate: ((x: number, y: number) => boolean) | null = null;
  private readonly countdown: AxisCountdown;
  private lastScreen: ScreenScene | null = null;
  private hoverNext: HoverSnapshot | null = null;
  private hoverQueued = false;
  private pendingFocus: string | null = null;
  /** Подпись последней легенды из кадра: store меняется, только когда изменился состав или цвет «Цены». */
  private legendSig = "";
  /** Вид двигал пользователь после последнего сброса: смена ширины области его не сбрасывает. */
  private userMoved = false;
  /** Правый край (логический), заданный последним сбросом. */
  private resetTo: number | null = null;
  private visibleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly cleanups: (() => void)[] = [];

  constructor(opts: ChartControllerOptions) {
    this.opts = opts;
    this.store = opts.store;
    this.el = opts.container;
    this.coarse = opts.coarse ?? (typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches);
    this.forced = opts.device === "auto" ? undefined : opts.device;
    this.device = deviceFor(this.el.clientWidth, this.coarse, this.forced);
    this.view = VIEW[this.device];
    this.theme = this.readTheme();
    this.inputs = {
      tf: "4h",
      markup: { preset: DEFAULT_PRESET, overrides: {} },
      authed: false,
      structure: null,
      patterns: NONE,
      figures: NONE,
      signals: NONE,
      alerts: NONE,
      external: NONE,
      text: null,
      uiObstacles: NO_UI,
      derivatives: null,
      tick: null,
    };
    this.fmt = priceFormatter(null, this.device !== "desktop");
    const make = opts.createTerminal ?? createTerminal;
    this.terminal = make(this.el, {
      tokens: this.theme.tokens,
      type: opts.type ?? "candles",
      rightOffsetPx: this.view.rightOffsetPx,
      fontSize: this.view.scaleFontPx,
      onNeedOlder: (before) => this.needOlder(before),
      onVisibleRange: (r) => this.visibleChanged(r),
      // левый край истории — поверхности: индикатор загрузки и пометка лимита (план 2A.7)
      onHistoryEdge: (historyEdge) => this.store.patch({ status: { ...this.store.getState().status, historyEdge } }),
    });
    this.overlay = new OverlayPrimitive({
      view: this.view,
      theme: this.theme,
      ...(opts.measure ? { measure: opts.measure } : {}),
      candles: () => this.terminal.candles,
      tfSeconds: () => TF_SECONDS[this.inputs.tf],
      overlayY: () => this.terminal.overlayLastCoordinate(),
      displayed: (time) => this.terminal.displayedBar(time),
      shownCandles: () => this.terminal.displayedCandles,
      hitGate: (x, y) => this.hitGate?.(x, y) ?? true,
      coarse: this.coarse,
    });
    this.overlay.onAxisChanged = () => {
      // полосы меток сменились без смены масштаба: LWC держит деления в кэше, пока формат не применён заново
      if (this.priceFormat && !this.destroyed) this.terminal.setPriceFormat(this.priceFormat);
      if (this.terminal.scale === "percent" && !this.destroyed) this.terminal.setPercentTickFilter((q) => this.percentTickHidden(q));
    };
    this.overlay.onFrame = (screen) => {
      this.lastScreen = screen;
      this.placeCountdown();
      this.updateLegend(screen);
    };
    this.terminal.layers.add(new PrimitiveLayer("overlay", this.overlay));
    this.countdown = new AxisCountdown(this.el);
    this.handle = {
      store: this.store,
      zoom: (f) => {
        this.userMoved = true;
        this.terminal.zoom(f);
      },
      reset: () => this.reset(),
      clearCrosshair: () => this.terminal.chart.clearCrosshairPosition(),
      focus: (t) => this.focus(t),
      snapshot: (caption, footer) => composeSnapshot(this.terminal.chart.takeScreenshot(), caption, footer, { surface: this.theme.palette.surface, text: this.theme.palette.structure, fontMono: this.theme.type.mono }, this.el.ownerDocument),
    };
    this.subscribe();
    const el = this.el as HTMLElement & { __chart?: IChartApi; __overlay?: () => unknown };
    el.__chart = this.terminal.chart;
    el.__overlay = () => this.overlay.debug();
    this.store.patch({ status: { ...this.store.getState().status, ready: true, device: this.device, theme: this.theme.mode, themeVersion: this.themeVersion } });
    this.mark(Dirty.Format | Dirty.Scene);
  }

  private readTheme(): ChartTheme {
    return (this.opts.readTheme ?? readChartTheme)(this.el, this.view, this.themeVersion);
  }

  // ── вход от React ──

  set(patch: Partial<ChartInputs>): void {
    let bits = 0;
    const cur = this.inputs as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(patch)) {
      if (Object.is(cur[k], v)) continue;
      cur[k] = v;
      switch (k as keyof ChartInputs) {
        case "tick":
          bits |= Dirty.Format | Dirty.Scene;
          break;
        case "structure":
        case "derivatives":
          bits |= Dirty.Analytics | Dirty.Scene;
          break;
        case "uiObstacles":
          this.overlay.setUiObstacles(this.inputs.uiObstacles);
          break;
        default:
          bits |= Dirty.Scene;
      }
    }
    if (bits) this.mark(bits);
  }

  /** Мост B/C: эффект данных ChartSurface сообщает, что изменилось в буфере. Удаляется в D. */
  notifyCandles(kind: "replace" | "prepend" | "append" | "tick"): void {
    if (kind === "replace") {
      this.gen++;
      // формат цены инструмента, пришедший вместе со свечами (set({ tick }) до замены), — сразу, а не в кадре стадий:
      // первая отрисовка LWC с новыми свечами идёт раньше этого кадра, и шкала цены размечалась прежним форматом (у
      // BTCUSDT — «105.80» вместо «105.8», на 8 px шире), а кадром позже сужалась — область свечей менялась дважды, и вид
      // перестраивался по каждой ширине: свечи после загрузки и смены таймфрейма сами съезжали на 5–7 px
      if (this.dirty & Dirty.Format) {
        this.dirty &= ~Dirty.Format;
        this.stageFormat();
      }
      // новый инструмент или таймфрейм: аналитика заново (ключ по времени свечи мог совпасть), выбор и наведение сняты
      this.analytics = undefined;
      this.hoverNext = null;
      this.overlay.setHovered(null);
      if (this.store.getState().selection !== null || this.store.getState().hover !== null) this.store.patch({ selection: null, hover: null });
      // история прежнего инструмента или таймфрейма к новому буферу не относится
      const status = this.store.getState().status;
      if (status.historyFrom !== null) this.store.patch({ status: { ...status, historyFrom: null } });
      if (this.terminal.candles.length > 0) {
        this.reset();
        this.resetAgain = true;
      }
      this.mark(Dirty.Analytics | Dirty.Scene);
    } else if (kind === "append") this.mark(Dirty.Analytics | Dirty.Scene);
    // tick: серия уже перерисована series.update; цена и полоса текущей цены — из того же кадра. Отсчёт — цвет свечи.
    this.updateCountdown();
  }

  /** Сменилась тема (data-theme, системная схема): перерисовка из новой палитры, без пересборки сцены. */
  themeChanged(): void {
    this.mark(Dirty.Theme);
  }

  /** Изменился размер контейнера: класс устройства по ширине; при смене — шрифты, отступ справа, бюджеты. */
  resized(): void {
    const d = deviceFor(this.el.clientWidth, this.coarse, this.forced);
    if (d === this.device) return;
    this.device = d;
    this.mark(Dirty.View);
  }

  /** Наведение и клик выключены, пока gate(x, y) = false (инструмент рисования, рисунок под курсором). */
  setHitGate(gate: ((x: number, y: number) => boolean) | null): void {
    this.hitGate = gate;
  }

  /**
   * Подписи рисунков пользователя — в раскладке разметки (ADR-0009, «Рисование»): подписи разметки ниже их приоритета
   * обходят их; места подписей — drawingLabels().
   */
  setDrawingLabels(provider: ExternalLabels | null): void {
    this.overlay.setExternalLabels(provider);
  }

  /** Места подписей рисунков в текущем кадре; null — кадра раскладки ещё нет. */
  drawingLabels(): readonly PlacedLabel[] | null {
    return this.overlay.externalPlaced();
  }

  // ── кадр стадий ──

  private mark(bits: number): void {
    this.dirty |= bits;
    if (this.pending || this.destroyed) return;
    this.pending = true;
    const run = () => this.flush();
    if (this.opts.schedule) this.opts.schedule(run);
    else if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 0);
  }

  /** Стадии в фиксированном порядке: Format → Theme → View → Analytics → Scene. */
  private flush(): void {
    this.pending = false;
    if (this.destroyed) return;
    const d = this.dirty;
    this.dirty = 0;
    this.stats.flushes++;
    if (this.resetAgain) {
      this.resetAgain = false;
      this.reset();
    }
    if (d & Dirty.Format) this.stageFormat();
    if (d & Dirty.Theme) this.stageTheme();
    if (d & Dirty.View) this.stageView();
    if (d & (Dirty.Analytics | Dirty.View)) this.stageAnalytics();
    if (d & (Dirty.Scene | Dirty.Analytics | Dirty.View | Dirty.Format)) this.stageScene();
  }

  private stageFormat(): void {
    const narrow = this.device !== "desktop";
    this.fmt = priceFormatter(this.inputs.tick, narrow);
    // деления под метками шкалы пустые: y деления — через текущую основную серию (она меняется со сменой типа)
    this.priceFormat = withHiddenTicks(instrumentPriceFormat(this.inputs.tick, narrow), (p) => this.overlay.isTickHidden(this.terminal.mainSeries.priceToCoordinate(p) as number | null));
    this.terminal.setPriceFormat(this.priceFormat);
    // процентная шкала подписывает деления своим форматом (localization), не форматом серии — фильтр и туда
    this.terminal.setPercentTickFilter((q) => this.percentTickHidden(q));
  }

  /**
   * Деление процентной шкалы q % — под меткой разметки? В процентном режиме LWC считает от закрытия первой
   * видимой свечи (firstValue: левый край строгого видимого диапазона): цена деления = база · (1 + q / 100).
   */
  private percentTickHidden(q: number): boolean {
    const c = this.terminal.candles;
    const ts = this.terminal.chart.timeScale();
    const r = ts.getVisibleLogicalRange();
    if (!r || c.length === 0) return false;
    const first = (ts.timeToIndex(c[0]!.time as Time, true) as number | null) ?? 0;
    const base = c[Math.min(c.length - 1, Math.max(0, Math.floor(r.from) - first))]!.close;
    return this.overlay.isTickHidden(this.terminal.mainSeries.priceToCoordinate(base * (1 + q / 100)) as number | null);
  }

  private stageTheme(): void {
    this.themeVersion++;
    this.theme = this.readTheme();
    this.terminal.setTheme(this.theme.tokens);
    this.overlay.setTheme(this.theme);
    this.store.patch({ status: { ...this.store.getState().status, theme: this.theme.mode, themeVersion: this.themeVersion } });
    this.placeCountdown(); // цвет отсчёта — из новой палитры
  }

  private stageView(): void {
    this.view = VIEW[this.device];
    this.terminal.setFontSize(this.view.scaleFontPx);
    this.terminal.setRightOffsetPx(this.view.rightOffsetPx);
    this.theme = this.readTheme();
    this.overlay.setTheme(this.theme);
    this.overlay.setView(this.view);
    this.stageFormat();
    this.store.patch({ status: { ...this.store.getState().status, device: this.device } });
    this.updateCountdown();
  }

  private oiPoints(): { t: number; v: number }[] | null {
    const src = this.inputs.derivatives;
    if (src !== this.oi.src) this.oi = { src, points: src ? src.oi.map((x) => ({ t: x.t, v: Number(x.v) })) : null };
    return this.oi.points;
  }

  private stageAnalytics(): void {
    this.analytics = deriveAnalytics(this.terminal.candles, this.oiPoints(), this.inputs.structure, this.analytics);
  }

  private resolvedPreset(): ResolvedPreset {
    const { markup, authed } = this.inputs;
    const key = `${markup.preset}|${JSON.stringify(markup.overrides)}|${this.device}|${authed ? 1 : 0}`;
    if (this.resolved?.key !== key) this.resolved = { key, value: resolvePreset(markup, this.device, { authed }) };
    return this.resolved.value;
  }

  private stageScene(): void {
    const text = this.inputs.text;
    if (!text) return;
    if (!this.analytics) this.stageAnalytics();
    const selected = this.store.getState().selection;
    if (this.selection.selected !== selected) this.selection = { selected, hidden: NO_HIDDEN };
    const i = this.inputs;
    const input: SceneInput = { tf: i.tf, analytics: this.analytics!, structure: i.structure, patterns: i.patterns, figures: i.figures, signals: i.signals, alerts: i.alerts, external: i.external, selection: this.selection, fmt: this.fmt, text };
    const scene = buildScene(input, this.resolvedPreset(), this.scene);
    if (scene === this.scene) return;
    this.stats.sceneBuilds++;
    this.scene = scene;
    this.overlay.setScene(scene);
    // легенда до первого кадра — по всей сцене; кадр оставит только то, что на экране (updateLegend)
    this.legendSig = "";
    this.store.patch({ sceneIndex: scene.index, legend: scene.legend });
    this.refreshHover();
    const pf = this.pendingFocus;
    if (pf !== null) {
      this.pendingFocus = null;
      if (this.store.getState().selection === pf) this.scrollTo(this.objectSpan(pf));
    }
  }

  // ── вид ──

  /** Точка (clientX) — над правой шкалой цены (правее области свечей). */
  private overPriceScale(clientX: number): boolean {
    const w = this.terminal.chart.timeScale().width();
    return w > 0 && clientX - this.el.getBoundingClientRect().left > w;
  }

  private plotWidth(): number {
    return this.terminal.chart.timeScale().width() || this.el.clientWidth;
  }

  private reset(): void {
    this.userMoved = false;
    this.resetTo = this.terminal.resetView(barsForWidth(this.plotWidth(), this.view, this.inputs.tf))?.to ?? null;
  }

  private lastIndex(): number | null {
    const c = this.terminal.candles;
    if (c.length === 0) return null;
    const ts = this.terminal.chart.timeScale();
    return ((ts.timeToIndex(c[c.length - 1]!.time as Time, true) as number | null) ?? c.length - 1) as number;
  }

  private focus(target: FocusTarget): void {
    if (target.objectId !== undefined) {
      this.store.select(target.objectId);
      // объект отрезан лимитом и появится только в пересобранной сцене: его время — после неё
      if (target.time === undefined && !this.sceneHas(target.objectId)) {
        this.pendingFocus = target.objectId;
        return;
      }
    }
    const span = target.time !== undefined ? ([target.time, target.time] as const) : target.objectId !== undefined ? this.objectSpan(target.objectId) : null;
    this.scrollTo(span);
  }

  private sceneHas(id: string): boolean {
    const scene = this.scene;
    return !!scene && (scene.byId.has(id) || scene.objects.some((o) => o.groupId === id));
  }

  /**
   * Объект целиком за кадром — прокрутить, сохранив число баров: ушёл влево — его правый конец на 70 % ширины,
   * вправо — левый. Объект, который хоть частью в кадре (уровень и зона открыты вправо — видны всегда, пока
   * их цена на шкале), вид не двигает: цену в кадр приводит автомасштаб (autoscaleInfo выбранного).
   */
  private scrollTo(span: readonly [from: number, to: number] | null): void {
    if (!span) return;
    const ts = this.terminal.chart.timeScale();
    const r = ts.getVisibleLogicalRange();
    const c = this.terminal.candles;
    if (!r || c.length === 0) return;
    const first = (ts.timeToIndex(c[0]!.time as Time, true) as number | null) ?? 0;
    const step = TF_SECONDS[this.inputs.tf];
    const at = (t: number) => (Number.isFinite(t) ? first + timeToIndex(c, t, step) : t);
    const lo = at(span[0]);
    const hi = at(span[1]);
    if (hi >= r.from && lo <= r.to) return;
    const width = r.to - r.from;
    const target = hi < r.from ? hi : lo;
    const from = target - 0.7 * width;
    ts.setVisibleLogicalRange({ from, to: from + width });
  }

  /** Время объекта от и до (unix с); открытый край — ±∞. Карта ликвидаций и профиль от времени не зависят. */
  private objectSpan(id: string): readonly [number, number] | null {
    const scene = this.scene;
    if (!scene) return null;
    const objs = scene.objects.filter((o) => o.id === id || o.groupId === id);
    const one = scene.byId.get(id);
    if (one && !objs.includes(one)) objs.push(one);
    let lo = Infinity;
    let hi = -Infinity;
    const take = (a: number, b: number) => {
      lo = Math.min(lo, a);
      hi = Math.max(hi, b);
    };
    for (const obj of objs) {
      switch (obj.kind) {
        case "hline":
          take(obj.from ?? -Infinity, obj.to ?? Infinity);
          break;
        case "box":
          take(obj.from, obj.to ?? Infinity);
          break;
        case "glyph":
          take(obj.time, obj.time);
          break;
        case "polyline":
          for (const path of obj.paths) for (const [t] of path) take(t, t);
          break;
        default:
          break;
      }
    }
    return lo <= hi ? [lo, hi] : null;
  }

  // ── история и видимая часть ──

  private needOlder(before: number): void {
    const gen = this.gen;
    this.opts
      .onNeedOlder(before)
      .then((r) => {
        if (this.destroyed || gen !== this.gen) return; // пока грузилось, сменились инструмент или таймфрейм
        if (!r) return this.terminal.olderFailed();
        this.terminal.addOlder(r.candles, r.hasOlder);
        const st = this.store.getState().status;
        this.store.patch({ status: { ...st, historyRev: st.historyRev + 1, historyFrom: this.terminal.candles[0]?.time ?? null } });
      })
      .catch(() => this.terminal.olderFailed());
  }

  private visibleChanged(r: LogicalRange | null): void {
    clearTimeout(this.visibleTimer);
    // счётчик «Найдено» и прочие читатели — после паузы, а не на каждой свече во время перетаскивания
    this.visibleTimer = setTimeout(() => {
      if (this.destroyed) return;
      const ts = this.terminal.chart.timeScale();
      const vr = r ? ts.getVisibleRange() : null;
      const last = this.lastIndex();
      const prev = this.store.getState().visible;
      const next = {
        fromTime: vr ? (vr.from as number) : null,
        toTime: vr ? (vr.to as number) : null,
        atRightEdge: !!r && last !== null && (r.to as number) >= last,
        bars: r ? Math.round((r.to as number) - (r.from as number)) : 0,
      };
      if (prev.fromTime === next.fromTime && prev.toTime === next.toTime && prev.atRightEdge === next.atRightEdge && prev.bars === next.bars) return;
      this.store.patch({ visible: next });
    }, INTERACTION.visibleDebounceMs);
  }

  // ── отсчёт до закрытия ──

  private updateCountdown(): void {
    const last = this.terminal.candles[this.terminal.candles.length - 1];
    const days = this.inputs.text?.["countdown.days"];
    const text = last && this.view.axis.countdown ? formatCountdown(countdownSeconds(this.inputs.tf, last.time, Math.floor(Date.now() / 1000)), days) : "";
    this.countdown.setText(text);
    this.placeCountdown();
  }

  /**
   * Отсчёт под меткой цены: ширина — шкалы цены, а если текст длиннее («6д 23:59» на узкой шкале телефона) —
   * плашка растёт влево; фон — цвет метки цены LWC над ним: нарисованной свечи (в Heikin Ashi — HA-свечи, как у
   * плашки цены), у линии — цвет линии; текст — по правилу LWC для метки цены (contrastText).
   */
  private placeCountdown(): void {
    const screen = this.lastScreen;
    const last = this.terminal.candles[this.terminal.candles.length - 1];
    const y = screen?.countdownY ?? null;
    const px = this.view.scaleFontPx;
    if (!last || y === null || !this.view.axis.countdown) {
      this.countdown.place(null, null, px);
      this.overlay.setCountdownRect(null);
      return;
    }
    const chart = this.terminal.chart;
    const h = axisLabelHeight(px);
    const x = chart.timeScale().width();
    const scaleW = chart.priceScale("right").width();
    const w = Math.max(scaleW, Math.ceil(this.overlay.textWidth(this.countdown.value, "mono", px, 400)) + COUNTDOWN_PAD_PX);
    const rect = { x: x + scaleW - w, y: Math.round(y - h / 2), w, h };
    const drawn = this.terminal.displayedBar(last.time) ?? last;
    const bg = this.terminal.chartType === "line" ? seriesColors(this.theme.tokens).line.color : toneColor(this.theme, drawn.close >= drawn.open ? "up" : "down");
    this.countdown.place(rect, { bg, fg: contrastText(this.theme, bg) }, px);
    this.overlay.setCountdownRect(this.countdown.shown);
  }

  /**
   * Легенда «?» — только то, что есть в кадре (план 2B.2, §9): объект за краем или ниже шкалы её не добавляет,
   * «Макс. объём» — только когда POC нарисован; образец «Цена» — цветом свечи, чью цену показывает метка.
   */
  private updateLegend(screen: ScreenScene): void {
    const scene = this.scene;
    if (!scene) return;
    const keys = new Set<LegendKey>();
    for (const { obj, geom } of screen.objects) {
      const k = scene.legendOf.get(obj.id);
      if (!k || (k === "poc" && (geom.kind !== "profile" || geom.dimmed))) continue;
      keys.add(k);
    }
    const up = screen.plaque?.up ?? true;
    const legend: LegendEntry[] = scene.legend.filter((e) => e.key === "price" || e.key === "selection" || keys.has(e.key)).map((e) => (e.key === "price" ? { ...e, tone: up ? ("up" as const) : ("down" as const) } : e));
    const sig = `${scene.version}|${up ? 1 : 0}|${legend.map((e) => e.key).join(",")}`;
    if (sig === this.legendSig) return;
    this.legendSig = sig;
    this.store.patch({ legend });
  }

  // ── наведение, клик, наблюдатели ──

  /** Подсказка объекта: строки HoverInfo, тон, цена по шагу инструмента, расстояние от живой цены. */
  private hoverOf(objectId: string, point: { x: number; y: number } | undefined, pinned: boolean): HoverSnapshot | null {
    const scene = this.scene;
    const text = this.inputs.text;
    if (!scene || !text) return null;
    const info: HoverInfo | null = sceneHover(scene, objectId);
    const obj = scene.byId.get(objectId);
    if (!info || !obj) return null;
    const live = this.terminal.candles[this.terminal.candles.length - 1]?.close ?? null;
    let distancePct: number | null = null;
    let priceText: string | null = null;
    if (info.price !== undefined) {
      const lo = info.priceTo !== undefined ? Math.min(info.price, info.priceTo) : info.price;
      const hi = info.priceTo !== undefined ? Math.max(info.price, info.priceTo) : info.price;
      priceText = lo === hi ? this.fmt.price(lo) : text.fill(text["hover.range"], { from: this.fmt.price(lo), to: this.fmt.price(hi) });
      if (live) {
        const target = live < lo ? lo : live > hi ? hi : live;
        distancePct = ((target - live) / live) * 100;
      }
    }
    // подпись суммы ликвидаций ведёт к объекту карты: тон у них общий
    const tone = obj.kind === "heat" && obj.id !== objectId ? (obj.tops.find((t) => t.id === objectId)?.label.tone ?? obj.tone) : obj.tone;
    const size = this.terminal.chart.paneSize(0);
    return { objectId, x: point?.x ?? 0, y: point?.y ?? 0, info, tone, priceText, distancePct, plot: { width: size.width, height: size.height }, pinned };
  }

  private hoveredId(p: HoveredParam): string | null {
    const raw = p.hoveredInfo?.objectId ?? p.hoveredObjectId;
    return typeof raw === "string" && this.scene?.byId.has(raw) ? raw : null;
  }

  /** Попадание по тому же кадру, что рисуется (hitTest примитива: допуск 5 / 12 px, рисунки важнее). */
  private hitAt(point: { x: number; y: number } | undefined): string | null {
    if (!point) return null;
    const raw = this.overlay.hitTest(point.x, point.y)?.externalId;
    return typeof raw === "string" && this.scene?.byId.has(raw) ? raw : null;
  }

  /** Наведение мышью — не чаще кадра: последнее положение курсора записывается в store в следующем rAF. */
  private queueHover(next: HoverSnapshot | null): void {
    this.hoverNext = next;
    if (this.hoverQueued || this.destroyed) return;
    this.hoverQueued = true;
    const run = () => {
      this.hoverQueued = false;
      if (this.destroyed) return;
      const cur = this.store.getState().hover;
      if (cur?.pinned) return; // закреплённую подсказку меняет только касание
      this.store.patch({ hover: this.hoverNext });
    };
    if (this.opts.schedule) this.opts.schedule(run);
    else if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 0);
  }

  /** После пересборки сцены подсказка следует за объектом (новые тексты, точность) или пропадает вместе с ним. */
  private refreshHover(): void {
    const cur = this.store.getState().hover;
    if (!cur) return;
    const next = this.hoverOf(cur.objectId, { x: cur.x, y: cur.y }, cur.pinned);
    if (!next) this.overlay.setHovered(null);
    this.store.patch({ hover: next });
  }

  private subscribe(): void {
    const chart = this.terminal.chart;
    const onMove = (p: MouseEventParams<Time>) => {
      // палец: подсказку открывает только тап (закрепляется), движение перекрестия её не трогает
      if (this.coarse) return;
      const id = this.hoveredId(p as HoveredParam);
      this.overlay.setHovered(id);
      if (!id) {
        if (this.store.getState().hover || this.hoverNext) this.queueHover(null);
        return;
      }
      const cur = this.hoverNext ?? this.store.getState().hover;
      if (cur && cur.objectId === id && cur.x === p.point?.x && cur.y === p.point?.y) return;
      this.queueHover(this.hoverOf(id, p.point, false));
    };
    const onClick = (p: MouseEventParams<Time>) => {
      // мышь: LWC только что сделал hitTest для курсора; тап его не делает — попадание считаем сами
      const id = this.coarse ? this.hitAt(p.point) : (this.hoveredId(p as HoveredParam) ?? this.hitAt(p.point));
      const scene = this.scene;
      if (!id || !scene) {
        this.store.patch({ selection: null, ...(this.store.getState().hover?.pinned ? { hover: null } : {}) });
        return;
      }
      const sel = selectionId(scene, id);
      const again = this.store.getState().selection === sel;
      if (!this.coarse) return this.store.select(again ? null : sel);
      // тап по объекту выбирает его и закрепляет карточку; повторный тап — снимает и то и другое
      this.overlay.setHovered(again ? null : id);
      this.store.patch({ selection: again ? null : sel, hover: again ? null : this.hoverOf(id, p.point, true) });
    };
    chart.subscribeCrosshairMove(onMove);
    chart.subscribeClick(onClick);
    this.cleanups.push(() => {
      chart.unsubscribeCrosshairMove(onMove);
      chart.unsubscribeClick(onClick);
    });
    // выбор из React («Найдено», Esc) или кликом — пересборка сцены (выбранный рисуется сверх лимитов);
    // закреплённая подсказка другого объекта снимается вместе с выбором
    let selected = this.store.getState().selection;
    this.cleanups.push(
      this.store.subscribe(() => {
        const st = this.store.getState();
        const s = st.selection;
        if (s === selected) return;
        selected = s;
        const pin = st.hover;
        if (pin?.pinned && this.scene && selectionId(this.scene, pin.objectId) !== s) {
          this.overlay.setHovered(null);
          this.store.patch({ hover: null });
        }
        this.mark(Dirty.Scene);
      }),
    );
    // ширина области свечей сменилась (шкала цены перемерена после загрузки шрифта, окно, боковая панель),
    // а вид после сброса никто не двигал: сброс заново по новой ширине — иначе шаг свечей зависел бы от того,
    // успела ли LWC узнать ширину шкалы к первому сбросу
    const ts = this.terminal.chart.timeScale() as ReturnType<IChartApi["timeScale"]> & Partial<Pick<ReturnType<IChartApi["timeScale"]>, "subscribeSizeChange" | "unsubscribeSizeChange">>;
    let sizeQueued = false;
    const check = () => {
      sizeQueued = false;
      if (this.destroyed || this.userMoved || this.resetTo === null || this.terminal.candles.length === 0) return;
      // правый край тот же (смена ширины его не двигает) — вид не прокручивали и не масштабировали
      const r = ts.getVisibleLogicalRange();
      if (r && Math.abs(r.to - this.resetTo) < 0.05) this.reset();
    };
    // проверка — в следующем кадре: заданный сбросом диапазон LWC применяет при отрисовке, до неё виден старый
    const onSize = () => {
      if (sizeQueued) return;
      sizeQueued = true;
      if (this.opts.schedule) this.opts.schedule(check);
      else if (typeof requestAnimationFrame === "function") requestAnimationFrame(check);
      else check();
    };
    ts.subscribeSizeChange?.(onSize);
    this.cleanups.push(() => ts.unsubscribeSizeChange?.(onSize));
    // двойной клик по шкале цены — автомасштаб этой шкалы (axisDoubleClickReset LWC), вид по времени не сбрасывается
    const onDbl = (e: MouseEvent) => {
      if (this.overPriceScale(e.clientX)) return;
      this.reset();
    };
    // вид двигал пользователь (перетаскивание, колесо, щипок): сброс при смене ширины его не трогает
    const onUser = () => {
      this.userMoved = true;
    };
    this.el.addEventListener("dblclick", onDbl);
    this.el.addEventListener("pointerdown", onUser);
    this.el.addEventListener("wheel", onUser, { passive: true });
    this.cleanups.push(() => {
      this.el.removeEventListener("dblclick", onDbl);
      this.el.removeEventListener("pointerdown", onUser);
      this.el.removeEventListener("wheel", onUser);
    });
    if (this.opts.observe === false || typeof window === "undefined") return;
    // тема: data-theme и системная схема — перерисовка из палитры, без пересборки сцены
    const onTheme = () => this.themeChanged();
    const mo = new MutationObserver(onTheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", onTheme);
    this.cleanups.push(() => {
      mo.disconnect();
      mq.removeEventListener("change", onTheme);
    });
    // класс устройства — по ширине контейнера (боковая панель и мультичарт меняют её независимо от окна)
    const ro = new ResizeObserver(() => this.resized());
    ro.observe(this.el);
    this.cleanups.push(() => ro.disconnect());
    // после загрузки веб-шрифта шкалу и подписи нужно перемерить: иначе ширины посчитаны по запасному шрифту
    void document.fonts?.ready.then(() => {
      if (this.destroyed) return;
      this.terminal.chart.applyOptions({ layout: { fontFamily: tokensFromElement(this.el).fontMono } });
      this.overlay.remeasure();
    });
    // отсчёт до закрытия: раз в секунду, пока вкладка видима
    const timer = setInterval(() => {
      if (!document.hidden) this.updateCountdown();
    }, 1000);
    const onVis = () => {
      if (!document.hidden) this.updateCountdown();
    };
    document.addEventListener("visibilitychange", onVis);
    this.cleanups.push(() => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    });
  }

  /** Сцена (для отладки и тестов). */
  get currentScene(): Scene | undefined {
    return this.scene;
  }

  /** Объект сцены по id. */
  sceneObject(id: string): SceneObject | undefined {
    return this.scene?.byId.get(id);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.visibleTimer);
    for (const c of this.cleanups.splice(0)) c();
    this.countdown.destroy();
    this.terminal.destroy();
  }
}

export function createChartController(opts: ChartControllerOptions): ChartController {
  return new ChartController(opts);
}
