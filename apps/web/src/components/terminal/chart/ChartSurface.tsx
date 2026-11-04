"use client";

import { COMPACT_FORMAT, ChartController, FALLBACK_COLOR, INDICATOR_COLOR, INTERACTION, NONE, PERCENT_FORMAT, alpha, instanceColors, instanceTitle, mainMinShareFor, paneLevels, resolvePreset, VALUE_FORMAT, alignToCandles, tickPrecision, tokensFromElement, type AlertLine, type Candle, type ChartHandle, type ChartStore, type ChartType, type CrosshairSnapshot, type Device, type ExternalObject, type IndColor, type IndicatorInstance, type IndicatorValue, type MarkupSettings, type PanelKey, type ScaleMode, type Terminal, type Timeframe } from "@platform/charts";
import { DrawingController, DrawingsPrimitive, INDICATORS, defaultParams, indicatorById, visibleOn, type Drawing, type DrawingType, type DrawingsState, type IndicatorSpec, type Layer, type LayerContext, type Point, TF_SECONDS } from "@platform/charts";
import { LineStyle, type IPriceLine, type ISeriesApi, type PriceFormat, type UTCTimestamp } from "lightweight-charts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Derivatives, FigureOnChart, LayersResponse, PatternOnChart } from "@/lib/chart";
import s from "../terminal.module.css";
import { useT } from "@/i18n/client";
import { chartText } from "./chartText";
import { useChartStore } from "./useChartStore";
import { LegendChip, LiqUnavailableNote } from "./LegendChip";
import { ObjectTooltip } from "./ObjectTooltip";
import { PaneValue } from "./PaneValue";
import { MQ } from "@/lib/breakpoints";
import c from "./chart.module.css";

/**
 * Цвет индикатора — один из шести токенов --ind-1…6 (план 2A.9, M19): экземпляры получают цвета по instanceColors
 * пакета (первые — постоянные, следующие и Keltner — первый свободный на графике, OBV — ind-6).
 */
export const IND_COLOR_VAR: Record<IndColor, string> = { ind1: "--ind-1", ind2: "--ind-2", ind3: "--ind-3", ind4: "--ind-4", ind5: "--ind-5", ind6: "--ind-6" };
/** Цвет индикатора без экземпляров (точка в списке): постоянный, у Keltner и неизвестных — ind-1. */
export const indicatorColor = (id: string): IndColor => INDICATOR_COLOR[id] ?? FALLBACK_COLOR;
export type { LayerKey, PanelKey } from "@platform/charts";
/** Управление видом снаружи (кнопки «+/−», горячие клавиши, «Найдено»). */
export type TerminalControls = Pick<ChartHandle, "zoom" | "reset" | "clearCrosshair" | "focus" | "snapshot">;
/** Панели производных под графиком: заголовки по-русски через t() (M11). */
export const PANELS: { id: PanelKey; title: string }[] = [
  { id: "funding", title: "Фандинг" },
  { id: "oi", title: "Открытый интерес" },
  { id: "liq", title: "Ликвидации" },
  { id: "ls", title: "Лонг/шорт" },
];

