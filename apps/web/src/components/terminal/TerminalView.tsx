"use client";

import { createTerminal, formatPriceLabel, formatTicks, tokensFromElement, type LiqMap, type SrLevel, type Candle, type ChartType, type ScaleMode, type Terminal, type Timeframe } from "@platform/charts";
import { DrawingController, DrawingsPrimitive, INDICATORS, defaultParams, indicatorById, visibleOn, type Drawing, type DrawingType, type DrawingsState, type IndicatorSpec, type Layer, type LayerContext, type Point, TF_SECONDS } from "@platform/charts";
import { LineSeries, createSeriesMarkers, type ISeriesApi, type ISeriesMarkersPluginApi, type SeriesMarker, type Time, type UTCTimestamp } from "lightweight-charts";
import { useCallback, useEffect, useRef, useState } from "react";
import { BoxPrimitive } from "@/components/chart/BoxPrimitive";
import { LevelsPrimitive, type HLine } from "@/components/chart/LevelsPrimitive";
import { VolumeProfilePrimitive, type VpTokens } from "@/components/chart/VolumeProfilePrimitive";
import { STATUS_LABEL } from "@/components/ui/Badge";
import { formatUsdCompact } from "@/lib/format";
import { PATTERN_LABEL, type Derivatives, type FigureOnChart, type LayersResponse, type PatternOnChart } from "@/lib/chart";
import s from "./terminal.module.css";
import { useT } from "@/i18n/client";

/** Цвет индикатора — только токен дизайн-системы (план 5.3): палитра --ind-1…6 и смысловые цвета. */
export type IndColor = "ind1" | "ind2" | "ind3" | "ind4" | "ind5" | "ind6" | "accent" | "up" | "down" | "warn";
export const IND_COLORS: IndColor[] = ["ind1", "ind2", "ind3", "ind4", "ind5", "ind6", "accent", "up", "down", "warn"];
export const IND_COLOR_VAR: Record<IndColor, string> = { ind1: "--ind-1", ind2: "--ind-2", ind3: "--ind-3", ind4: "--ind-4", ind5: "--ind-5", ind6: "--ind-6", accent: "--accent", up: "--up", down: "--down", warn: "--warn" };
/** Цвет по умолчанию — по порядку в списке, чтобы соседние индикаторы не совпадали. */
export const autoIndColor = (i: number): IndColor => IND_COLORS[i % 6]!;
export type ActiveIndicator = { id: string; params: Record<string, number>; color?: IndColor };
export type LayerKey = "structure" | "zones" | "levels" | "signals" | "patterns" | "figures" | "volume_profile" | "sr" | "liq_map";
export type PanelKey = "funding" | "oi" | "liq" | "ls";
export type CrosshairInfo = { candle: Candle; values: { label: string; value: number | null }[] };
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

function precisionOf(tick: string | null): { precision: number; minMove: number } {
  if (!tick) return { precision: 2, minMove: 0.01 };
  const t = tick.replace(/0+$/, "");
  const i = t.indexOf(".");
  return { precision: i < 0 ? 0 : t.length - i - 1, minMove: Number(tick) || 0.01 };
}

