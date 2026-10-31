"use client";

import { COMPACT_FORMAT, PERCENT_FORMAT, VALUE_FORMAT, VIEW_BAR_PX, alignToCandles, bucketStart, createTerminal, formatPriceLabel, formatPriceShort, instrumentPriceFormat, tickPrecision, tokensFromElement, type LiqMap, type SrLevel, type Candle, type ChartType, type ScaleMode, type Terminal, type Timeframe } from "@platform/charts";
import { DrawingController, DrawingsPrimitive, INDICATORS, defaultParams, indicatorById, visibleOn, type Drawing, type DrawingType, type DrawingsState, type IndicatorSpec, type Layer, type LayerContext, type Point, TF_SECONDS } from "@platform/charts";
import { LineSeries, createSeriesMarkers, type ISeriesApi, type ISeriesMarkersPluginApi, type PriceFormat, type SeriesMarker, type Time, type UTCTimestamp } from "lightweight-charts";
import { useCallback, useEffect, useRef, useState } from "react";
import { BoxPrimitive } from "@/components/chart/BoxPrimitive";
import { LevelsPrimitive, type HLine } from "@/components/chart/LevelsPrimitive";
import { VolumeProfilePrimitive, type VpTokens } from "@/components/chart/VolumeProfilePrimitive";
import { STATUS_LABEL } from "@/components/ui/Badge";
import { formatUsdCompact } from "@/lib/format";
import { mergeZones } from "@/lib/zones";
import { PATTERN_LABEL, type Derivatives, type FigureOnChart, type LayersResponse, type PatternOnChart } from "@/lib/chart";
import s from "./terminal.module.css";
import { useT } from "@/i18n/client";

/** Цвет индикатора — токен дизайн-системы (план 5.3): палитра --ind-1…6 и смысловые цвета. */
export type IndColor = "ind1" | "ind2" | "ind3" | "ind4" | "ind5" | "ind6" | "accent" | "up" | "down" | "warn";
export const IND_COLOR_VAR: Record<IndColor, string> = { ind1: "--ind-1", ind2: "--ind-2", ind3: "--ind-3", ind4: "--ind-4", ind5: "--ind-5", ind6: "--ind-6", accent: "--accent", up: "--up", down: "--down", warn: "--warn" };
/**
 * Постоянный цвет каждого индикатора (решение владельца: цвета не настраиваются). Индикаторы на графике цены
 * не повторяют друг друга; у индикаторов на отдельных панелях цвет может совпасть с наложением — они не пересекаются.
 */
export const INDICATOR_COLOR: Record<string, IndColor> = {
  ema: "ind1", sma: "ind2", vwap: "ind3", bb: "ind4", supertrend: "ind5", ichimoku: "ind6", keltner: "warn",
  rsi: "ind1", macd: "ind2", stoch: "ind3", atr: "ind4", volume: "ind5", cci: "ind6", obv: "accent",
};
export const indicatorColor = (id: string): IndColor => INDICATOR_COLOR[id] ?? "accent";
export type ActiveIndicator = { id: string; params: Record<string, number> };
export type LayerKey = "structure" | "zones" | "levels" | "signals" | "patterns" | "figures" | "volume_profile" | "sr" | "liq_map";
export type PanelKey = "funding" | "oi" | "liq" | "ls";
/** price — значение в ценах инструмента (наложенные индикаторы): форматируется по шагу цены. */
export type CrosshairInfo = { candle: Candle; values: { label: string; value: number | null; color: string; price: boolean }[] };
/** Управление видом снаружи (кнопки «+/−», горячие клавиши). */
export type TerminalControls = { zoom: (factor: number) => void; reset: () => void; clearCrosshair: () => void };
const LONG_PRESS_MS = 300;
const VISIBLE_DEBOUNCE_MS = 200;
export const PANELS: { id: PanelKey; title: string }[] = [
  { id: "funding", title: "Funding" },
  { id: "oi", title: "Open interest" },
  { id: "liq", title: "Ликвидации" },
  { id: "ls", title: "L/S ratio" },
];

type Props = {
  candles: Candle[];
  current: Candle | null;
  tf: Timeframe;
  type: ChartType;
  indicators: ActiveIndicator[];
  layersOn: Record<LayerKey, boolean>;
  layers: LayersResponse | null;
  /** Свечные паттерны (план 2A.10.1): маркеры-глифы под/над свечой; ``highlight`` — id выбранного. */
  patterns?: PatternOnChart[];
  highlight?: number | null;
  /** Графические фигуры (план 2A.10.2): линии, «формируется» — пунктиром, цель — точками. */
  figures?: FigureOnChart[];
  highlightFigure?: number | null;
  /** Активные ценовые алерты: линия с подписью (план 2A.6). */
  alertLines?: { id: number; price: number; label: string }[];
  /** Поддержка/сопротивление и карта ликвидаций — считаются в TerminalPage по закрытым свечам. */
  sr?: SrLevel[];
  liq?: LiqMap | null;
  derivatives: Derivatives | null;
  panels: PanelKey[];
  tick: string | null;
  /** Инструмент: при его смене (как и таймфрейма) свечи заменяются и вид сбрасывается; иначе новые свечи дописываются. */
  dataKey?: string;
  onNeedOlder: (before: number) => Promise<{ candles: Candle[]; hasOlder: boolean } | null>;
  /** Перекрестие: свеча под курсором/пальцем и значения индикаторов (план 2A.7). */
  onCrosshair?: (info: CrosshairInfo | null) => void;
  /** Время первой видимой свечи (для счётчика «Найдено» по видимой части). */
  onVisibleFrom?: (t: number | null) => void;
  /** Вызывается с управлением видом после создания графика и с null при размонтировании. */
  onReady?: (controls: TerminalControls | null) => void;
  /** Режим ценовой шкалы и наложенный инструмент (план 2A.3). */
  scale?: ScaleMode;
  overlay?: Candle[] | null;
  drawings?: {
    state: DrawingsState;
    tool: DrawingType | null;
    magnet: boolean;
    draft: Drawing | null;
    onCreate: (d: Drawing) => void;
    onMove: (id: string, points: Point[], final: boolean) => void;
    onSelect: (id: string | null) => void;
    onDraft: (d: Drawing | null) => void;
    onToolDone: () => void;
  };
};