type Props = {
  candles: Candle[];
  current: Candle | null;
  tf: Timeframe;
  type: ChartType;
  /** Экземпляры индикаторов (uid «ema#2»): серии и панели ключуются по uid. */
  indicators: readonly IndicatorInstance[];
  /** Разметка: пресет и поправки поверх него (план 2B.2). */
  markup: MarkupSettings;
  /** Вошёл ли пользователь: гостю слой «Сигналы» не показывается (M24). */
  authed: boolean;
  /** Состояние графика для листовых компонентов (создаёт владелец). */
  store: ChartStore;
  /** "cell" — ячейка мультичарта; иначе класс устройства по ширине контейнера. */
  device?: Device | "auto";
  layers: LayersResponse | null;
  patterns?: PatternOnChart[];
  figures?: FigureOnChart[];
  /** Активные ценовые алерты (мемоизированы владельцем). */
  alerts: readonly AlertLine[];
  /** Объекты «Разбора сверху вниз» (резерв): в B не передаются. */
  external?: readonly ExternalObject[];
  derivatives: Derivatives | null;
  panels: PanelKey[];
  tick: string | null;
  /** Инструмент: при его смене (как и таймфрейма) свечи заменяются и вид сбрасывается; иначе новые свечи дописываются. */
  dataKey?: string;
  onNeedOlder: (before: number) => Promise<{ candles: Candle[]; hasOlder: boolean } | null>;
  /** Вызывается с управлением видом после создания графика и с null при размонтировании. */
  onReady?: (controls: TerminalControls | null) => void;
  /**
   * Кнопки в углу основной панели (десктоп, план 2B.9): ставятся внизу по центру над шкалой времени,
   * их прямоугольник уходит в uiObstacles — подписи разметки его обходят.
   */
  corner?: ReactNode;
  /**
   * Правый верхний угол основной панели, левее шкалы цены (десктоп): чип режима рисования. Не закрывает легенду
   * (она слева) и уходит в uiObstacles — подписи разметки его обходят.
   */
  topRight?: ReactNode;
  /** Высота шкалы времени (px) при изменении: карточки внизу колонки графика ставятся над ней. */
  onAxisHeight?: (px: number) => void;
  /**
   * Легенда в левом верхнем углу панели цены (десктоп, план 2B.9 §10): символ, «?», OHLC под перекрестием и строки
   * индикаторов. Её прямоугольник уходит в uiObstacles. Без неё — «?» и пометка ликвидаций B на своих местах.
   */
  legend?: ReactNode;
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

/** Экземпляр индикатора на графике: серии, заголовок «RSI 14», уровни-ориентиры панели (пунктир --text-3). */
type Pane = { spec: IndicatorSpec; paneIndex: number | null; series: Record<string, ISeriesApi<"Line" | "Histogram">>; colorKey: string; base?: string; title: string; levels: IPriceLine[]; hidden: boolean };
const OVERLAY_SECONDARY_ALPHA = 0.55;
/** Заголовок панели под графиком (план 2A.7): панели сворачиваются до 24 px, на телефоне раскрыто не больше одной. */
type PaneHead = { key: string; title: string; top: number; collapsed: boolean; color?: string; testId: string; values: boolean };
const PANE_COLLAPSED_PX = 24;
const PANE_INDICATOR_PX = 90;
const PANE_CRYPTO_PX = 80;
/** На телефоне раскрыта одна панель индикатора (последняя добавленная), остальные свёрнуты до заголовка. */
const MAX_EXPANDED_MOBILE = 1;
/** Свёртывание панелей на узком экране — по media query (lib/breakpoints) до D (PaneManager). */
const MOBILE_QUERY = MQ.mobile;
/** Формат шкалы индикатора на отдельной панели: объём и OBV — компактно, остальное — значения. */
const COMPACT_INDICATORS = new Set(["volume", "obv"]);
const indicatorFormat = (id: string): PriceFormat => (COMPACT_INDICATORS.has(id) ? COMPACT_FORMAT : VALUE_FORMAT);
/** Зазор между низом легенды и верхом свечей, px (верхнее поле шкалы цены — Terminal.setTopMargin). */
const LEGEND_GAP_PX = 6;
const NO_PATTERNS: readonly PatternOnChart[] = [];
const NO_FIGURES: readonly FigureOnChart[] = [];

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

/**
 * Поверхность графика (бывший TerminalView, план 2B.2): React-шов к ChartController. Контроллер владеет
 * терминалом, темой, классом устройства, сценой разметки (один OverlayPrimitive), шкалой и наведением.
 * Здесь до PR D остаются эффекты данных, индикаторов, панелей производных и рисунков (через controller.terminal).
 */
export function ChartSurface({ candles, current, tf, type, indicators, markup, authed, store, device = "auto", layers, patterns, figures, alerts, external = NONE, derivatives, panels, tick, dataKey = "", onNeedOlder, drawings, onReady, corner, topRight, onAxisHeight, legend, scale = "linear", overlay = null }: Props) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<ChartController | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const tfRef = useRef(tf);
  const panesRef = useRef<Map<string, Pane>>(new Map());
  const cryptoRef = useRef<Map<PanelKey, { paneIndex: number; series: ISeriesApi<"Line" | "Histogram">[] }>>(new Map());
  const drawPrimRef = useRef<DrawingsPrimitive | null>(null);
  const drawCtrlRef = useRef<DrawingController | null>(null);
  const drawingsRef = useRef(drawings);
  const needOlderRef = useRef(onNeedOlder);
  const onReadyRef = useRef(onReady);
  /** Линии индикаторов по ключу `${uid}.${серия}`: значения на всех свечах буфера — для перекрестия и легенды. */
  const valuesRef = useRef<Map<string, SeriesValues>>(new Map());
  const stickyRef = useRef(false);
  const [heads, setHeads] = useState<PaneHead[]>([]);
  /** Основная панель: ширина области свечей (без шкалы цены) и высота — для кнопок в углу. */
  const [mainBox, setMainBox] = useState<{ w: number; h: number } | null>(null);
  const cornerRef = useRef<HTMLDivElement>(null);
  const topRightRef = useRef<HTMLDivElement>(null);
  const onAxisHeightRef = useRef(onAxisHeight);
  const axisHRef = useRef<number | null>(null);
  const legendRef = useRef<HTMLDivElement>(null);
  /** Прямоугольник легенды в координатах графика (CSS px) — препятствие для подписей разметки. */
  const [legendBox, setLegendBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  /** Низ легенды без строки OHLC под перекрестием: под него — верхнее поле шкалы цены (свечи не уходят под легенду). */
  const [legendBottom, setLegendBottom] = useState<number | null>(null);
  const collapsedRef = useRef<Set<string>>(new Set());
  const paneObsRef = useRef<ResizeObserver | null>(null);
  const swipeRef = useRef<{ key: string; y: number } | null>(null);
  /** Подгрузка истории слева и смена темы — из хранилища графика (переходные поля до D). */
  const historyRev = useChartStore((st) => st.status.historyRev, store);
  const themeVersion = useChartStore((st) => st.status.themeVersion, store);
  /** Палец: подсказка объекта — закреплённая карточка внизу графика (план 2A.7). */
  const [coarse] = useState(() => typeof window !== "undefined" && window.matchMedia(MQ.coarse).matches);
  /** Что загружено в график: смена инструмента или таймфрейма — замена и сброс вида, иначе — дописывание. */
  const loadedRef = useRef<{ key: string; tf: Timeframe; candles: Candle[] } | null>(null);

  // проектор рисунков читает ту же модель свечей, что и график
  const syncModel = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    drawPrimRef.current?.projector?.setBars(term.candles.map((c) => c.time), TF_SECONDS[tfRef.current]);
    drawPrimRef.current?.update({});
  }, []);

  // панели под графиком в порядке сверху вниз: индикаторы в отдельных панелях и крипто-панели
  const paneEntries = useCallback(() => {
    const out: { key: string; title: string; series: ISeriesApi<"Line" | "Histogram">[]; height: number; color?: string; testId: string; values: boolean }[] = [];
    // у отдельной панели один экземпляр: testid по id индикатора (pane-rsi), как до экземпляров
    for (const [uid, p] of panesRef.current) {
      if (p.paneIndex !== null) out.push({ key: uid, title: p.title, series: Object.values(p.series), height: PANE_INDICATOR_PX, color: p.base, testId: p.spec.id, values: true });
    }
    for (const [k, p] of cryptoRef.current) out.push({ key: k, title: t(PANELS.find((x) => x.id === k)?.title ?? k), series: p.series, height: PANE_CRYPTO_PX, testId: k, values: false });
    return out.filter((e) => e.series.length > 0).sort((a, b) => a.series[0]!.getPane().paneIndex() - b.series[0]!.getPane().paneIndex());
  }, [t]);

  const relayout = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const r0 = el.getBoundingClientRect();
    const next = paneEntries().map((e) => {
      const r = e.series[0]!.getPane().getHTMLElement()?.getBoundingClientRect();
      return { key: e.key, title: e.title, top: r ? Math.round(r.top - r0.top) : 0, collapsed: collapsedRef.current.has(e.key), color: e.color, testId: e.testId, values: e.values };
    });
    setHeads((prev) => (prev.length === next.length && prev.every((h, i) => h.key === next[i]!.key && h.title === next[i]!.title && h.top === next[i]!.top && h.collapsed === next[i]!.collapsed && h.color === next[i]!.color) ? prev : next));
    const term = termRef.current;
    const mainEl = term?.chart.panes()[0]?.getHTMLElement();
    if (term && mainEl) {
      const w = Math.round(term.chart.timeScale().width());
      const h = Math.round(mainEl.getBoundingClientRect().height);
      setMainBox((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
      const axisH = Math.round(term.chart.timeScale().height());
      if (axisH > 0 && axisH !== axisHRef.current) {
        axisHRef.current = axisH;
        onAxisHeightRef.current?.(axisH);
      }
    }
  }, [paneEntries]);

  // все панели раскладываются разом: свёрнутые — 24 px, раскрытые — своя высота, свечам — остаток, но не меньше
  // доли устройства (PaneManager: десктоп 55 %, телефон 60 %)
  const layoutAll = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    const want = new Map(paneEntries().map((e) => [e.series[0]!.getPane(), collapsedRef.current.has(e.key) ? PANE_COLLAPSED_PX : e.height] as const));
    term.layoutPanes(want, mainMinShareFor(store.getState().status.device));
  }, [paneEntries, store]);

  const applyCollapsed = useCallback(
    (key: string, collapsed: boolean) => {
      const e = paneEntries().find((x) => x.key === key);
      if (!e) return;
      if (collapsed) collapsedRef.current.add(key);
      else collapsedRef.current.delete(key);
      // в свёрнутой панели прячем и метки последнего значения на шкале (иначе «0.0» и огромные числа OI)
      const hidden = panesRef.current.get(key)?.hidden ?? false;
      e.series.forEach((sr) => sr.applyOptions({ visible: !collapsed && !hidden, lastValueVisible: !collapsed && sr.seriesType() === "Line" }));
      layoutAll();
      requestAnimationFrame(relayout);
    },
    [paneEntries, relayout, layoutAll],
  );

  // новая панель: наблюдаем её размер; на телефоне раскрыта одна — старшие сворачиваются
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
    onReadyRef.current = onReady;
    onAxisHeightRef.current = onAxisHeight;
  }, [onNeedOlder, drawings, tf, onReady, onAxisHeight]);

  // создание контроллера (терминал, разметка, тема, вид) и рисунков
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ctrl = new ChartController({ container: el, store, device, type, onNeedOlder: (before) => needOlderRef.current(before) });
    const term = ctrl.terminal;
    ctrlRef.current = ctrl;
    termRef.current = term;
    // LWC с vertTouchDrag=false отдаёт браузеру любой жест круче ~27° — и график «не реагирует»
    term.chart.applyOptions({ handleScroll: { vertTouchDrag: true } });
    // новый график пуст: следующие данные — замена, а не дописывание (и после повторного монтирования в StrictMode)
    loadedRef.current = null;
    // перекрестие → хранилище графика не чаще раза за кадр: читают только листы (легенда, значения панелей)
    let crossRaf = 0;
    let crossNext: CrosshairSnapshot | null = null;
    const publish = (snap: CrosshairSnapshot | null) => {
      crossNext = snap;
      if (crossRaf) return;
      crossRaf = requestAnimationFrame(() => {
        crossRaf = 0;
        store.patch({ crosshair: crossNext });
      });
    };
    const clearCrosshair = () => {
      stickyRef.current = false;
      delete el.dataset.sticky;
      ctrl.handle.clearCrosshair();
      cancelAnimationFrame(crossRaf);
      crossRaf = 0;
      store.patch({ crosshair: null });
    };
    onReadyRef.current?.({ zoom: ctrl.handle.zoom, reset: ctrl.handle.reset, clearCrosshair, focus: ctrl.handle.focus, snapshot: ctrl.handle.snapshot });
    const prim = new DrawingsPrimitive(tokensFromElement(el));
    prim.touch = typeof window !== "undefined" && window.matchMedia(MQ.coarse).matches;
    drawPrimRef.current = prim;
    term.layers.add(new PrimitiveLayer("drawings", prim));
    const dctrl = new DrawingController(
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
    drawCtrlRef.current = dctrl;
    // рисунки пользователя важнее разметки: с инструментом или над рисунком наведения и выбора объектов нет
    ctrl.setHitGate((x, y) => !drawingsRef.current?.tool && dctrl.hitAt(x, y) === null);
    // перекрестие → свеча и значения индикаторов; на телефоне long-press (300 мс) включает «липкий» режим
    const emit = (time: number | null) => {
      if (time === null) {
        if (!stickyRef.current) publish(null);
        return;
      }
      const all = term.candles;
      const i = indexOfTime(all, time);
      if (i < 0) return;
      const values: IndicatorValue[] = [...valuesRef.current].map(([key, v]) => valueAt(key, v, i));
      publish({ time, index: i, candle: all[i]!, values, sticky: stickyRef.current });
    };
    const onMove = (p: { time?: unknown }) => emit(typeof p.time === "number" ? p.time : null);
    term.chart.subscribeCrosshairMove(onMove);
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
      }, INTERACTION.longPressMs);
    };
    const onPMove = (e: PointerEvent) => {
      if (pressStart && !stickyRef.current && Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > INTERACTION.tapSlopPx) {
        clearTimeout(pressTimer);
        pressStart = null;
      }
    };
    const onPUp = (e: PointerEvent) => {
      clearTimeout(pressTimer);
      const wasTap = pressStart !== null && Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) < INTERACTION.tapSlopPx;
      pressStart = null;
      if (stickyRef.current) {
        if (wasTap && !el.dataset.stickyArmed) {
          // короткий тап в липком режиме — выход
          stickyRef.current = false;
          delete el.dataset.sticky;
          publish(null);
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
    const crypto = cryptoRef.current;
    return () => {
      paneObs.disconnect();
      paneObsRef.current = null;
      term.chart.unsubscribeCrosshairMove(onMove);
      el.removeEventListener("pointerdown", onPDown);
      el.removeEventListener("pointermove", onPMove);
      el.removeEventListener("pointerup", onPUp);
      el.removeEventListener("pointercancel", onPUp);
      clearTimeout(pressTimer);
      cancelAnimationFrame(crossRaf);
      store.patch({ crosshair: null, values: NO_VALUES });
      panes.clear();
      crypto.clear();
      dctrl.destroy();
      drawCtrlRef.current = null;
      drawPrimRef.current = null;
      ctrl.destroy();
      ctrlRef.current = null;
      termRef.current = null;
      onReadyRef.current?.(null);
    };
    // тип меняется через setType ниже, хранилище и класс устройства у поверхности постоянны
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // данные: смена инструмента или таймфрейма — замена свечей и сброс вида; закрытие свечи — дописывание,
  // масштаб, прокрутка и подгруженная слева история пользователя сохраняются (план 2A.7)
  useEffect(() => {
    const term = termRef.current;
    const ctrl = ctrlRef.current;
    if (!term || !ctrl) return;
    const prev = loadedRef.current;
    const same = prev !== null && prev.key === dataKey && prev.tf === tf;
    if (same && prev.candles.length === 0 && candles.length === 0) return;
    const n = prev?.candles.length ?? 0;
    const append = same && n > 0 && candles.length >= n && candles[0]?.time === prev.candles[0]?.time && candles[n - 1]?.time === prev.candles[n - 1]?.time;
    loadedRef.current = { key: dataKey, tf, candles };
    // таймфрейм — до данных: сброс вида считает число свечей по лимиту таймфрейма
    ctrl.set({ tf });
    if (append) {
      // закрывшиеся свечи заменяют текущую с тем же временем; новая текущая придёт через term.update(current)
      for (const c of candles.slice(n)) term.update(c);
      if (candles.length > n) ctrl.notifyCandles("append");
    } else {
      term.setCandles(current ? [...candles, current] : candles, true);
      ctrl.notifyCandles("replace");
    }
    syncModel();
    // текущая свеча обновляется своим эффектом ниже; здесь она нужна только при замене
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, tf, dataKey, syncModel]);

  useEffect(() => {
    const term = termRef.current;
    if (!term || !current) return;
    term.update(current);
    ctrlRef.current?.notifyCandles("tick");
    syncModel();
  }, [current, syncModel]);

  // формат цены инструмента (шкала и деления под метками — в контроллере) и подписи рисунков
  useEffect(() => {
    ctrlRef.current?.set({ tick });
    drawPrimRef.current?.update({ precision: tickPrecision(tick) });
  }, [tick]);

  // вход сцены разметки: пресет, слои с сервера, паттерны, фигуры, алерты, производные (OI), тексты
  useEffect(() => {
    ctrlRef.current?.set({
      markup,
      authed,
      structure: layers?.structure ?? null,
      signals: layers?.signals ?? NONE,
      patterns: patterns ?? NO_PATTERNS,
      figures: figures ?? NO_FIGURES,
      alerts,
      external,
      derivatives,
      text: chartText(t),
    });
  }, [markup, authed, layers, patterns, figures, alerts, external, derivatives, t]);

  // подгрузка истории слева: проектор рисунков — на новом буфере
  useEffect(() => {
    if (historyRev > 0) syncModel();
  }, [historyRev, syncModel]);

  // рисунки: синхронизируем примитив и контроллер с внешним состоянием; тема — токены рисунков
  useEffect(() => {
    const prim = drawPrimRef.current;
    const dctrl = drawCtrlRef.current;
    if (!prim || !dctrl) return;
    prim.update({ drawings: drawings ? visibleOn(drawings.state, tf) : [], draft: drawings?.draft ?? null, selectedId: drawings?.state.selectedId ?? null });
    if (dctrl.tool !== (drawings?.tool ?? null)) dctrl.setTool(drawings?.tool ?? null);
    dctrl.setMagnet(drawings?.magnet ?? true);
  }, [drawings, tf]);

  useEffect(() => {
    if (themeVersion > 1 && ref.current) drawPrimRef.current?.update({ tokens: tokensFromElement(ref.current) });
  }, [themeVersion]);

  useEffect(() => {
    termRef.current?.setScaleMode(scale);
  }, [scale]);

  // наложенный инструмент: нейтральная линия --text-2 (охра — только ликвидации, M19), перечитывается при смене темы
  useEffect(() => {
    const term = termRef.current;
    if (!term || !ref.current) return;
    term.setOverlay(overlay, tokensFromElement(ref.current).text2);
  }, [overlay, themeVersion]);

  useEffect(() => {
    termRef.current?.setType(type);
    // проектор рисунков — у новой основной серии
    syncModel();
  }, [type, syncModel]);

  // индикаторы: по списку экземпляров создаём панели/серии (ключ — uid), считаем на всех свечах буфера (и подгруженных
  // слева); у отдельной панели — пунктирные уровни-ориентиры (RSI 30/70, Stochastic 20/80, MACD 0, CCI ±100)
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const tokens = tokensFromElement(ref.current!);
    const color = (k: string) => (({ accent: tokens.accent, up: tokens.up, down: tokens.down, warn: tokens.warn, text2: tokens.text2, text3: tokens.text3 }) as Record<string, string>)[k] ?? tokens.text2;
    const indColor = (c: IndColor) => tokens.ind[Number(c.slice(3)) - 1] ?? tokens.text2;
    // первая линия — цвет экземпляра; остальные линии наложения — тот же цвет бледнее, у панелей — свои смысловые
    const seriesColor = (spec: IndicatorSpec, i: number, base: string) => {
      if (i === 0) return base;
      if (spec.pane === "overlay") return alpha(base, OVERLAY_SECONDARY_ALPHA);
      // на панели вторая линия нейтральная, чтобы не сливаться с цветом индикатора; гистограмма — свои цвета
      return spec.series[i]!.kind === "histogram" ? color(spec.series[i]!.color) : tokens.text2;
    };
    const colors = instanceColors(indicators);
    const want = new Map(indicators.map((i) => [i.uid, i]));
    for (const [uid, pane] of panesRef.current) {
      const next = want.get(uid);
      if (!next || next.id !== pane.spec.id) {
        Object.values(pane.series).forEach((sr) => term.removeSeries(sr));
        panesRef.current.delete(uid);
        collapsedRef.current.delete(uid);
      }
    }
    for (const k of [...valuesRef.current.keys()]) if (!want.has(k.slice(0, k.lastIndexOf(".")))) valuesRef.current.delete(k);
    const all = term.candles;
    for (const ind of indicators) {
      const spec = indicatorById(ind.id);
      if (!spec) continue;
      let pane = panesRef.current.get(ind.uid);
      if (!pane) {
        const paneIndex = spec.pane === "separate" ? term.addPane(PANE_INDICATOR_PX) : null;
        const series: Pane["series"] = {};
        for (const sp of spec.series) {
          // наложенные линии — в ценах инструмента (формат шкалы цены), на отдельной панели — свой формат
          const fmt = paneIndex === null ? undefined : indicatorFormat(spec.id);
          series[sp.key] = sp.kind === "histogram" ? term.addHistogram(paneIndex ?? 0, color(sp.color), fmt) : term.addLine(paneIndex ?? 0, color(sp.color), sp.width ?? 1, fmt);
          // у линий на графике цены метки на шкале не нужны: их значения есть в легенде, а шкала остаётся читаемой
          if (spec.pane === "overlay") series[sp.key]!.applyOptions({ lastValueVisible: false });
        }
        const first = Object.values(series)[0];
        const levels = paneIndex !== null && first ? paneLevels(spec).map((price) => first.createPriceLine({ price, color: tokens.text3, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "" })) : [];
        pane = { spec, paneIndex, series, colorKey: "", title: "", levels, hidden: false };
        panesRef.current.set(ind.uid, pane);
        if (paneIndex !== null && first) paneAdded(ind.uid, first);
      }
      pane.title = instanceTitle(spec, ind.params, t);
      const ck = colors.get(ind.uid) ?? FALLBACK_COLOR;
      const base = indColor(ck);
      // цвет перечитывается и при смене темы: у светлой и тёмной темы свои оттенки --ind-* и --text-3 уровней
      const colorKey = `${ck}|${themeVersion}`;
      if (pane.colorKey !== colorKey) {
        spec.series.forEach((sp, i) => pane!.series[sp.key]?.applyOptions({ color: seriesColor(spec, i, base) }));
        pane.levels.forEach((l) => l.applyOptions({ color: tokens.text3 }));
        pane.colorKey = colorKey;
        pane.base = base;
      }
      const hidden = ind.hidden === true;
      if (pane.hidden !== hidden) {
        pane.hidden = hidden;
        const collapsed = collapsedRef.current.has(ind.uid);
        Object.values(pane.series).forEach((sr) => sr.applyOptions({ visible: !hidden && !collapsed }));
      }
      const out = spec.compute(all, { ...defaultParams(spec), ...ind.params });
      spec.series.forEach((sp, i) => {
        const key = `${ind.uid}.${sp.key}`;
        // скрытый экземпляр: значений нет ни в легенде, ни в карточке перекрестия
        if (hidden) valuesRef.current.delete(key);
        else valuesRef.current.set(key, { uid: ind.uid, label: spec.series.length === 1 ? pane!.title : `${pane!.title} ${t(sp.label)}`, values: out[sp.key] ?? [], color: seriesColor(spec, i, base), price: spec.pane === "overlay" });
      });
      for (const sp of spec.series) {
        const values = out[sp.key] ?? [];
        const data = all.map((c, i) => ({ time: c.time as UTCTimestamp, value: values[i] })).filter((d) => d.value != null) as { time: UTCTimestamp; value: number }[];
        pane.series[sp.key]!.setData(data as never);
      }
    }
    // последние значения — легенде без перекрестия (лист читает их из хранилища)
    const n = all.length - 1;
    const last: IndicatorValue[] = n < 0 ? [] : [...valuesRef.current].map(([key, v]) => valueAt(key, v, n));
    if (!sameValues(store.getState().values, last)) store.patch({ values: last });
    requestAnimationFrame(relayout);
  }, [indicators, candles, current, historyRev, themeVersion, paneAdded, relayout, store, t]);

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
    // цвета — заново при каждой смене темы; формат шкалы — свой у каждой панели (проценты, компактно). Линии — из
    // нейтральных --ind-* и --text-2, как индикаторы (план 2A.9): охра — только карта ликвидаций, салатовый — только
    // интерфейс; столбцы ликвидаций — --up/--down (направление)
    const ind = (n: number) => tokens.ind[n - 1] ?? tokens.text2;
    const colors: Record<PanelKey, string[]> = { funding: [ind(5)], oi: [ind(1)], ls: [ind(1), tokens.text2], liq: [tokens.up, tokens.down] };
    for (const k of panels) {
      let p = cryptoRef.current.get(k);
      if (!p) {
        const paneIndex = term.addPane(PANE_CRYPTO_PX);
        const series: ISeriesApi<"Line" | "Histogram">[] = [];
        const [c0, c1] = colors[k];
        if (k === "funding") series.push(term.addLine(paneIndex, c0!, 1, PERCENT_FORMAT));
        else if (k === "oi") series.push(term.addLine(paneIndex, c0!, 1, COMPACT_FORMAT));
        else if (k === "ls") series.push(term.addLine(paneIndex, c0!, 1, VALUE_FORMAT), term.addLine(paneIndex, c1!, 1, VALUE_FORMAT));
        else series.push(term.addHistogram(paneIndex, c0!, COMPACT_FORMAT), term.addHistogram(paneIndex, c1!, COMPACT_FORMAT));
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
  }, [derivatives, panels, candles, historyRev, themeVersion, tf, paneAdded, relayout]);

  // легенда: её прямоугольник (меняется с перекрестием и списком индикаторов) — через ResizeObserver
  const hasLegend = !!legend;
  useLayoutEffect(() => {
    const host = legendRef.current;
    const el = ref.current;
    if (!hasLegend || !host || !el) {
      setLegendBox(null);
      setLegendBottom(null);
      return;
    }
    const measure = () => {
      const r = host.getBoundingClientRect();
      const r0 = el.getBoundingClientRect();
      const next = r.width > 0 && r.height > 0 ? { x: Math.round(r.left - r0.left), y: Math.round(r.top - r0.top), w: Math.round(r.width), h: Math.round(r.height) } : null;
      setLegendBox((prev) => (prev === next || (prev && next && prev.x === next.x && prev.y === next.y && prev.w === next.w && prev.h === next.h) ? prev : next));
      // под перекрестием легенда шире на строку OHLC (и может перенестись): поле шкалы от этого не прыгает
      if (!store.getState().crosshair) setLegendBottom(next ? next.y + next.h : null);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => ro.disconnect();
  }, [hasLegend, store]);

  // верхнее поле шкалы цены — под легенду (план 2B.9 §10, не больше 35 % панели): свечи не рисуются под строками
  useLayoutEffect(() => {
    const term = termRef.current;
    if (!term || !mainBox || mainBox.h <= 0) return;
    term.setTopMargin(legendBottom == null ? 0 : (legendBottom + LEGEND_GAP_PX) / mainBox.h);
  }, [legendBottom, mainBox]);

  // угол графика, чип справа сверху и легенда — препятствия для подписей разметки (координаты основной панели, CSS px)
  const hasCorner = !!corner;
  const hasTopRight = !!topRight;
  useLayoutEffect(() => {
    const ctrl = ctrlRef.current;
    const el = ref.current;
    if (!ctrl || !el) return;
    const rects: { x: number; y: number; w: number; h: number }[] = [];
    const r0 = el.getBoundingClientRect();
    for (const box of [hasCorner ? cornerRef.current?.firstElementChild?.getBoundingClientRect() : null, hasTopRight ? topRightRef.current?.firstElementChild?.getBoundingClientRect() : null]) {
      if (box && box.width > 0) rects.push({ x: box.left - r0.left, y: box.top - r0.top, w: box.width, h: box.height });
    }
    if (legendBox) rects.push(legendBox);
    ctrl.set({ uiObstacles: rects.length ? rects : NONE });
  }, [hasCorner, hasTopRight, mainBox, legendBox]);

  return (
    <div className={s.chart}>
      <div ref={ref} className={s.canvas} data-testid="terminal" />
      {corner && mainBox && (
        <div ref={cornerRef} className={s.cornerHost} style={{ width: mainBox.w, height: mainBox.h }}>
          {corner}
        </div>
      )}
      {topRight && mainBox && (
        <div ref={topRightRef} className={s.topRightHost} style={{ width: mainBox.w }}>
          {topRight}
        </div>
      )}
      <ObjectTooltip store={store} coarse={coarse} />
      {legend ? (
        <div ref={legendRef} className={c.legendHost}>
          {legend}
        </div>
      ) : (
        device !== "cell" && (
          <>
            <LegendChip store={store} />
            <LiqUnavailableNote store={store} on={resolvePreset(markup, "desktop", { authed }).layers.liq_map} />
          </>
        )
      )}
      {heads.map((h) => (
        <div
          key={h.key}
          className={s.paneHead}
          data-collapsed={h.collapsed || undefined}
          data-testid={`pane-${h.testId}`}
          style={{ top: h.top }}
          onTouchStart={(e) => {
            swipeRef.current = { key: h.key, y: e.touches[0]?.clientY ?? 0 };
          }}
          onTouchEnd={(e) => {
            const st = swipeRef.current;
            swipeRef.current = null;
            if (!st || st.key !== h.key) return;
            const dy = (e.changedTouches[0]?.clientY ?? st.y) - st.y;
            if (dy > INTERACTION.swipePx && !h.collapsed) applyCollapsed(h.key, true);
            else if (dy < -INTERACTION.swipePx && h.collapsed) applyCollapsed(h.key, false);
          }}
        >
          <span className={s.paneTitle} style={h.color ? { color: h.color } : undefined}>
            {h.title}
          </span>
          {h.values && !h.collapsed && <PaneValue store={store} uid={h.key} compact={COMPACT_INDICATORS.has(h.testId)} />}
          <button type="button" className={s.paneToggle} aria-expanded={!h.collapsed} aria-label={t(h.collapsed ? "развернуть панель {name}" : "свернуть панель {name}", { name: h.title })} onClick={() => togglePane(h.key)}>
            {h.collapsed ? "▴" : "▾"}
          </button>
        </div>
      ))}
      {candles.length === 0 && <div className={s.empty}>{t("Нет свечей.")}</div>}
    </div>
  );
}

/** Ряд значений линии индикатора (ключ — «uid.ключ линии»). */
type SeriesValues = { uid: string; label: string; values: (number | null)[]; color: string; price: boolean };

/** Значение ряда индикатора на свече i — для легенды, заголовка панели и карточки перекрестия. */
function valueAt(key: string, v: SeriesValues, i: number): IndicatorValue {
  return { key, uid: v.uid, label: v.label, value: v.values[i] ?? null, color: v.color, price: v.price };
}

/** Значения те же (ключ, подпись, число, цвет): хранилище не трогаем — легенда не перерисовывается. */
function sameValues(a: readonly IndicatorValue[], b: readonly IndicatorValue[]): boolean {
  return a.length === b.length && a.every((x, i) => x.key === b[i]!.key && x.value === b[i]!.value && x.label === b[i]!.label && x.color === b[i]!.color);
}
const NO_VALUES: readonly IndicatorValue[] = [];

export { INDICATORS };