type Pane = { spec: IndicatorSpec; paneIndex: number | null; series: Record<string, ISeriesApi<"Line" | "Histogram">>; colorKey: string };
const OVERLAY_SECONDARY_ALPHA = 0.55;
/** Полупрозрачный вариант токена (hex → rgba). */
function fade(hex: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`; // color-ok: из токена
}
/** Заголовок панели под графиком (план 2A.7): панели сворачиваются до 24 px, на телефоне раскрыто не больше трёх. */
type PaneHead = { key: string; title: string; top: number; collapsed: boolean };
/** Чистый график по умолчанию: сколько объектов каждого слоя рисуем поверх свечей. */
const ZONES_MAX = 2;
const STRUCTURE_EVENTS_MAX = 4;
const SWEEPS_MAX = 2;
const EQUAL_LEVELS_MAX = 3;
/** Паттерны: только значимые и только на последних N свечах (выбранный в списке — всегда). */
const PATTERN_RECENT_BARS = 60;
/** Уровень с таким числом касаний рисуется сплошной линией; линии кластеров ликвидаций — на последних N свечах. */
const SR_STRONG_TOUCHES = 5;
const NO_LEVELS: SrLevel[] = [];
const LIQ_LINE_BARS = 40;
/** Подписи дневных и недельных экстремумов. */
const LEVEL_LABEL: Record<string, string> = { pdh: "макс. дня", pdl: "мин. дня", pwh: "макс. недели", pwl: "мин. недели" };
const CLOSED = ["closed_sl", "closed_be", "closed_tp3", "closed_time", "expired", "cancelled"];
const PANE_COLLAPSED_PX = 24;
const PANE_INDICATOR_PX = 90;
/** Короткие имена в карточке значений: «BB Верхняя» вместо «Bollinger Bands Верхняя». */
const SHORT_TITLE: Record<string, string> = { bb: "BB", keltner: "KC", vwap: "VWAP", stoch: "Stoch", supertrend: "Supertrend", ichimoku: "Ichimoku" };
const PANE_CRYPTO_PX = 80;
/** На телефоне раскрыта одна панель индикатора (последняя добавленная), остальные свёрнуты до заголовка. */
const MAX_EXPANDED_MOBILE = 1;
const MOBILE_QUERY = "(max-width: 899px)";
const SWIPE_PX = 24;

/** Обёртка React над Terminal из packages/charts: данные, индикаторы, слои, тема. */
export function TerminalView({ candles, current, tf, type, indicators, layersOn, layers, patterns, highlight, figures, highlightFigure, alertLines, sr, liq, derivatives, panels, tick, onNeedOlder, drawings, onCrosshair, onVisibleFrom, onReady, scale = "linear", overlay = null }: Props) {
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
  const candlesRef = useRef<Candle[]>([]);
  const needOlderRef = useRef(onNeedOlder);
  const onCrosshairRef = useRef(onCrosshair);
  const onVisibleFromRef = useRef(onVisibleFrom);
  const onReadyRef = useRef(onReady);
  const visibleFromRef = useRef<number | null>(null);
  const valuesRef = useRef<Map<string, { label: string; values: (number | null)[] }>>(new Map());
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

  // панели под графиком в порядке сверху вниз: индикаторы в отдельных панелях и крипто-панели
  const paneEntries = useCallback(() => {
    const out: { key: string; title: string; series: ISeriesApi<"Line" | "Histogram">[]; height: number }[] = [];
    for (const [id, p] of panesRef.current) {
      if (p.paneIndex !== null) out.push({ key: id, title: p.spec.title, series: Object.values(p.series), height: PANE_INDICATOR_PX });
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
      return { key: e.key, title: e.title, top: r ? Math.round(r.top - r0.top) : 0, collapsed: collapsedRef.current.has(e.key) };
    });
    setHeads((prev) => (prev.length === next.length && prev.every((h, i) => h.key === next[i]!.key && h.top === next[i]!.top && h.collapsed === next[i]!.collapsed) ? prev : next));
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
        void needOlderRef.current(before).then((r) => {
          if (!r) return;
          term.addOlder(r.candles, r.hasOlder);
        });
      },
      onVisibleRange: (r) => {
        const all = candlesRef.current;
        const i = r ? Math.min(all.length - 1, Math.max(0, Math.floor(r.from))) : -1;
        const t = i >= 0 ? (all[i]?.time ?? null) : null;
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
    onReadyRef.current?.({
      zoom: (f) => term.zoom(f),
      reset: () => term.resetView(150),
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
    const levels = new LevelsPrimitive({ surface: tk0.surface, font: tk0.fontMono });
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
        getCandles: () => candlesRef.current,
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
    const obs = new MutationObserver(() => {
      term.setTheme(tokensFromElement(el));
      prim.update({ tokens: tokensFromElement(el) });
      vp.setTokens(vpTokens(tokensFromElement(el)));
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onMq = () => term.setTheme(tokensFromElement(el));
    mq.addEventListener("change", onMq);
    const onDbl = () => term.resetView(120);
    el.addEventListener("dblclick", onDbl);
    // перекрестие → свеча и значения индикаторов; на телефоне long-press (300 мс) включает «липкий» режим
    const emit = (time: number | null) => {
      if (time === null) {
        if (!stickyRef.current) onCrosshairRef.current?.(null);
        return;
      }
      const all = candlesRef.current;
      const i = all.findIndex((c) => c.time === time);
      if (i < 0) return;
      const values = [...valuesRef.current.values()].map((v) => ({ label: v.label, value: v.values[i] ?? null }));
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
      mq.removeEventListener("change", onMq);
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

  // данные
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const all = current ? [...candles, current] : candles;
    term.setCandles(all, true);
    term.resetView(150);
    candlesRef.current = all;
    vpRef.current?.setCandles(all);
    drawPrimRef.current?.projector?.setBars(all.map((c) => c.time), TF_SECONDS[tf]);
    drawPrimRef.current?.update({});
    const { precision, minMove } = precisionOf(tick);
    term.chart.applyOptions({ localization: { priceFormatter: (p: number) => formatPriceLabel(p, precision), tickmarksPriceFormatter: (ps: number[]) => formatTicks(ps) } });
    void minMove;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, tick]);

  useEffect(() => {
    const term = termRef.current;
    if (term && current) term.update(current);
    if (current) {
      const all = [...candles, current];
      candlesRef.current = all;
      vpRef.current?.setCandles(all);
      drawPrimRef.current?.projector?.setBars(all.map((c) => c.time), TF_SECONDS[tf]);
    }
  }, [current, candles, tf]);

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

  useEffect(() => {
    const term = termRef.current;
    if (!term || !ref.current) return;
    term.setOverlay(overlay, tokensFromElement(ref.current).warn);
  }, [overlay]);

  useEffect(() => {
    termRef.current?.setType(type);
    // маркеры привязаны к старой серии — пересоздать при следующем расчёте слоёв
    markersRef.current = null;
  }, [type]);

  // индикаторы: по активному списку создаём панели/серии, считаем на всех свечах
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
    const all = current ? [...candles, current] : candles;
    for (const ind of indicators) {
      const spec = indicatorById(ind.id);
      if (!spec) continue;
      let pane = panesRef.current.get(ind.id);
      if (!pane) {
        const paneIndex = spec.pane === "separate" ? term.addPane(PANE_INDICATOR_PX) : null;
        const series: Pane["series"] = {};
        for (const sp of spec.series) {
          series[sp.key] = sp.kind === "histogram" ? term.addHistogram(paneIndex ?? 0, color(sp.color)) : term.addLine(paneIndex ?? 0, color(sp.color), sp.width ?? 1);
          // у линий на графике цены метки на шкале не нужны: их значения есть в карточке, а шкала остаётся читаемой
          if (spec.pane === "overlay") series[sp.key]!.applyOptions({ lastValueVisible: false });
        }
        pane = { spec, paneIndex, series, colorKey: "" };
        panesRef.current.set(ind.id, pane);
        const first = Object.values(series)[0];
        if (paneIndex !== null && first) paneAdded(ind.id, first);
      }
      const ck = ind.color ?? autoIndColor(indicators.indexOf(ind));
      if (pane.colorKey !== ck) {
        const base = indColor(ck);
        spec.series.forEach((sp, i) => pane!.series[sp.key]?.applyOptions({ color: seriesColor(spec, i, base) }));
        pane.colorKey = ck;
      }
      const out = spec.compute(all, { ...defaultParams(spec), ...ind.params });
      const short = SHORT_TITLE[spec.id] ?? spec.title;
      for (const sp of spec.series) valuesRef.current.set(`${ind.id}.${sp.key}`, { label: spec.series.length === 1 || sp.label === spec.title || sp.label === short ? short : `${short} ${sp.label}`, values: out[sp.key] ?? [] });
      for (const sp of spec.series) {
        const values = out[sp.key] ?? [];
        const data = all.map((c, i) => ({ time: c.time as UTCTimestamp, value: values[i] })).filter((d) => d.value != null) as { time: UTCTimestamp; value: number }[];
        pane.series[sp.key]!.setData(data as never);
      }
    }
    requestAnimationFrame(relayout);
  }, [indicators, candles, current, paneAdded, relayout]);

  // крипто-панели (план 2A.4): funding, OI, ликвидации — данные с сервера, выровнены по корзинам tf
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
    if (!derivatives) return;
    const asLine = (rows: { t: number; v: string }[]) => rows.map((r) => ({ time: r.t as UTCTimestamp, value: Number(r.v) }));
    for (const k of panels) {
      let p = cryptoRef.current.get(k);
      if (!p) {
        const paneIndex = term.addPane(PANE_CRYPTO_PX);
        const series: ISeriesApi<"Line" | "Histogram">[] = [];
        if (k === "funding") series.push(term.addLine(paneIndex, tokens.warn, 1));
        else if (k === "oi") series.push(term.addLine(paneIndex, tokens.accent, 1));
        else if (k === "ls") series.push(term.addLine(paneIndex, tokens.accent, 1), term.addLine(paneIndex, tokens.warn, 1));
        else series.push(term.addHistogram(paneIndex, tokens.up), term.addHistogram(paneIndex, tokens.down));
        p = { paneIndex, series };
        cryptoRef.current.set(k, p);
        paneAdded(k, series[0]!);
      }
      if (k === "funding") p.series[0]!.setData(asLine(derivatives.funding.map((r) => ({ t: r.t, v: String(Number(r.v) * 100) }))) as never);
      else if (k === "oi") p.series[0]!.setData(asLine(derivatives.oi) as never);
      else if (k === "ls") {
        p.series[0]!.setData(asLine(derivatives.ls_ratio ?? []) as never);
        p.series[1]!.setData(asLine(derivatives.ls_top ?? []) as never);
      } else {
        p.series[0]!.setData(derivatives.liquidations.map((r) => ({ time: r.t as UTCTimestamp, value: Number(r.long), color: tokens.up })) as never);
        p.series[1]!.setData(derivatives.liquidations.map((r) => ({ time: r.t as UTCTimestamp, value: -Number(r.short), color: tokens.down })) as never);
      }
    }
    requestAnimationFrame(relayout);
  }, [derivatives, panels, paneAdded, relayout]);

  // слои: зоны (прямоугольники), структура (отрезки BOS/CHoCH, свинги), уровни, сигналы
  useEffect(() => {
    const term = termRef.current;
    if (!term || candles.length === 0) return;
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
    const first = candles[0]!.time;
    const last = lastT ?? candles[candles.length - 1]!.time;
    const step = (candles[1]?.time ?? first + 1) - first;
    const snap = (t: number) => Math.floor(t / step) * step;
    // все горизонтальные линии — в одном canvas-слое; подпись справа, приоритет решает при наложении
    const hlines: HLine[] = [];
    const { precision } = precisionOf(tick);
    const fp = (p: number) => formatPriceLabel(p, precision);
    const seg = (from: number, to: number | null, price: number, c: string, style: 0 | 1 | 2 | 3, width: 1 | 2 = 1, label?: string, priority = 0) => {
      const a = Math.max(snap(from), first);
      if (a > last) return;
      const b = to === null ? null : Math.min(Math.max(snap(to), a + step), last);
      hlines.push({ from: a as Time, to: b === null ? null : (b as Time), price, color: c, style, width, label: label ? (label.includes("{p}") ? label.replace("{p}", fp(price)) : `${label} ${fp(price)}`) : undefined, priority });
    };
    const st = layers?.structure;
    const boxes = [];
    const markers: SeriesMarker<Time>[] = [];
    if (st && layersOn.zones) {
      // только активные зоны, ближайшие к текущей цене; отработанные не рисуем
      const price = candles[candles.length - 1]!.close;
      const dist = (z: { top: string; bottom: string }) => Math.max(0, Number(z.bottom) - price, price - Number(z.top));
      const nearest = st.zones.filter((z) => z.status === "active").sort((a, b) => dist(a) - dist(b)).slice(0, ZONES_MAX);
      for (const z of nearest) {
        boxes.push({ id: `${z.kind}-${z.from_t}`, from: Math.max(snap(z.from_t), first) as Time, to: null, top: Number(z.top), bottom: Number(z.bottom), fill: alpha(tokens.accent, 0.1), stroke: alpha(tokens.accent, 0.6), label: z.kind.toUpperCase() });
      }
    }
    if (st && layersOn.structure) {
      for (const e of st.events.slice(-STRUCTURE_EVENTS_MAX)) seg(e.from_t, e.t, Number(e.level), e.type === "bos" ? tokens.accent : tokens.warn, 1);
      // свинги маркерами не рисуем: на телефоне LWC делает их крупными кружками и они перекрывают свечи
      for (const sw of st.sweeps.slice(-SWEEPS_MAX)) {
        const at = snap(sw.t);
        if (at < first) continue;
        markers.push({ time: at as Time, position: sw.kind === "low" ? "belowBar" : "aboveBar", shape: "square", color: tokens.warn, text: t("снятие"), size: 0 });
      }
      for (const e of st.equal_levels.filter((x) => !x.swept).slice(-EQUAL_LEVELS_MAX)) seg(e.from_t, e.to_t, Number(e.p), tokens.text3, 2);
    }
    if (st && layersOn.levels) {
      for (const k of ["pdh", "pdl", "pwh", "pwl"]) {
        const v = st.levels[k];
        if (v) seg(first, null, Number(v), tokens.text3, 3, 1, t(LEVEL_LABEL[k] ?? k), 1);
      }
    }
    if (layers && layersOn.signals) {
      for (const sg of layers.signals.slice(0, 20)) {
        const at = snap(sg.t - 1);
        if (at < first) continue;
        const open = !CLOSED.includes(sg.status);
        const label = STATUS_LABEL[sg.status]?.text;
        markers.push({ time: at as Time, position: sg.dir === "long" ? "belowBar" : "aboveBar", shape: sg.dir === "long" ? "arrowUp" : "arrowDown", color: open ? tokens.accent : tokens.text3, text: `${sg.dir === "long" ? t("лонг") : t("шорт")} ${sg.grade}${open || !label ? "" : " · " + t(label)}`, size: 1 });
        if (open && sg.entry) seg(at, null, Number(sg.entry), tokens.accent, 0, 1, t("вход"), 6);
        if (open && sg.sl) seg(at, null, Number(sg.sl), tokens.down, 1, 1, t("стоп"), 6);
        if (open) sg.tp.forEach((tp, i) => tp && seg(at, null, Number(tp), tokens.up, 1, 1, `TP${i + 1}`, 5));
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
          if (b < first) continue;
          const ls = term.chart.addSeries(LineSeries, { color, lineWidth: hl ? 2 : 1, lineStyle: style, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
          ls.setData([{ time: Math.max(a, first) as UTCTimestamp, value: Number(ln.a[1]) + ((Number(ln.b[1]) - Number(ln.a[1])) * (Math.max(a, first) - a)) / Math.max(1, b - a) }, { time: Math.min(b, last + step) as UTCTimestamp, value: Number(ln.b[1]) }]);
          auxRef.current.push(ls);
        }
        if (f.status === "confirmed" && f.target && f.confirm_t) seg(f.confirm_t, null, Number(f.target), tokens.up, 1, 1, t("цель фигуры"), 2);
        if (f.status === "confirmed" && f.invalidation && f.confirm_t) seg(f.confirm_t, null, Number(f.invalidation), tokens.down, 1, 1, t("отмена фигуры"), 2);
        if (hl)
          for (const [pt0] of f.points) {
            const pt = snap(pt0);
            if (pt >= first) markers.push({ time: pt as Time, position: "inBar", shape: "circle", color, text: "", size: 0 });
          }
      }
    }
    for (const al of JSON.parse(alertKey) as NonNullable<Props["alertLines"]>) {
      seg(first, null, al.price, tokens.warn, 3, 1, t("алерт"), 4);
      markers.push({ time: last as Time, position: "inBar", shape: "circle", color: tokens.warn, text: `${t("алерт")} ${al.label}`, size: 0 });
    }
    if (layersOn.sr)
      for (const l of srLevels) {
        const sup = l.side === "support";
        seg(l.firstT, null, l.price, alpha(sup ? tokens.up : tokens.down, 0.85), l.touches >= SR_STRONG_TOUCHES ? 0 : 2, 1, sup ? t("поддержка") : t("сопротивление"), 3);
      }
    let heat = null;
    if (layersOn.liq_map && liqMap) {
      const m = liqMap;
      heat = { step: m.step, bars: m.buckets.map((b) => ({ price: b.price, weight: (b.long + b.short) / m.max })), fill: (w: number) => alpha(tokens.warn, 0.08 + 0.42 * w) };
      const near = Math.max(first, last - LIQ_LINE_BARS * step);
      // крупнейшие скопления с суммой: самое большое на сторону — важнее при наложении подписей
      m.topLongs.forEach((b, i) => seg(near, null, b.price, tokens.warn, 1, 1, t("ликв. лонгов {usd} · {p}", { usd: formatUsdCompact(b.long) }), i === 0 ? 2 : 1));
      m.topShorts.forEach((b, i) => seg(near, null, b.price, tokens.warn, 1, 1, t("ликв. шортов {usd} · {p}", { usd: formatUsdCompact(b.short) }), i === 0 ? 2 : 1));
    }
    levelsRef.current?.set(hlines, heat, { surface: tokens.surface, font: tokens.fontMono });
    boxRef.current.setBoxes(boxes);
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    if (!markersRef.current) markersRef.current = createSeriesMarkers(main, markers);
    else markersRef.current.setMarkers(markers);
  }, [layers, layersOn, candles, lastT, tf, type, patterns, highlight, figures, highlightFigure, alertKey, t, tick, srLevels, liqMap]);

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
          <span className={s.paneTitle}>{h.title}</span>
          <button type="button" className={s.paneToggle} aria-expanded={!h.collapsed} aria-label={`${h.collapsed ? t("развернуть") : t("свернуть")} панель ${h.title}`} onClick={() => togglePane(h.key)}>
            {h.collapsed ? "▴" : "▾"}
          </button>
        </div>
      ))}
      {candles.length === 0 && <div className={s.empty}>{t("Нет свечей.")}</div>}
    </div>
  );
}

export { INDICATORS };