/** Слой-обёртка над примитивом: менеджер слоёв терминала сам переподключает его при смене типа графика. */
class PrimitiveLayer implements Layer {
  private main: LayerContext["main"] | null = null;
  constructor(readonly id: string, private readonly primitive: { attached?: unknown } & object) {}
  attach(ctx: LayerContext): void {
    this.main = ctx.main;
    ctx.main.attachPrimitive(this.primitive as never);
  }
  detach(): void {
    this.main?.detachPrimitive(this.primitive as never);
    this.main = null;
  }
  setVisible(): void {}
}

/** Цвета профиля объёма из токенов: бар 18 % акцента, зона стоимости 30 %, POC — охра. */
function vpTokens(t: ReturnType<typeof tokensFromElement>): VpTokens {
  const alpha = (hex: string, a: number) => {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) return hex;
    const n = parseInt(m[1]!, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`; // color-ok: из токена
  };
  return { bar: alpha(t.accent, 0.18), value: alpha(t.accent, 0.3), poc: alpha(t.warn, 0.7), text: t.text2 };
}

type Pane = { spec: IndicatorSpec; paneIndex: number | null; series: Record<string, ISeriesApi<"Line" | "Histogram">>; colorKey: string; base?: string };
const OVERLAY_SECONDARY_ALPHA = 0.55;
/** Полупрозрачный вариант токена (hex → rgba). */
function fade(hex: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`; // color-ok: из токена
}
/** Заголовок панели под графиком (план 2A.7): панели сворачиваются до 24 px, на телефоне раскрыто не больше трёх. */
type PaneHead = { key: string; title: string; top: number; collapsed: boolean; color?: string };
/** Чистый график по умолчанию: сколько объектов каждого слоя рисуем поверх свечей. */
const ZONES_MAX = 2;
const STRUCTURE_EVENTS_MAX = 4;
const SWEEPS_MAX = 2;
const EQUAL_LEVELS_MAX = 3;
/** Паттерны: только значимые и только на последних N свечах (выбранный в списке — всегда). */
const PATTERN_RECENT_BARS = 60;
/** Уровень с таким числом касаний рисуется сплошной линией. */
const SR_STRONG_TOUCHES = 5;
const SR_LINE_ALPHA = 0.6;
/** Заливка зон без рамки — свечи читаются сквозь неё. */
const ZONE_FILL_ALPHA = 0.1;
/** Размер кодов зон (OB, FVG, SD) — мельче шкалы. */
const TAG_PX = 9;
const NO_LEVELS: SrLevel[] = [];
const CLOSED = ["closed_sl", "closed_be", "closed_tp3", "closed_time", "expired", "cancelled"];
const PANE_COLLAPSED_PX = 24;
const PANE_INDICATOR_PX = 90;
/** Короткие имена в карточке значений: «BB Верхняя» вместо «Bollinger Bands Верхняя». */
const SHORT_TITLE: Record<string, string> = { bb: "BB", keltner: "KC", vwap: "VWAP", stoch: "Stoch", supertrend: "Supertrend", ichimoku: "Ichimoku" };
const PANE_CRYPTO_PX = 80;
/** На телефоне раскрыта одна панель индикатора (последняя добавленная), остальные свёрнуты до заголовка. */
const MAX_EXPANDED_MOBILE = 1;
const MOBILE_QUERY = "(max-width: 899px)";
const MOBILE_SCALE_FONT_PX = 10;
const DESKTOP_SCALE_FONT_PX = 11;
const SWIPE_PX = 24;
/** Целевой шаг бара при сбросе вида: на телефоне свечи уже, но не палочки в 2 px (план 2A.7). */
const viewBarPx = () => (window.matchMedia(MOBILE_QUERY).matches ? VIEW_BAR_PX.phone : VIEW_BAR_PX.desktop);
/** Формат шкалы индикатора на отдельной панели: объём и OBV — компактно, остальное — значения. */
const COMPACT_INDICATORS = new Set(["volume", "obv"]);
const indicatorFormat = (id: string): PriceFormat => (COMPACT_INDICATORS.has(id) ? COMPACT_FORMAT : VALUE_FORMAT);

/** Индекс свечи с временем time в отсортированном массиве (−1 — нет такой). */
function indexOfTime(candles: readonly Candle[], time: number): number {
  let lo = 0;
  let hi = candles.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = candles[mid]!.time;
    if (t === time) return mid;
    if (t < time) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** Обёртка React над Terminal из packages/charts: данные, индикаторы, слои, тема. */
export function TerminalView({ candles, current, tf, type, indicators, layersOn, layers, patterns, highlight, figures, highlightFigure, alertLines, sr, liq, derivatives, panels, tick, dataKey = "", onNeedOlder, drawings, onCrosshair, onVisibleFrom, onReady, scale = "linear", overlay = null }: Props) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const tfRef = useRef(tf);
  const panesRef = useRef<Map<string, Pane>>(new Map());
  const cryptoRef = useRef<Map<PanelKey, { paneIndex: number; series: ISeriesApi<"Line" | "Histogram">[] }>>(new Map());
  const auxRef = useRef<ISeriesApi<"Line">[]>([]);
  const boxRef = useRef<BoxPrimitive | null>(null);
  const levelsRef = useRef<LevelsPrimitive | null>(null);
  const vpRef = useRef<VolumeProfilePrimitive | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const drawPrimRef = useRef<DrawingsPrimitive | null>(null);
  const ctrlRef = useRef<DrawingController | null>(null);
  const drawingsRef = useRef(drawings);
  const needOlderRef = useRef(onNeedOlder);
  const onCrosshairRef = useRef(onCrosshair);
  const onVisibleFromRef = useRef(onVisibleFrom);
  const onReadyRef = useRef(onReady);
  const visibleFromRef = useRef<number | null>(null);
  const valuesRef = useRef<Map<string, { label: string; values: (number | null)[]; color: string; price: boolean }>>(new Map());
  const stickyRef = useRef(false);
  // слои зависят от времени текущей свечи (меняется раз в свечу) и содержимого линий алертов, а не от каждого тика
  const lastT = current?.time ?? null;
  const alertKey = JSON.stringify(alertLines ?? []);
  const srLevels = sr ?? NO_LEVELS;
  const liqMap = liq ?? null;
  const [heads, setHeads] = useState<PaneHead[]>([]);
  const collapsedRef = useRef<Set<string>>(new Set());
  const paneObsRef = useRef<ResizeObserver | null>(null);
  const swipeRef = useRef<{ key: string; y: number } | null>(null);
  /**
   * Одна модель свечей — буфер Terminal (term.candles): подгруженная слева история попадает в индикаторы,
   * перекрестие, проектор рисунков и профиль объёма. historyRev растёт при каждой подгрузке слева.
   */
  const [historyRev, setHistoryRev] = useState(0);
  /** Смена темы: все слои, индикаторы и панели перечитывают токены сразу, а не к закрытию свечи. */
  const [themeRev, setThemeRev] = useState(0);
  /**
   * Узкий экран (телефон, планшет вертикально): шрифт шкал, формат цены и подписи уровней. Следим за
   * matchMedia: при переходе через 900 px (поворот, окно уже) всё переключается сразу и вместе, а не к
   * пересчёту слоёв и не только при смене инструмента.
   */
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches);
  /** Что загружено в график: смена инструмента или таймфрейма — замена и сброс вида, иначе — дописывание. */
  const loadedRef = useRef<{ key: string; tf: Timeframe; candles: Candle[] } | null>(null);
  /** Поколение данных: ответ на запрос истории для прежнего инструмента отбрасывается. */
  const genRef = useRef(0);

  // профиль объёма и проектор рисунков читают ту же модель свечей, что и график
  const syncModel = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    const all = term.candles;
    vpRef.current?.setCandles(all);
    drawPrimRef.current?.projector?.setBars(all.map((c) => c.time), TF_SECONDS[tfRef.current]);
    drawPrimRef.current?.update({});
  }, []);

  // панели под графиком в порядке сверху вниз: индикаторы в отдельных панелях и крипто-панели
  const paneEntries = useCallback(() => {
    const out: { key: string; title: string; series: ISeriesApi<"Line" | "Histogram">[]; height: number; color?: string }[] = [];
    for (const [id, p] of panesRef.current) {
      if (p.paneIndex !== null) out.push({ key: id, title: p.spec.title, series: Object.values(p.series), height: PANE_INDICATOR_PX, color: p.base });
    }
    for (const [k, p] of cryptoRef.current) out.push({ key: k, title: t(PANELS.find((x) => x.id === k)?.title ?? k), series: p.series, height: PANE_CRYPTO_PX });
    return out.filter((e) => e.series.length > 0).sort((a, b) => a.series[0]!.getPane().paneIndex() - b.series[0]!.getPane().paneIndex());
  }, [t]);

  const relayout = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const r0 = el.getBoundingClientRect();
    const next = paneEntries().map((e) => {
      const r = e.series[0]!.getPane().getHTMLElement()?.getBoundingClientRect();
      return { key: e.key, title: e.title, top: r ? Math.round(r.top - r0.top) : 0, collapsed: collapsedRef.current.has(e.key), color: e.color };
    });
    setHeads((prev) => (prev.length === next.length && prev.every((h, i) => h.key === next[i]!.key && h.top === next[i]!.top && h.collapsed === next[i]!.collapsed && h.color === next[i]!.color) ? prev : next));
  }, [paneEntries]);

  // все панели раскладываются разом: свёрнутые — 24 px, раскрытые — своя высота, свечам — остаток (не меньше половины)
  const layoutAll = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    const want = new Map(paneEntries().map((e) => [e.series[0]!.getPane(), collapsedRef.current.has(e.key) ? PANE_COLLAPSED_PX : e.height] as const));
    term.layoutPanes(want);
  }, [paneEntries]);

  const applyCollapsed = useCallback(
    (key: string, collapsed: boolean) => {
      const e = paneEntries().find((x) => x.key === key);
      if (!e) return;
      if (collapsed) collapsedRef.current.add(key);
      else collapsedRef.current.delete(key);
      // в свёрнутой панели прячем и метки последнего значения на шкале (иначе «0.0» и огромные числа OI)
      e.series.forEach((sr) => sr.applyOptions({ visible: !collapsed, lastValueVisible: !collapsed && sr.seriesType() === "Line" }));
      layoutAll();
      requestAnimationFrame(relayout);
    },
    [paneEntries, relayout, layoutAll],
  );

  // новая панель: наблюдаем её размер; на телефоне раскрытых не больше трёх — старшие сворачиваются
  const paneAdded = useCallback(
    (key: string, series: ISeriesApi<"Line" | "Histogram">) => {
      const pel = series.getPane().getHTMLElement();
      if (pel) paneObsRef.current?.observe(pel);
      if (window.matchMedia(MOBILE_QUERY).matches) {
        const open = paneEntries().filter((e) => e.key !== key && !collapsedRef.current.has(e.key));
        for (const e of open.slice(0, Math.max(0, open.length + 1 - MAX_EXPANDED_MOBILE))) applyCollapsed(e.key, true);
      }
      layoutAll();
      requestAnimationFrame(relayout);
    },
    [paneEntries, applyCollapsed, relayout, layoutAll],
  );

  const togglePane = useCallback((key: string) => applyCollapsed(key, !collapsedRef.current.has(key)), [applyCollapsed]);
  useEffect(() => {
    needOlderRef.current = onNeedOlder;
    drawingsRef.current = drawings;
    tfRef.current = tf;
    onCrosshairRef.current = onCrosshair;
    onVisibleFromRef.current = onVisibleFrom;
    onReadyRef.current = onReady;
  }, [onNeedOlder, drawings, tf, onCrosshair, onVisibleFrom, onReady]);

  // создание терминала
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let visibleTimer: ReturnType<typeof setTimeout> | undefined;
    const term = createTerminal(el, {
      tokens: tokensFromElement(el),
      type,
      onNeedOlder: (before) => {
        const gen = genRef.current;
        needOlderRef
          .current(before)
          .then((r) => {
            if (gen !== genRef.current) return; // пока грузилось, сменились инструмент или таймфрейм
            if (!r) return term.olderFailed();
            term.addOlder(r.candles, r.hasOlder);
            syncModel();
            setHistoryRev((h) => h + 1);
          })
          .catch(() => term.olderFailed());
      },
      onVisibleRange: (r) => {
        // время первой видимой свечи — прямо со шкалы, а не по индексу в отдельном массиве
        const vr = r ? termRef.current?.chart.timeScale().getVisibleRange() : null;
        const t = vr ? (vr.from as number) : null;
        if (t === visibleFromRef.current) return;
        visibleFromRef.current = t;
        // счётчик «Найдено» обновляем после паузы, а не на каждой свече во время перетаскивания
        clearTimeout(visibleTimer);
        visibleTimer = setTimeout(() => onVisibleFromRef.current?.(visibleFromRef.current), VISIBLE_DEBOUNCE_MS);
      },
    });
    // LWC с vertTouchDrag=false отдаёт браузеру любой жест круче ~27° — и график «не реагирует»
    term.chart.applyOptions({ handleScroll: { vertTouchDrag: true } });
    // после загрузки веб-шрифта шкалу нужно перемерить: иначе ширина подписей посчитана по запасному шрифту
    void document.fonts?.ready.then(() => termRef.current?.chart.applyOptions({ layout: { fontFamily: tokensFromElement(el).fontMono } }));
    termRef.current = term;
    // новый график пуст: следующие данные — замена, а не дописывание (и после повторного монтирования в StrictMode)
    loadedRef.current = null;
    onReadyRef.current?.({
      zoom: (f) => term.zoom(f),
      reset: () => term.resetView(viewBarPx()),
      clearCrosshair: () => {
        stickyRef.current = false;
        delete el.dataset.sticky;
        term.chart.clearCrosshairPosition();
        onCrosshairRef.current?.(null);
      },
    });
    (el as HTMLElement & { __chart?: unknown }).__chart = term.chart;
    const box = new BoxPrimitive();
    boxRef.current = box;
    term.layers.add(new PrimitiveLayer("zones", box));
    const tk0 = tokensFromElement(el);
    const levels = new LevelsPrimitive({ font: tk0.fontMono });
    levelsRef.current = levels;
    term.layers.add(new PrimitiveLayer("hlines", levels));
    const vp = new VolumeProfilePrimitive(vpTokens(tokensFromElement(el)));
    vpRef.current = vp;
    term.layers.add(new PrimitiveLayer("volume_profile", vp));
    const prim = new DrawingsPrimitive(tokensFromElement(el));
    prim.touch = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
    drawPrimRef.current = prim;
    term.layers.add(new PrimitiveLayer("drawings", prim));
    const ctrl = new DrawingController(
      el,
      prim.projector!,
      {
        getDrawings: () => {
          const d = drawingsRef.current;
          return d ? visibleOn(d.state, tfRef.current) : [];
        },
        getCandles: () => term.candles,
        tfSeconds: TF_SECONDS[tfRef.current],
        timeframe: null,
        touch: prim.touch,
        magnet: true,
        newId: () => `d_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      },
      {
        onCreate: (d) => drawingsRef.current?.onCreate(d),
        onMove: (id, pts, final) => drawingsRef.current?.onMove(id, pts, final),
        onSelect: (id) => drawingsRef.current?.onSelect(id),
        onDraft: (d) => drawingsRef.current?.onDraft(d),
        onDone: () => drawingsRef.current?.onToolDone(),
      },
    );
    ctrlRef.current = ctrl;
    // тема: фон, свечи, рисунки и профиль — сразу; слои, индикаторы и панели — через themeRev
    const onTheme = () => {
      const tk = tokensFromElement(el);
      term.setTheme(tk);
      prim.update({ tokens: tk });
      vp.setTokens(vpTokens(tk));
      setThemeRev((v) => v + 1);
    };
    const obs = new MutationObserver(onTheme);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", onTheme);
    const onDbl = () => term.resetView(viewBarPx());
    el.addEventListener("dblclick", onDbl);
    // перекрестие → свеча и значения индикаторов; на телефоне long-press (300 мс) включает «липкий» режим
    const emit = (time: number | null) => {
      if (time === null) {
        if (!stickyRef.current) onCrosshairRef.current?.(null);
        return;
      }
      const all = term.candles;
      const i = indexOfTime(all, time);
      if (i < 0) return;
      const values = [...valuesRef.current.values()].map((v) => ({ label: v.label, value: v.values[i] ?? null, color: v.color, price: v.price }));
      onCrosshairRef.current?.({ candle: all[i]!, values });
    };
    term.chart.subscribeCrosshairMove((p) => emit(typeof p.time === "number" ? p.time : null));
    let pressTimer: ReturnType<typeof setTimeout> | undefined;
    let pressStart: { x: number; y: number } | null = null;
    const onPDown = (e: PointerEvent) => {
      if (e.pointerType !== "touch" || drawingsRef.current?.tool) return;
      pressStart = { x: e.clientX, y: e.clientY };
      pressTimer = setTimeout(() => {
        stickyRef.current = true;
        el.dataset.sticky = "1";
        el.dataset.stickyArmed = "1"; // первое отпускание после long-press режим не выключает
        if (navigator.vibrate) navigator.vibrate(10);
      }, LONG_PRESS_MS);
    };
    const onPMove = (e: PointerEvent) => {
      if (pressStart && !stickyRef.current && Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 8) {
        clearTimeout(pressTimer);
        pressStart = null;
      }
    };
    const onPUp = (e: PointerEvent) => {
      clearTimeout(pressTimer);
      const wasTap = pressStart !== null && Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) < 8;
      pressStart = null;
      if (stickyRef.current) {
        if (wasTap && !el.dataset.stickyArmed) {
          // короткий тап в липком режиме — выход
          stickyRef.current = false;
          delete el.dataset.sticky;
          onCrosshairRef.current?.(null);
        }
        delete el.dataset.stickyArmed;
      }
    };
    el.addEventListener("pointerdown", onPDown);
    el.addEventListener("pointermove", onPMove);
    el.addEventListener("pointerup", onPUp);
    el.addEventListener("pointercancel", onPUp);
    const paneObs = new ResizeObserver(() => relayout());
    paneObs.observe(el);
    paneObsRef.current = paneObs;
    const panes = panesRef.current;
    return () => {
      paneObs.disconnect();
      paneObsRef.current = null;
      obs.disconnect();
      mq.removeEventListener("change", onTheme);
      el.removeEventListener("dblclick", onDbl);
      el.removeEventListener("pointerdown", onPDown);
      el.removeEventListener("pointermove", onPMove);
      el.removeEventListener("pointerup", onPUp);
      el.removeEventListener("pointercancel", onPUp);
      clearTimeout(pressTimer);
      clearTimeout(visibleTimer);
      panes.clear();
      auxRef.current = [];
      boxRef.current = null;
      levelsRef.current = null;
      vpRef.current = null;
      markersRef.current = null;
      ctrl.destroy();
      ctrlRef.current = null;
      drawPrimRef.current = null;
      term.destroy();
      termRef.current = null;
      onReadyRef.current?.(null);
    };
    // тип меняется через setType ниже, не пересоздаём
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // данные: смена инструмента или таймфрейма — замена свечей и сброс вида; закрытие свечи — дописывание,
  // масштаб, прокрутка и подгруженная слева история пользователя сохраняются (план 2A.7)
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const prev = loadedRef.current;
    const same = prev !== null && prev.key === dataKey && prev.tf === tf;
    if (same && prev.candles.length === 0 && candles.length === 0) return;
    const n = prev?.candles.length ?? 0;
    const append = same && n > 0 && candles.length >= n && candles[0]?.time === prev.candles[0]?.time && candles[n - 1]?.time === prev.candles[n - 1]?.time;
    loadedRef.current = { key: dataKey, tf, candles };
    if (append) {
      // закрывшиеся свечи заменяют текущую с тем же временем; новая текущая придёт через term.update(current)
      for (const c of candles.slice(n)) term.update(c);
    } else {
      genRef.current++;
      const all = current ? [...candles, current] : candles;
      term.setCandles(all, true);
      if (all.length > 0) term.resetView(viewBarPx());
    }
    syncModel();
    // текущая свеча обновляется своим эффектом ниже; здесь она нужна только при замене
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, tf, dataKey, syncModel]);

  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // формат цены инструмента: точность и минимальный шаг из шага цены — основной серии, наложенным линиям и
  // подписям рисунков; на телефоне крупные цены без дробной части и шрифт мельче — шкала занимает меньше места.
  // Шрифт хранит Terminal: смена темы его не сбрасывает
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.setFontSize(narrow ? MOBILE_SCALE_FONT_PX : DESKTOP_SCALE_FONT_PX);
    term.setPriceFormat(instrumentPriceFormat(tick, narrow));
    drawPrimRef.current?.update({ precision: tickPrecision(tick) });
  }, [tick, narrow]);

  useEffect(() => {
    const term = termRef.current;
    if (!term || !current) return;
    term.update(current);
    syncModel();
  }, [current, syncModel]);

  // рисунки: синхронизируем примитив и контроллер с внешним состоянием
  useEffect(() => {
    const prim = drawPrimRef.current;
    const ctrl = ctrlRef.current;
    if (!prim || !ctrl) return;
    prim.update({ drawings: drawings ? visibleOn(drawings.state, tf) : [], draft: drawings?.draft ?? null, selectedId: drawings?.state.selectedId ?? null });
    if (ctrl.tool !== (drawings?.tool ?? null)) ctrl.setTool(drawings?.tool ?? null);
    ctrl.setMagnet(drawings?.magnet ?? true);
  }, [drawings, tf]);

  useEffect(() => {
    termRef.current?.setScaleMode(scale);
  }, [scale]);

  // наложенный инструмент: цвет — токен --warn, перечитывается и при смене темы (themeRev)
  useEffect(() => {
    const term = termRef.current;
    if (!term || !ref.current) return;
    term.setOverlay(overlay, tokensFromElement(ref.current).warn);
  }, [overlay, themeRev]);

  useEffect(() => {
    termRef.current?.setType(type);
    // маркеры привязаны к старой серии — пересоздать при следующем расчёте слоёв; проектор рисунков — новый
    markersRef.current = null;
    syncModel();
  }, [type, syncModel]);

  // индикаторы: по активному списку создаём панели/серии, считаем на всех свечах буфера (и подгруженных слева)
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const tokens = tokensFromElement(ref.current!);
    const color = (k: string) => (({ accent: tokens.accent, up: tokens.up, down: tokens.down, warn: tokens.warn, text2: tokens.text2, text3: tokens.text3 }) as Record<string, string>)[k] ?? tokens.accent;
    const indColor = (c: IndColor) => (c.startsWith("ind") ? (tokens.ind[Number(c.slice(3)) - 1] ?? tokens.accent) : color(c));
    // первая линия — цвет индикатора; остальные линии наложения — тот же цвет бледнее, у панелей — свои смысловые
    const seriesColor = (spec: IndicatorSpec, i: number, base: string) => {
      if (i === 0) return base;
      if (spec.pane === "overlay") return fade(base, OVERLAY_SECONDARY_ALPHA);
      // на панели вторая линия нейтральная, чтобы не сливаться с цветом индикатора; гистограмма — свои цвета
      return spec.series[i]!.kind === "histogram" ? color(spec.series[i]!.color) : tokens.text2;
    };
    const want = new Map(indicators.map((i) => [i.id, i]));
    for (const [id, pane] of panesRef.current) {
      if (!want.has(id)) {
        Object.values(pane.series).forEach((sr) => term.removeSeries(sr));
        panesRef.current.delete(id);
        collapsedRef.current.delete(id);
        for (const k of [...valuesRef.current.keys()]) if (k.startsWith(`${id}.`)) valuesRef.current.delete(k);
      }
    }
    const all = term.candles;
    for (const ind of indicators) {
      const spec = indicatorById(ind.id);
      if (!spec) continue;
      let pane = panesRef.current.get(ind.id);
      if (!pane) {
        const paneIndex = spec.pane === "separate" ? term.addPane(PANE_INDICATOR_PX) : null;
        const series: Pane["series"] = {};
        for (const sp of spec.series) {
          // наложенные линии — в ценах инструмента (формат шкалы цены), на отдельной панели — свой формат
          const fmt = paneIndex === null ? undefined : indicatorFormat(spec.id);
          series[sp.key] = sp.kind === "histogram" ? term.addHistogram(paneIndex ?? 0, color(sp.color), fmt) : term.addLine(paneIndex ?? 0, color(sp.color), sp.width ?? 1, fmt);
          // у линий на графике цены метки на шкале не нужны: их значения есть в карточке, а шкала остаётся читаемой
          if (spec.pane === "overlay") series[sp.key]!.applyOptions({ lastValueVisible: false });
        }
        pane = { spec, paneIndex, series, colorKey: "" };
        panesRef.current.set(ind.id, pane);
        const first = Object.values(series)[0];
        if (paneIndex !== null && first) paneAdded(ind.id, first);
      }
      const ck = indicatorColor(ind.id);
      const base = indColor(ck);
      // цвет перечитывается и при смене темы: у светлой и тёмной темы свои оттенки --ind-*
      const colorKey = `${ck}|${themeRev}`;
      if (pane.colorKey !== colorKey) {
        spec.series.forEach((sp, i) => pane!.series[sp.key]?.applyOptions({ color: seriesColor(spec, i, base) }));
        pane.colorKey = colorKey;
        pane.base = base;
      }
      const out = spec.compute(all, { ...defaultParams(spec), ...ind.params });
      const short = SHORT_TITLE[spec.id] ?? spec.title;
      spec.series.forEach((sp, i) => valuesRef.current.set(`${ind.id}.${sp.key}`, { label: spec.series.length === 1 || sp.label === spec.title || sp.label === short ? short : `${short} ${sp.label}`, values: out[sp.key] ?? [], color: seriesColor(spec, i, base), price: spec.pane === "overlay" }));
      for (const sp of spec.series) {
        const values = out[sp.key] ?? [];
        const data = all.map((c, i) => ({ time: c.time as UTCTimestamp, value: values[i] })).filter((d) => d.value != null) as { time: UTCTimestamp; value: number }[];
        pane.series[sp.key]!.setData(data as never);
      }
    }
    requestAnimationFrame(relayout);
  }, [indicators, candles, current, historyRev, themeRev, paneAdded, relayout]);

  // крипто-панели (план 2A.4): funding, OI, ликвидации — данные с сервера. Ставятся только после свечей и
  // только на время свечей (alignToCandles): точка левее первой свечи или между свечами меняла шкалу времени,
  // и с панелью OI график открывался на 84 дня в прошлом
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const tokens = tokensFromElement(ref.current!);
    const want = new Set(panels);
    for (const [k, p] of cryptoRef.current) {
      if (!want.has(k)) {
        p.series.forEach((sr) => term.removeSeries(sr));
        cryptoRef.current.delete(k);
        collapsedRef.current.delete(k);
      }
    }
    const model = term.candles;
    if (!derivatives || model.length === 0) return;
    const times = model.map((c) => c.time);
    const lastEnd = times[times.length - 1]! + TF_SECONDS[tf];
    const asLine = (rows: { t: number; v: string }[], k = 1) => alignToCandles(rows, times, lastEnd).map(({ time, row }) => ({ time: time as UTCTimestamp, value: Number(row.v) * k }));
    const liqRows = alignToCandles(derivatives.liquidations, times, lastEnd, (a, b) => ({ t: b.t, long: String(Number(a.long) + Number(b.long)), short: String(Number(a.short) + Number(b.short)) }));
    // цвета — заново при каждой смене темы; формат шкалы — свой у каждой панели (проценты, компактно)
    const colors: Record<PanelKey, string[]> = { funding: [tokens.warn], oi: [tokens.accent], ls: [tokens.accent, tokens.warn], liq: [tokens.up, tokens.down] };
    for (const k of panels) {
      let p = cryptoRef.current.get(k);
      if (!p) {
        const paneIndex = term.addPane(PANE_CRYPTO_PX);
        const series: ISeriesApi<"Line" | "Histogram">[] = [];
        if (k === "funding") series.push(term.addLine(paneIndex, tokens.warn, 1, PERCENT_FORMAT));
        else if (k === "oi") series.push(term.addLine(paneIndex, tokens.accent, 1, COMPACT_FORMAT));
        else if (k === "ls") series.push(term.addLine(paneIndex, tokens.accent, 1, VALUE_FORMAT), term.addLine(paneIndex, tokens.warn, 1, VALUE_FORMAT));
        else series.push(term.addHistogram(paneIndex, tokens.up, COMPACT_FORMAT), term.addHistogram(paneIndex, tokens.down, COMPACT_FORMAT));
        p = { paneIndex, series };
        cryptoRef.current.set(k, p);
        paneAdded(k, series[0]!);
      }
      p.series.forEach((sr, i) => sr.applyOptions({ color: colors[k][i] }));
      if (k === "funding") p.series[0]!.setData(asLine(derivatives.funding, 100) as never);
      else if (k === "oi") p.series[0]!.setData(asLine(derivatives.oi) as never);
      else if (k === "ls") {
        p.series[0]!.setData(asLine(derivatives.ls_ratio ?? []) as never);
        p.series[1]!.setData(asLine(derivatives.ls_top ?? []) as never);
      } else {
        p.series[0]!.setData(liqRows.map(({ time, row }) => ({ time: time as UTCTimestamp, value: Number(row.long), color: tokens.up })) as never);
        p.series[1]!.setData(liqRows.map(({ time, row }) => ({ time: time as UTCTimestamp, value: -Number(row.short), color: tokens.down })) as never);
      }
    }
    requestAnimationFrame(relayout);
  }, [derivatives, panels, candles, historyRev, themeRev, tf, paneAdded, relayout]);

  // слои: зоны (прямоугольники), структура (отрезки BOS/CHoCH, свинги), уровни, сигналы. Токены читаются при
  // каждом пересчёте, в том числе сразу после смены темы (themeRev): тёмная палитра на белом не остаётся
  useEffect(() => {
    const term = termRef.current;
    // та же модель свечей, что у графика: с подгруженной слева историей отрезки не обрезаются по первой порции
    const model = term?.candles ?? [];
    if (!term || model.length === 0) return;
    const el = ref.current!;
    const tokens = tokensFromElement(el);
    const alpha = (hex: string, a: number) => {
      const m = /^#([0-9a-f]{6})$/i.exec(hex);
      if (!m) return hex;
      const n = parseInt(m[1]!, 16);
      return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`; // color-ok: из токена
    };
    const main = term.mainSeries;
    vpRef.current?.setEnabled(!!layersOn.volume_profile);
    auxRef.current.forEach((sr) => term.chart.removeSeries(sr));
    auxRef.current = [];
    if (!boxRef.current) return;
    const first = model[0]!.time;
    const last = lastT ?? model[model.length - 1]!.time;
    const step = TF_SECONDS[tf];
    // начало свечи tf (неделя — с понедельника, как у Binance; от эпохи вышел бы четверг)
    const snap = (t: number) => bucketStart(tf, t);
    // все горизонтальные линии — в одном canvas-слое: на графике тонкая линия и короткий код (R, S, SL, TP1…),
    // цена — меткой на шкале; длинных надписей поверх свечей нет
    const hlines: HLine[] = [];
    const precision = tickPrecision(tick);
    // тот же признак узкой шкалы, что у формата основной серии: подписи уровней и цена на шкале — в одном формате
    const fp = (p: number) => (narrow ? formatPriceShort(p, precision) : formatPriceLabel(p, precision));
    // axis — цвет метки на шкале (сплошной токен) или false, если метка не нужна
    const seg = (from: number, to: number | null, price: number, c: string, style: 0 | 1 | 2 | 3, width: 1 | 2 = 1, tag?: string, priority = 0, axis: string | false = false) => {
      const a = Math.max(snap(from), first);
      if (a > last) return;
      const b = to === null ? null : Math.min(Math.max(snap(to), a + step), last);
      hlines.push({ from: a as Time, to: b === null ? null : (b as Time), price, color: c, style, width, tag, priority, axis: axis ? { text: fp(price), textColor: tokens.surface, backColor: axis } : undefined });
    };
    const st = layers?.structure;
    const boxes = [];
    const markers: SeriesMarker<Time>[] = [];
    if (st && layersOn.zones) {
      // только активные зоны, пересекающиеся склеены; заливка без рамки, как FVG в терминалах; спрос — зелёный, предложение — красный
      const price = (candles[candles.length - 1] ?? model[model.length - 1]!).close;
      for (const g of mergeZones(st.zones, price).slice(0, ZONES_MAX)) {
        const c = g.dir === "up" ? tokens.up : g.dir === "down" ? tokens.down : tokens.accent;
        boxes.push({ id: `z-${g.fromT}-${g.bottom}`, from: Math.max(snap(g.fromT), first) as Time, to: null, top: g.top, bottom: g.bottom, fill: alpha(c, ZONE_FILL_ALPHA), stroke: "transparent", label: g.codes.join("+"), labelColor: alpha(c, 0.8), labelSize: TAG_PX });
      }
    }
    if (st && layersOn.structure) {
      for (const e of st.events.slice(-STRUCTURE_EVENTS_MAX)) seg(e.from_t, e.t, Number(e.level), e.type === "bos" ? tokens.accent : tokens.warn, 1, 1, e.type === "bos" ? "BOS" : "CHoCH", 2);
      // свинги маркерами не рисуем: на телефоне LWC делает их крупными кружками и они перекрывают свечи
      for (const sw of st.sweeps.slice(-SWEEPS_MAX)) {
        const at = snap(sw.t);
        if (at < first) continue;
        markers.push({ time: at as Time, position: sw.kind === "low" ? "belowBar" : "aboveBar", shape: "square", color: tokens.warn, text: "sweep", size: 0 });
      }
      for (const e of st.equal_levels.filter((x) => !x.swept).slice(-EQUAL_LEVELS_MAX)) seg(e.from_t, e.to_t, Number(e.p), tokens.text3, 2, 1, e.kind === "low" ? "EQL" : "EQH", 1);
    }
    if (st && layersOn.levels) {
      for (const k of ["pdh", "pdl", "pwh", "pwl"]) {
        const v = st.levels[k];
        if (v) seg(first, null, Number(v), tokens.text3, 3, 1, k.toUpperCase(), 1);
      }
    }
    if (layers && layersOn.signals) {
      for (const sg of layers.signals.slice(0, 20)) {
        const at = snap(sg.t - 1);
        if (at < first) continue;
        const open = !CLOSED.includes(sg.status);
        const label = STATUS_LABEL[sg.status]?.text;
        markers.push({ time: at as Time, position: sg.dir === "long" ? "belowBar" : "aboveBar", shape: sg.dir === "long" ? "arrowUp" : "arrowDown", color: open ? tokens.accent : tokens.text3, text: `${sg.dir === "long" ? "L" : "S"} ${sg.grade}${open || !label ? "" : " · " + t(label)}`, size: 1 });
        if (open && sg.entry) seg(at, null, Number(sg.entry), tokens.accent, 0, 1, "Entry", 6, tokens.accent);
        if (open && sg.sl) seg(at, null, Number(sg.sl), tokens.down, 1, 1, "SL", 6, tokens.down);
        if (open) sg.tp.forEach((tp, i) => tp && seg(at, null, Number(tp), tokens.up, 1, 1, `TP${i + 1}`, 5, tokens.up));
      }
    }
    if (patterns && layersOn.patterns) {
      // только значимые паттерны на последних свечах; выбранный в списке «Найдено» — всегда
      const recentFrom = last - PATTERN_RECENT_BARS * step;
      for (const p of patterns) {
        const hl = p.id === highlight;
        if (!hl && (!p.significant || p.t < recentFrom)) continue;
        const pt = snap(p.t);
        if (pt < first) continue;
        markers.push({
          time: pt as Time,
          position: p.direction === "up" ? "belowBar" : "aboveBar",
          shape: hl ? "circle" : p.direction === "up" ? "arrowUp" : p.direction === "down" ? "arrowDown" : "square",
          color: hl ? tokens.warn : tokens.accent,
          text: t(PATTERN_LABEL[p.type] ?? p.title),
          size: hl ? 1 : 0,
        });
      }
    }
    if (figures && layersOn.figures) {
      // одна последняя подтверждённая фигура и выбранная в списке; отменённые не рисуем
      const latest = figures.filter((f) => f.status === "confirmed").sort((a, b) => (a.confirm_t ?? a.known_t) - (b.confirm_t ?? b.known_t)).at(-1);
      const shown = figures.filter((f) => f.id === highlightFigure || f === latest);
      for (const f of shown) {
        const hl = f.id === highlightFigure;
        const color = f.status === "confirmed" ? (hl ? tokens.warn : tokens.accent) : f.status === "forming" ? (hl ? tokens.warn : tokens.text2) : alpha(tokens.text3, 0.5);
        const style = f.status === "forming" ? 2 : 0;
        for (const ln of f.lines) {
          const a = snap(ln.a[0]);
          const b = Math.max(snap(ln.b[0]), a + step);
          // только в пределах свечей: точка правее последней свечи добавляла на шкалу времени пустое деление,
          // и каждое пересоздание линии (новая свеча, подгрузка истории) сдвигало вид пользователя на бар
          const t0 = Math.max(a, first);
          const t1 = Math.min(b, last);
          if (t1 <= t0) continue;
          const at = (x: number) => Number(ln.a[1]) + ((Number(ln.b[1]) - Number(ln.a[1])) * (x - a)) / Math.max(1, b - a);
          const ls = term.chart.addSeries(LineSeries, { color, lineWidth: hl ? 2 : 1, lineStyle: style, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
          ls.setData([{ time: t0 as UTCTimestamp, value: at(t0) }, { time: t1 as UTCTimestamp, value: at(t1) }]);
          auxRef.current.push(ls);
        }
        if (f.status === "confirmed" && f.target && f.confirm_t) seg(f.confirm_t, null, Number(f.target), tokens.up, 1, 1, "TGT", 2);
        if (f.status === "confirmed" && f.invalidation && f.confirm_t) seg(f.confirm_t, null, Number(f.invalidation), tokens.down, 1, 1, "INV", 2);
        if (hl)
          for (const [pt0] of f.points) {
            const pt = snap(pt0);
            if (pt >= first) markers.push({ time: pt as Time, position: "inBar", shape: "circle", color, text: "", size: 0 });
          }
      }
    }
    for (const al of JSON.parse(alertKey) as NonNullable<Props["alertLines"]>) {
      seg(first, null, al.price, tokens.warn, 3, 1, `ALERT ${al.label}`, 4, tokens.warn);
    }
    if (layersOn.sr)
      for (const l of srLevels) {
        const sup = l.side === "support";
        seg(l.firstT, null, l.price, alpha(sup ? tokens.up : tokens.down, SR_LINE_ALPHA), l.touches >= SR_STRONG_TOUCHES ? 0 : 2, 1, sup ? "S" : "R", 3, sup ? tokens.up : tokens.down);
      }
    let heat = null;
    if (layersOn.liq_map && liqMap) {
      const m = liqMap;
      // сумма — мелко у крупнейших полос; отдельных линий и подписей поверх свечей нет
      const top = new Map([...m.topLongs.map((b) => [b, b.long] as const), ...m.topShorts.map((b) => [b, b.short] as const)]);
      heat = { step: m.step, textColor: tokens.warn, bars: m.buckets.map((b) => ({ price: b.price, weight: (b.long + b.short) / m.max, text: top.has(b) ? formatUsdCompact(top.get(b)!) : undefined })), fill: (w: number) => alpha(tokens.warn, 0.08 + 0.42 * w) };
    }
    levelsRef.current?.set(hlines, heat, { font: tokens.fontMono });
    boxRef.current.setBoxes(boxes);
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    if (!markersRef.current) markersRef.current = createSeriesMarkers(main, markers);
    else markersRef.current.setMarkers(markers);
  }, [layers, layersOn, candles, lastT, tf, type, patterns, highlight, figures, highlightFigure, alertKey, t, tick, narrow, srLevels, liqMap, historyRev, themeRev]);

  return (
    <div className={s.chart}>
      <div ref={ref} className={s.canvas} data-testid="terminal" />
      {heads.map((h) => (
        <div
          key={h.key}
          className={s.paneHead}
          data-collapsed={h.collapsed || undefined}
          data-testid={`pane-${h.key}`}
          style={{ top: h.top }}
          onTouchStart={(e) => {
            swipeRef.current = { key: h.key, y: e.touches[0]?.clientY ?? 0 };
          }}
          onTouchEnd={(e) => {
            const st = swipeRef.current;
            swipeRef.current = null;
            if (!st || st.key !== h.key) return;
            const dy = (e.changedTouches[0]?.clientY ?? st.y) - st.y;
            if (dy > SWIPE_PX && !h.collapsed) applyCollapsed(h.key, true);
            else if (dy < -SWIPE_PX && h.collapsed) applyCollapsed(h.key, false);
          }}
        >
          <span className={s.paneTitle} style={h.color ? { color: h.color } : undefined}>
            {h.title}
          </span>
          <button type="button" className={s.paneToggle} aria-expanded={!h.collapsed} aria-label={t(h.collapsed ? "развернуть панель {name}" : "свернуть панель {name}", { name: h.title })} onClick={() => togglePane(h.key)}>
            {h.collapsed ? "▴" : "▾"}
          </button>
        </div>
      ))}
      {candles.length === 0 && <div className={s.empty}>{t("Нет свечей.")}</div>}
    </div>
  );
}

export { INDICATORS };
