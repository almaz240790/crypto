"use client";

import { COMPACT_FORMAT, ChartController, EMPTY_PANE_LAYOUT, FALLBACK_COLOR, INDICATOR_COLOR, INTERACTION, NONE, PERCENT_FORMAT, VIEW, alpha, commitPaneHeights, dragSeparator, instanceColors, instanceTitle, mainMinShareFor, movePaneKey, orderPaneKeys, paneLevels, planMaximized, planPanes, resolvePreset, VALUE_FORMAT, alignToCandles, tickPrecision, tokensFromElement, type AlertLine, type Candle, type ChartHandle, type ChartStore, type ChartType, type CrosshairSnapshot, type Device, type ExternalObject, type IndColor, type IndicatorInstance, type IndicatorValue, type MarkupSettings, type PaneLayout, type PanePlan, type PanelKey, type ScaleMode, type SepLimits, type Terminal, type Timeframe } from "@platform/charts";
import { DrawingController, DrawingsPrimitive, INDICATORS, clampParams, defaultParams, indicatorById, visibleOn, type Drawing, type DrawingText, type DrawingType, type DrawingsState, type IndicatorSpec, type Layer, type LayerContext, type Point, type RiskProfile, TF_SECONDS } from "@platform/charts";
import { LineStyle, TrackingModeExitMode, type IPriceLine, type ISeriesApi, type PriceFormat, type UTCTimestamp } from "lightweight-charts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Derivatives, FigureOnChart, LayersResponse, PatternOnChart } from "@/lib/chart";
import type { LiveSource } from "@/lib/liveBar";
import s from "../terminal.module.css";
import { useT } from "@/i18n/client";
import { chartText, drawingText } from "./chartText";
import { useChartStore } from "./useChartStore";
import { LegendChip, LiqUnavailableNote } from "./LegendChip";
import { HistoryEdgeNote } from "./HistoryEdgeNote";
import { ObjectTooltip } from "./ObjectTooltip";
import { PaneChrome, type ChartGeo, type PaneGeo, type PaneSep, type ResizePhase } from "./PaneChrome";
import { autoBox } from "./paneGeo";
import { legendFit, legendTopMargin } from "./legendFit";
import { cardBottomMargin, drawingExtent } from "./cardInset";
import { LegendFitContext } from "./legendFitContext";
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
  /** Закрытые свечи и текущая из состояния React — для индикаторов (текущая — раз в 5 с и при закрытии свечи). */
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
   * Стопка карточек поверх графика (выбранный рисунок, лимит рисунков): прямоугольник каждой карточки уходит в
   * uiObstacles — плашки позиции, уровни Фибоначчи и подписи разметки не ставятся под карточку (ADR-0009, «Рисование»).
   */
  cards?: HTMLElement | null;
  /**
   * Легенда в левом верхнем углу панели цены (десктоп, план 2B.9 §10): символ, «?», OHLC под перекрестием и строки
   * индикаторов. Её прямоугольник уходит в uiObstacles. Без неё — «?» и пометка ликвидаций B на своих местах.
   */
  legend?: ReactNode;
  /**
   * Порядок и высоты панелей под графиком (ADR-0009, «Управление панелями»): хранит владелец (настройки терминала);
   * без onPaneLayout — только на время жизни графика.
   */
  paneLayout?: PaneLayout;
  onPaneLayout?: (l: PaneLayout) => void;
  /** «убрать» в заголовке панели: uid экземпляра индикатора или ключ панели данных. */
  onRemovePane?: (key: string) => void;
  /** «настройки» в заголовке панели: параметры экземпляра (то же окно, что в легенде). */
  onInstanceParams?: (uid: string, params: Record<string, number>) => void;
  /** Однократная подсказка о том, как управлять панелями (терминал). */
  paneHint?: boolean;
  /** Режим ценовой шкалы и наложенный инструмент (план 2A.3). */
  scale?: ScaleMode;
  overlay?: Candle[] | null;
  /**
   * Живая свеча (LiveBar, ADR-0010) — единственный источник свечей графика: замена — по её снимку (смена
   * инструмента/таймфрейма, первые данные), тики, закрытия, уточнения и догон — её подписчиком, без React и без
   * setCandles. Пути «свечи из состояния React в серию» больше нет (ревью C1): у каждой задачи один владелец.
   */
  live: LiveSource;
  drawings?: {
    state: DrawingsState;
    tool: DrawingType | null;
    magnet: boolean;
    /** «Рисовать серию»: инструмент не снимается после рисунка. */
    series: boolean;
    draft: Drawing | null;
    onCreate: (d: Drawing) => void;
    /** Перетаскивание; final — конец, origin — точки до него (шаг отмены — от них). */
    onMove: (id: string, points: Point[], final: boolean, origin?: Point[]) => void;
    onSelect: (id: string | null) => void;
    onDraft: (d: Drawing | null) => void;
    /** Сколько точек начатого рисунка поставлено (0 — не начат). */
    onStep: (placed: number) => void;
    /** Рисунок завершён; ended — контроллер снял инструмент (без «серии»). */
    onToolDone: (ended: boolean) => void;
    /** Депозит и доля риска из настроек: у позиции на графике — риск в $ и объём. */
    profile?: RiskProfile | null;
    /** Уровни нового Фибоначчи — набор, выбранный пользователем в прошлый раз (настройки терминала); без него — по умолчанию. */
    fibLevels?: readonly number[];
    /** «Линии до края» нового Фибоначчи — выбор в прошлый раз (настройки терминала); без него — продлённый. */
    fibExtend?: boolean;
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
/**
 * Панели под графиком (план 2A.7): сворачиваются до заголовка — 24 px, под пальцем 44 (цели касания); на телефоне
 * раскрыто не больше одной. Высоты по умолчанию — VIEW (индикатор 90, данные фьючерсов 80). Строк на все панели
 * не хватает — свёрнутые собираются в одну строку «ещё N панелей» (planPanes, ADR-0009).
 */
const PANE_COLLAPSED_PX = VIEW.desktop.paneCollapsedPx;
const PANE_COLLAPSED_COARSE_PX = VIEW.desktop.paneCollapsedTouchPx;
const PANE_INDICATOR_PX = VIEW.desktop.paneIndicatorPx;
const PANE_CRYPTO_PX = VIEW.desktop.paneDerivPx;
const NO_LIMITS: SepLimits = { minMain: 0, minPane: VIEW.desktop.paneMinPx, squeezedMin: PANE_COLLAPSED_PX, squeezed: false };
const NO_GEO: ChartGeo = { panes: [], plotW: 0, scaleW: 0, width: 0, limits: NO_LIMITS };
/** Сжатие планом ниже 1 на эту величину — уже сжатие (не погрешность деления). */
const SQUEEZE_EPS = 1e-6;
/** На телефоне раскрыта одна панель индикатора (последняя добавленная), остальные свёрнуты до заголовка. */
const MAX_EXPANDED_MOBILE = 1;
/** Свёртывание панелей на узком экране — по media query (lib/breakpoints) до D (PaneManager). */
const MOBILE_QUERY = MQ.mobile;
/** Формат шкалы индикатора на отдельной панели: объём и OBV — компактно, остальное — значения. */
const COMPACT_INDICATORS = new Set(["volume", "obv"]);
const indicatorFormat = (id: string): PriceFormat => (COMPACT_INDICATORS.has(id) ? COMPACT_FORMAT : VALUE_FORMAT);
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
export function ChartSurface({ candles, current, tf, type, indicators, markup, authed, store, device = "auto", layers, patterns, figures, alerts, external = NONE, derivatives, panels, tick, dataKey = "", onNeedOlder, drawings, onReady, corner, topRight, onAxisHeight, cards = null, legend, scale = "linear", overlay = null, paneLayout, onPaneLayout, onRemovePane, onInstanceParams, paneHint = false, live }: Props) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<ChartController | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const tfRef = useRef(tf);
  const panesRef = useRef<Map<string, Pane>>(new Map());
  const cryptoRef = useRef<Map<PanelKey, { paneIndex: number; series: ISeriesApi<"Line" | "Histogram">[] }>>(new Map());
  const drawPrimRef = useRef<DrawingsPrimitive | null>(null);
  const drawCtrlRef = useRef<DrawingController | null>(null);
  /**
   * Поле шкалы под карточку выбранного рисунка отложено: рисунок правят (мышью нажатие и выбирает, и тянет) — пересчёт
   * после отпускания (marginRev), а не под курсором.
   */
  const marginWaitRef = useRef(false);
  const [marginRev, setMarginRev] = useState(0);
  /** Шаг цены инструмента: стоп и цель новой позиции — по нему. */
  const tickRef = useRef<number | null>(null);
  const drawingsRef = useRef(drawings);
  const needOlderRef = useRef(onNeedOlder);
  const onReadyRef = useRef(onReady);
  /** Линии индикаторов по ключу `${uid}.${серия}`: значения на всех свечах буфера — для перекрестия и легенды. */
  const valuesRef = useRef<Map<string, SeriesValues>>(new Map());
  const stickyRef = useRef(false);
  /** Снять перекрестие (и липкий режим) — из эффектов вне создания графика. */
  const clearCrossRef = useRef<(() => void) | null>(null);
  /** Панели на экране (заголовки, границы, «A» у шкалы) — геометрия для PaneChrome. */
  const [geo, setGeo] = useState<ChartGeo>(NO_GEO);
  /** Колонка графика (.chart): PaneChrome следит по ней за курсором. */
  const [wrap, setWrap] = useState<HTMLDivElement | null>(null);
  /** «Развернуть»: панель на весь график, остальные — заголовки (временно, не сохраняется). */
  const [maximized, setMaximizedState] = useState<string | null>(null);
  const maxRef = useRef<string | null>(null);
  /** Раскладка панелей пользователя: из настроек владельца или своя на время жизни графика. */
  const [ownLayout, setOwnLayout] = useState<PaneLayout>(EMPTY_PANE_LAYOUT);
  const layout = paneLayout ?? ownLayout;
  const layoutRef = useRef(layout);
  const setLayoutRef = useRef<(l: PaneLayout) => void>(onPaneLayout ?? setOwnLayout);
  const indicatorsRef = useRef(indicators);
  const scaleRef = useRef(scale);
  /** Перетаскивание границы: высоты панелей в начале (px сверху вниз), пределы и сжатие окном. */
  const dragRef = useRef<{ heights: number[]; lim: SepLimits; k: number } | null>(null);
  const deviceNow = useChartStore((st) => st.status.device, store);
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
  /** Панели, свёрнутые пользователем (▾, свайп, телефон: раскрыта последняя добавленная). */
  const collapsedRef = useRef<Set<string>>(new Set());
  /**
   * Свёрнутые раскладкой: строк на все раскрытые не хватило (телефон боком). Пересчитываются при каждой раскладке и
   * в выбор пользователя и настройки не пишутся — место вернулось (поворот обратно, окно выше), панели снова раскрыты.
   */
  const forcedRef = useRef<Set<string>>(new Set());
  /** Когда панель раскрыли или добавили: при нехватке строк остаются последние раскрытые, а не нижние. */
  const rankRef = useRef<Map<string, number>>(new Map());
  const rankSeq = useRef(0);
  /** Свёрнутые панели в общей строке и панель, в которой эта строка лежит (последний план). */
  const groupRef = useRef<{ grouped: Set<string>; host: string | null }>({ grouped: new Set(), host: null });
  const layoutAllRef = useRef<() => void>(() => {});
  const relayoutRef = useRef<() => void>(() => {});
  const paneObsRef = useRef<ResizeObserver | null>(null);
  /** Подгрузка истории слева и смена темы — из хранилища графика (переходные поля до D). */
  const historyRev = useChartStore((st) => st.status.historyRev, store);
  const themeVersion = useChartStore((st) => st.status.themeVersion, store);
  /** Палец: подсказка объекта — закреплённая карточка внизу графика (план 2A.7); заголовки панелей — 44 px. */
  const [coarse] = useState(() => typeof window !== "undefined" && window.matchMedia(MQ.coarse).matches);
  const collapsedPx = coarse ? PANE_COLLAPSED_COARSE_PX : PANE_COLLAPSED_PX;
  /** Свёрнута ли панель: своим ▾, раскладкой (строк не хватило) или на время «развернуть» другой. */
  const isCollapsed = useCallback((key: string) => (maxRef.current ? key !== maxRef.current : collapsedRef.current.has(key) || forcedRef.current.has(key)), []);
  /** Что загружено в график: смена инструмента или таймфрейма — замена и сброс вида, иначе — дописывание. */
  const loadedRef = useRef<{ key: string; tf: Timeframe; candles: Candle[]; live: LiveSource; filled: boolean } | null>(null);

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

  /**
   * План панелей сейчас (PaneManager): «развернуть» — planMaximized; иначе planPanes — желаемые высоты (пользователя
   * или по умолчанию), свёрнутые пользователем, rank раскрытия, строка заголовка 24 / 44 px и доля основной устройства.
   * null — график не размечен.
   */
  const planNow = useCallback(
    (entries: ReturnType<typeof paneEntries>): PanePlan | null => {
      const term = termRef.current;
      if (!term) return null;
      const total = term.panesTotal();
      if (total <= 0) return null;
      const max = maxRef.current ? entries.findIndex((e) => e.key === maxRef.current) : -1;
      if (max >= 0) return planMaximized(total, entries.length, max, collapsedPx);
      return planPanes(
        total,
        entries.map((e) => ({ want: layoutRef.current.heights[e.key] ?? e.height, collapsed: collapsedRef.current.has(e.key), rank: rankRef.current.get(e.key) ?? 0 })),
        { mainMinShare: mainMinShareFor(store.getState().status.device), rowPx: collapsedPx },
      );
    },
    [store, collapsedPx],
  );

  /**
   * Пределы границ (ADR-0009): основная — доля устройства, панель — не ниже paneMinPx (под пальцем paneMinTouchPx);
   * k — сжатие окном (PanePlan.k): по нему высоты пары после перетаскивания пишутся в желаемых px.
   */
  const sepState = useCallback((): { lim: SepLimits; k: number } | null => {
    const term = termRef.current;
    if (!term) return null;
    const dev = store.getState().status.device;
    const share = mainMinShareFor(dev);
    const k = planNow(paneEntries())?.k ?? 1;
    const sum = term.paneHeights().reduce((a, b) => a + b, 0);
    return { k, lim: { minMain: sum * share, minPane: coarse ? VIEW[dev].paneMinTouchPx : VIEW[dev].paneMinPx, squeezedMin: collapsedPx, squeezed: k < 1 - SQUEEZE_EPS } };
  }, [store, planNow, paneEntries, coarse, collapsedPx]);

  const relayout = useCallback(() => {
    const el = ref.current;
    const term = termRef.current;
    if (!el || !term) return;
    const r0 = el.getBoundingClientRect();
    const box = (pel: HTMLElement | null | undefined) => {
      const r = pel?.getBoundingClientRect();
      return r ? { top: Math.round(r.top - r0.top), height: Math.round(r.height) } : { top: 0, height: 0 };
    };
    const chartPanes = term.chart.panes();
    const insts = new Map(indicatorsRef.current.map((i) => [i.uid, i] as const));
    const entries = paneEntries();
    const { grouped, host } = groupRef.current;
    // панель с общей строкой убрали — раскладка заново: иначе остальные свёрнутые остались бы полосками в 2 px без
    // строки и без кнопки раскрытия
    if (grouped.size > 0 && !entries.some((e) => e.key === host)) {
      layoutAllRef.current();
      requestAnimationFrame(() => relayoutRef.current());
      return;
    }
    const group = entries.filter((e) => grouped.has(e.key)).map((e) => ({ key: e.key, testId: e.testId, title: e.title }));
    const main = box(chartPanes[0]?.getHTMLElement());
    const panesGeo: PaneGeo[] = [
      { key: "main", index: 0, title: "", top: main.top, height: main.height, collapsed: maxRef.current !== null, testId: "main", values: false, compactValues: false, inst: null, manual: !term.paneAutoScale(0), scalable: scaleRef.current !== "percent" },
      ...entries.map((e) => {
        const pane = e.series[0]!.getPane();
        const inst = insts.get(e.key);
        const withParams = inst && (panesRef.current.get(e.key)?.spec.params.length ?? 0) > 0 ? inst : null;
        const g: Partial<PaneGeo> = grouped.has(e.key) ? { grouped: true, ...(e.key === host ? { group } : {}) } : {};
        return { key: e.key, index: pane.paneIndex(), title: e.title, ...box(pane.getHTMLElement()), collapsed: isCollapsed(e.key), color: e.color, testId: e.testId, values: e.values, compactValues: COMPACT_INDICATORS.has(e.testId), inst: withParams, manual: !term.paneAutoScale(pane.paneIndex()), scalable: true, ...g };
      }),
    ];
    const next: ChartGeo = { panes: panesGeo, plotW: Math.round(term.chart.timeScale().width()), scaleW: Math.round(term.chart.priceScale("right").width()), width: Math.round(r0.width), limits: sepState()?.lim ?? NO_LIMITS };
    setGeo((prev) => (sameGeo(prev, next) ? prev : next));
    const mainEl = chartPanes[0]?.getHTMLElement();
    if (mainEl) {
      const w = Math.round(term.chart.timeScale().width());
      const h = Math.round(mainEl.getBoundingClientRect().height);
      setMainBox((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
      const axisH = Math.round(term.chart.timeScale().height());
      if (axisH > 0 && axisH !== axisHRef.current) {
        axisHRef.current = axisH;
        onAxisHeightRef.current?.(axisH);
      }
    }
  }, [paneEntries, isCollapsed, sepState]);
  useLayoutEffect(() => {
    relayoutRef.current = relayout;
  }, [relayout]);

  /**
   * Все панели раскладываются разом (PaneManager, ADR-0009; продовый баг из PR 139: на телефоне свёрнутые панели сжимались
   * до 10 px, и их заголовки налезали друг на друга и на шкалу времени): свёрнутая — ровно строка заголовка 24 px
   * (под пальцем 44), раскрытые — высота пользователя или по умолчанию, а при нехватке места меньше, но не ниже строки;
   * свечам — остаток, не меньше доли устройства (десктоп 55 %, телефон 60 %). Строк на все панели не хватает —
   * свёрнутые собираются в одну строку «ещё N панелей», раньше раскрытые сворачиваются только на эту раскладку
   * (forcedRef). «Развернуть» — панель на всё (planMaximized).
   */
  const layoutAll = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    const entries = paneEntries();
    const plan = planNow(entries);
    if (plan && plan.others.length === entries.length) {
      forcedRef.current = new Set(plan.collapse.map((k) => entries[k]!.key));
      groupRef.current = { grouped: new Set(entries.filter((_, k) => plan.grouped[k]).map((e) => e.key)), host: plan.host === null ? null : entries[plan.host]!.key };
    }
    // серии свёрнутых панелей и метки их последних значений скрыты (иначе «0.0» и огромные числа OI на шкале)
    for (const e of entries) {
      const collapsed = isCollapsed(e.key);
      const hidden = panesRef.current.get(e.key)?.hidden ?? false;
      e.series.forEach((sr) => sr.applyOptions({ visible: !collapsed && !hidden, lastValueVisible: !collapsed && sr.seriesType() === "Line" }));
    }
    if (plan) term.applyPanePlan(plan);
  }, [paneEntries, planNow, isCollapsed]);
  useLayoutEffect(() => {
    layoutAllRef.current = layoutAll;
  }, [layoutAll]);

  // порядок панелей: сохранённые — на своих местах, новые — внизу (основная — всегда первая)
  const applyOrder = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    const entries = paneEntries();
    const want = orderPaneKeys(
      entries.map((e) => e.key),
      layoutRef.current.order,
    );
    want.forEach((key, j) => {
      const e = entries.find((x) => x.key === key);
      if (e) term.movePane(e.series[0]!.getPane(), j + 1);
    });
  }, [paneEntries]);

  // раскрытая панель — последняя по времени: при нехватке строк сворачиваются раньше раскрытые, а не она (иначе кнопка
  // в общей строке ничего не делала бы)
  const applyCollapsed = useCallback(
    (key: string, collapsed: boolean) => {
      if (!paneEntries().some((x) => x.key === key)) return;
      if (collapsed) collapsedRef.current.add(key);
      else {
        collapsedRef.current.delete(key);
        rankRef.current.set(key, ++rankSeq.current);
      }
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
      rankRef.current.set(key, ++rankSeq.current);
      if (window.matchMedia(MOBILE_QUERY).matches) {
        const open = paneEntries().filter((e) => e.key !== key && !collapsedRef.current.has(e.key));
        for (const e of open.slice(0, Math.max(0, open.length + 1 - MAX_EXPANDED_MOBILE))) collapsedRef.current.add(e.key);
      }
      applyOrder();
      layoutAll();
      requestAnimationFrame(relayout);
    },
    [paneEntries, relayout, layoutAll, applyOrder],
  );

  // панель убрали (индикатор или панель данных фьючерсов выключены): её состояние забывается; раскладку заново
  // делают ветки удаления (layoutAll), а relayout проверяет, что общая строка не пропала вместе с панелью
  const paneRemoved = useCallback((key: string) => {
    collapsedRef.current.delete(key);
    forcedRef.current.delete(key);
    rankRef.current.delete(key);
  }, []);

  const setMaximized = useCallback(
    (key: string | null) => {
      maxRef.current = key;
      setMaximizedState(key);
      layoutAll();
      requestAnimationFrame(relayout);
    },
    [layoutAll, relayout],
  );
  /** ▾ / ▴ и свайп: из режима «развернуть» — сначала вернуть панели. */
  const onCollapse = useCallback(
    (key: string, collapsed: boolean) => {
      if (maxRef.current) {
        maxRef.current = null;
        setMaximizedState(null);
      }
      applyCollapsed(key, collapsed);
    },
    [applyCollapsed],
  );
  /** «выше» / «ниже»: новый порядок — в раскладку пользователя (применяет эффект раскладки). */
  const onMovePane = useCallback(
    (key: string, dir: -1 | 1) => {
      const next = movePaneKey(
        paneEntries().map((e) => e.key),
        key,
        dir,
      );
      if (next) setLayoutRef.current({ ...layoutRef.current, order: next });
    },
    [paneEntries],
  );
  /**
   * Граница панелей: в начале — высоты всех панелей, пределы и сжатие окном; при движении — пара у границы
   * (dragSeparator); в конце — в раскладку пользователя только эта пара, в желаемых px (commitPaneHeights: ÷ сжатие),
   * остальные панели — как были (без сдвига — ничего).
   */
  const onResize = useCallback(
    (sep: PaneSep, dy: number, phase: ResizePhase) => {
      const term = termRef.current;
      if (!term) return;
      if (phase === "start" || !dragRef.current) {
        const st = sepState();
        if (!st) return;
        dragRef.current = { heights: term.paneHeights(), ...st };
      }
      const d = dragRef.current;
      const next = dragSeparator(d.heights, sep.above, sep.below, dy, d.lim);
      if (phase === "start") return;
      term.applyPanePlan({ main: next[0]!, others: next.slice(1) });
      requestAnimationFrame(relayout);
      if (phase !== "end") return;
      dragRef.current = null;
      if (next.every((h, i) => Math.abs(h - d.heights[i]!) < 0.5)) return;
      const entries = paneEntries();
      const keyAt = (i: number) => entries.find((e) => e.series[0]!.getPane().paneIndex() === i)?.key ?? null;
      const heights = commitPaneHeights(
        layoutRef.current.heights,
        [
          [keyAt(sep.above), next[sep.above]!],
          [keyAt(sep.below), next[sep.below]!],
        ],
        d.k,
      );
      setLayoutRef.current({ ...layoutRef.current, heights });
    },
    [relayout, paneEntries, sepState],
  );
  /** Двойной клик по границе: высоты по умолчанию (порядок остаётся). */
  const onResetHeights = useCallback(() => {
    if (Object.keys(layoutRef.current.heights).length > 0) setLayoutRef.current({ ...layoutRef.current, heights: {} });
    else {
      layoutAll();
      requestAnimationFrame(relayout);
    }
  }, [layoutAll, relayout]);
  /** «A»: вернуть автомасштаб шкалы цены панели. */
  const onAutoScale = useCallback(
    (index: number) => {
      termRef.current?.setPaneAutoScale(index, true);
      requestAnimationFrame(relayout);
    },
    [relayout],
  );
  const onRemove = useCallback(
    (key: string) => {
      if (maxRef.current === key) setMaximized(null);
      onRemovePane?.(key);
    },
    [onRemovePane, setMaximized],
  );

  useEffect(() => {
    needOlderRef.current = onNeedOlder;
    drawingsRef.current = drawings;
    tfRef.current = tf;
    onReadyRef.current = onReady;
    onAxisHeightRef.current = onAxisHeight;
    indicatorsRef.current = indicators;
    scaleRef.current = scale;
    setLayoutRef.current = onPaneLayout ?? setOwnLayout;
  }, [onNeedOlder, drawings, tf, onReady, onAxisHeight, indicators, scale, onPaneLayout]);

  // раскладка пользователя (порядок, высоты) сменилась: переставить и разложить панели заново
  useEffect(() => {
    layoutRef.current = layout;
    applyOrder();
    layoutAll();
    requestAnimationFrame(relayout);
  }, [layout, applyOrder, layoutAll, relayout]);

  // устройство сменилось (доля основной панели) или шкала — разложить заново и перечитать «A»
  useEffect(() => {
    layoutAll();
    requestAnimationFrame(relayout);
  }, [deviceNow, scale, layoutAll, relayout]);

  // создание контроллера (терминал, разметка, тема, вид) и рисунков
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ctrl = new ChartController({ container: el, store, device, type, onNeedOlder: (before) => needOlderRef.current(before) });
    const term = ctrl.terminal;
    ctrlRef.current = ctrl;
    termRef.current = term;
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
    clearCrossRef.current = clearCrosshair;
    onReadyRef.current?.({ zoom: ctrl.handle.zoom, reset: ctrl.handle.reset, clearCrosshair, focus: ctrl.handle.focus, snapshot: ctrl.handle.snapshot });
    const prim = new DrawingsPrimitive(tokensFromElement(el));
    prim.touch = typeof window !== "undefined" && window.matchMedia(MQ.coarse).matches;
    // измеритель: ход в ATR(14) — по закрытым свечам графика
    prim.candles = () => term.candles;
    drawPrimRef.current = prim;
    term.layers.add(new PrimitiveLayer("drawings", prim));
    const dctrl = new DrawingController(
      el,
      // не prim.projector: при смене типа графика серия и проектор пересоздаются, контроллер остаётся
      prim.live,
      {
        getDrawings: () => {
          const d = drawingsRef.current;
          return d ? visibleOn(d.state, tfRef.current) : [];
        },
        getCandles: () => term.candles,
        tfSeconds: TF_SECONDS[tfRef.current],
        getTfSeconds: () => TF_SECONDS[tfRef.current],
        getTick: () => tickRef.current,
        timeframe: null,
        touch: prim.touch,
        magnet: true,
        newId: () => `d_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
        getSelectedId: () => drawingsRef.current?.state.selectedId ?? null,
        getFibLevels: () => drawingsRef.current?.fibLevels,
        getFibExtend: () => drawingsRef.current?.fibExtend,
      },
      {
        onCreate: (d) => drawingsRef.current?.onCreate(d),
        onMove: (id, pts, final, origin) => drawingsRef.current?.onMove(id, pts, final, origin),
        onSelect: (id) => drawingsRef.current?.onSelect(id),
        onDraft: (d) => drawingsRef.current?.onDraft(d),
        onStep: (n) => drawingsRef.current?.onStep(n),
        onDone: (ended) => drawingsRef.current?.onToolDone(ended),
        // измеритель временный (план 2A.5): не рисунок — только на графике, без состояния рисунков и синхронизации
        onRuler: (d) => prim.update({ ruler: d }),
        onEditEnd: () => {
          if (!marginWaitRef.current) return;
          marginWaitRef.current = false;
          setMarginRev((r) => r + 1);
        },
      },
    );
    drawCtrlRef.current = dctrl;
    // подписи рисунков — в общей раскладке с подписями разметки: разметка их обходит, они не ложатся на неё
    ctrl.setDrawingLabels((measure) => prim.labelCandidates(measure));
    prim.linked = () => ctrl.drawingLabels();
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
    // высота графика сменилась (поворот телефона, окно) — панели раскладываются заново: иначе LWC делит высоту
    // пропорционально и свёрнутые панели сжимаются ниже строки заголовка; свёрнутые раскладкой панели при этом снова
    // раскрываются, если место вернулось
    let lastH = el.clientHeight;
    const paneObs = new ResizeObserver(() => {
      if (el.clientHeight !== lastH) {
        lastH = el.clientHeight;
        requestAnimationFrame(() => {
          layoutAllRef.current();
          requestAnimationFrame(() => relayoutRef.current());
        });
      }
      relayoutRef.current();
    });
    paneObs.observe(el);
    paneObsRef.current = paneObs;
    // шкалу цены растянули или вернули (перетаскивание, двойной клик, сброс вида): «A» — по новому состоянию
    let scaleRaf = 0;
    const recheck = () => {
      cancelAnimationFrame(scaleRaf);
      scaleRaf = requestAnimationFrame(() => relayoutRef.current());
    };
    window.addEventListener("pointerup", recheck, true);
    el.addEventListener("dblclick", recheck);
    const panes = panesRef.current;
    const crypto = cryptoRef.current;
    const forced = forcedRef.current;
    return () => {
      paneObs.disconnect();
      paneObsRef.current = null;
      window.removeEventListener("pointerup", recheck, true);
      el.removeEventListener("dblclick", recheck);
      cancelAnimationFrame(scaleRaf);
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
      // панели уничтожены вместе с графиком: раскладка нового графика посчитает свёрнутые раскладкой заново
      forced.clear();
      groupRef.current = { grouped: new Set(), host: null };
      dctrl.destroy();
      drawCtrlRef.current = null;
      clearCrossRef.current = null;
      drawPrimRef.current = null;
      ctrl.destroy();
      ctrlRef.current = null;
      termRef.current = null;
      onReadyRef.current?.(null);
    };
    // тип меняется через setType ниже, хранилище и класс устройства у поверхности постоянны
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // данные: график меняет только подписчик живой свечи (ниже); здесь — лишь замена при смене инструмента или
  // таймфрейма и на первых данных, по снимку live (история и текущая — без отставания состояния React; сброс вида).
  // Остальные изменения свечей React для графика — ничто (иначе текущая откатывалась бы к состоянию React, которое
  // обновляется раз в 5 с); масштаб, прокрутка и подгруженная слева история пользователя сохраняются (план 2A.7)
  useEffect(() => {
    const term = termRef.current;
    const ctrl = ctrlRef.current;
    if (!term || !ctrl) return;
    const prev = loadedRef.current;
    const same = prev !== null && prev.key === dataKey && prev.tf === tf;
    // другой инструмент или таймфрейм — измерение прежнего убрано
    if (!same) drawCtrlRef.current?.clearRuler();
    if (same && prev.candles.length === 0 && candles.length === 0) return;
    if (same && prev.live === live && prev.filled) {
      loadedRef.current = { ...prev, candles };
      return;
    }
    // свечи — только из снимка этой live: React-свечи в этот момент могут быть ещё прежнего инструмента
    const snap = live.snapshot();
    const all = snap.bar ? [...snap.closed, snap.bar] : snap.closed.slice();
    if (same && prev.live === live && all.length === 0) return;
    loadedRef.current = { key: dataKey, tf, candles, live, filled: all.length > 0 };
    // таймфрейм — до данных: сброс вида считает число свечей по лимиту таймфрейма. Шаг цены приходит в том же ответе,
    // что и свечи: формат шкалы — тоже до них (замена применяет его сразу), иначе первый кадр с новыми свечами
    // размечен прежним форматом, шкала цены кадром позже меняет ширину, и вид перестраивается ещё раз
    ctrl.set({ tf, tick });
    term.setCandles(all, true);
    ctrl.notifyCandles("replace");
    syncModel();
  }, [candles, tf, tick, dataKey, syncModel, live]);

  // живая свеча — единственный путь живых изменений графика (ADR-0010): закрытые — дописать, уточнённую — заменить
  // (Terminal.amend), текущую — обновить; догон — хвост с первой изменённой свечи (Terminal.replaceTail: устаревшая
  // текущая уходит, подгруженная слева история и вид остаются) или замена целиком. События, пока график держит не
  // свечи этой live (другой инструмент или таймфрейм, данных ещё нет), не применяются: замена по снимку их уже учтёт
  useEffect(() => {
    return live.subscribe((step) => {
      const term = termRef.current;
      const ctrl = ctrlRef.current;
      const loaded = loadedRef.current;
      if (!term || !ctrl || loaded?.live !== live || !loaded.filled) return;
      if (step.reset) {
        term.setCandles(step.reset.candles, step.reset.hasOlder);
        ctrl.notifyCandles("replace");
        syncModel();
        return;
      }
      if (step.tail) {
        term.replaceTail(step.tail.from, step.tail.bars);
        ctrl.notifyCandles("append");
        syncModel();
        return;
      }
      for (const c of step.closed) term.update(c);
      if (step.amended) term.amend(step.amended);
      if (step.bar) term.update(step.bar);
      ctrl.notifyCandles(step.closed.length || step.amended ? "append" : "tick");
      if (step.closed.length) syncModel();
    });
  }, [live, syncModel]);

  // формат цены инструмента (шкала и деления под метками — в контроллере) и подписи рисунков
  useEffect(() => {
    ctrlRef.current?.set({ tick });
    drawPrimRef.current?.update({ precision: tickPrecision(tick) });
    const n = tick === null ? NaN : Number(tick);
    tickRef.current = n > 0 ? n : null;
  }, [tick]);

  // тексты плашек позиции и измерителя на холсте — на языке интерфейса
  const drawText: DrawingText = useMemo(() => drawingText(t), [t]);
  const drawProfile = drawings?.profile ?? null;
  useEffect(() => {
    drawPrimRef.current?.update({ text: drawText, profile: drawProfile });
  }, [drawText, drawProfile]);

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
    // инструмент — только смена его в состоянии: эффект прежней отрисовки (начатый рисунок под курсором) выполняется и
    // после того, как контроллер закончил рисунок и снял инструмент сам, — он не возвращает инструмент и не убирает
    // готовое измерение (DrawingController.syncTool)
    dctrl.syncTool(drawings?.tool ?? null);
    dctrl.setMagnet(drawings?.magnet ?? true);
    dctrl.setSeries(drawings?.series ?? false);
  }, [drawings, tf]);

  // инструмент рисования выбран (ADR-0009, «Рисование»): долгое касание, которым ставят точку, включает у LWC режим
  // перекрестия, а выходит он по умолчанию следующим касанием — оно уже уходит рисунку и до LWC не доходит, и сдвиги
  // «застревали» в перекрестии. С инструментом режим кончается с отпусканием пальца; липкое перекрестие и карточка
  // свечи при выборе инструмента убираются
  const drawTool = drawings?.tool ?? null;
  useEffect(() => {
    const chart = termRef.current?.chart;
    if (!chart) return;
    if (drawTool) {
      clearCrossRef.current?.();
      chart.applyOptions({ trackingMode: { exitMode: TrackingModeExitMode.OnTouchEnd } });
      return;
    }
    // инструмент снят отпусканием, которое поставило последнюю точку: touchend этого касания идёт следом в той же
    // задаче, что pointerup, — прежний выход (следующим касанием) возвращается после него
    const id = setTimeout(() => chart.applyOptions({ trackingMode: { exitMode: TrackingModeExitMode.OnNextTap } }), 0);
    return () => clearTimeout(id);
  }, [drawTool]);

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
    let removed = false;
    for (const [uid, pane] of panesRef.current) {
      const next = want.get(uid);
      if (!next || next.id !== pane.spec.id) {
        Object.values(pane.series).forEach((sr) => term.removeSeries(sr));
        panesRef.current.delete(uid);
        if (pane.paneIndex !== null) paneRemoved(uid);
        if (maxRef.current === uid) {
          maxRef.current = null;
          queueMicrotask(() => setMaximizedState(null));
        }
        removed = true;
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
        const collapsed = pane.paneIndex !== null && isCollapsed(ind.uid);
        Object.values(pane.series).forEach((sr) => sr.applyOptions({ visible: !hidden && !collapsed }));
      }
      // параметры из сохранения могли быть записаны до проверки связей (MACD: быстрая ≥ медленной) — приводим здесь же;
      // ошибка расчёта одного индикатора оставляет его панель пустой, а не роняет весь график
      let out: ReturnType<typeof spec.compute> = {};
      try {
        out = spec.compute(all, clampParams(spec, { ...defaultParams(spec), ...ind.params }));
      } catch {
        out = {};
      }
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
    // убранная панель отдала место: остальные — по раскладке (высоты пользователя, доля основной)
    if (removed) layoutAll();
    requestAnimationFrame(relayout);
  }, [indicators, candles, current, historyRev, themeVersion, paneAdded, paneRemoved, relayout, store, t, isCollapsed, layoutAll]);

  // крипто-панели (план 2A.4): funding, OI, ликвидации — данные с сервера. Ставятся только после свечей и
  // только на время свечей (alignToCandles): точка левее первой свечи или между свечами меняла шкалу времени,
  // и с панелью OI график открывался на 84 дня в прошлом
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const tokens = tokensFromElement(ref.current!);
    const want = new Set(panels);
    let removedPanel = false;
    for (const [k, p] of cryptoRef.current) {
      if (!want.has(k)) {
        p.series.forEach((sr) => term.removeSeries(sr));
        cryptoRef.current.delete(k);
        paneRemoved(k);
        if (maxRef.current === k) {
          maxRef.current = null;
          queueMicrotask(() => setMaximizedState(null));
        }
        removedPanel = true;
      }
    }
    if (removedPanel) {
      layoutAll();
      requestAnimationFrame(relayout);
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
  }, [derivatives, panels, candles, historyRev, themeVersion, tf, paneAdded, paneRemoved, relayout, layoutAll]);

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

  // верхнее поле шкалы цены — под легенду (план 2B.9 §10): не больше 35 % панели, под пальцем — 20 % (legendFit); свечи
  // не рисуются под строками легенды без раскрытия, раскрытая ложится поверх самых старых свечей
  useLayoutEffect(() => {
    const term = termRef.current;
    if (!term || !mainBox || mainBox.h <= 0) return;
    term.setTopMargin(legendTopMargin(legendBottom, mainBox.h, coarse));
  }, [legendBottom, mainBox, coarse]);
  const mainH = mainBox?.h ?? 0;
  const fit = useMemo(() => (mainH > 0 ? legendFit(mainH, coarse) : null), [mainH, coarse]);

  // карточки поверх графика: прямоугольники в координатах графика, по изменению размера (раскрыли, другой рисунок)
  const [cardBoxes, setCardBoxes] = useState<readonly { x: number; y: number; w: number; h: number }[]>(NONE);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!cards || !el) {
      setCardBoxes(NONE);
      return;
    }
    const measure = () => {
      const r0 = el.getBoundingClientRect();
      const next = [...cards.children]
        .map((c) => c.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0)
        .map((r) => ({ x: Math.round(r.left - r0.left), y: Math.round(r.top - r0.top), w: Math.round(r.width), h: Math.round(r.height) }));
      setCardBoxes((prev) => (prev.length === next.length && prev.every((p, i) => p.x === next[i]!.x && p.y === next[i]!.y && p.w === next[i]!.w && p.h === next[i]!.h) ? prev : next.length ? next : NONE));
    };
    measure();
    const ro = new ResizeObserver(measure);
    const watch = () => {
      ro.disconnect();
      ro.observe(cards);
      for (const c of cards.children) ro.observe(c);
    };
    watch();
    const mo = new MutationObserver(() => {
      watch();
      measure();
    });
    mo.observe(cards, { childList: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [cards, mainBox]);

  // выбранный рисунок не прячется под карточкой (ADR-0009, «Рисование», дополнение 2026-11-12): нижняя точка рисунка
  // под карточкой (на телефоне — раскрытые «уровни» Фибоначчи, «параметры» позиции) — нижнее поле шкалы цены растёт
  // настолько, чтобы рисунок был над ней; свернули карточку или сняли выбор — поле прежнее. Пересчёт — при выборе,
  // раскрытии карточки и правке уровней, но не при перетаскивании точки: поле, растущее за точкой, уводило бы её из-под
  // пальца. Мышью нажатие по рисунку и выбирает его, и сразу тянет: появившаяся карточка не меняет шкалу под курсором —
  // пересчёт после отпускания
  const drawState = drawings?.state;
  const selected = useMemo(() => (drawState?.selectedId ? (visibleOn(drawState, tf).find((d) => d.id === drawState.selectedId) ?? null) : null), [drawState, tf]);
  const selectedRef = useRef(selected);
  useLayoutEffect(() => {
    selectedRef.current = selected;
  });
  const selectedKey = selected ? `${selected.id} ${selected.levels?.join(",") ?? ""}` : null;
  useLayoutEffect(() => {
    const term = termRef.current;
    const pr = drawPrimRef.current?.projector;
    const cur = selectedRef.current;
    if (!term || !mainBox || mainBox.h <= 0) return;
    if (drawCtrlRef.current?.editing) {
      marginWaitRef.current = true;
      return;
    }
    const sel = selectedKey && cur && pr ? drawingExtent(cur, pr.projector()) : null;
    term.setBottomMargin(cardBottomMargin(cardBoxes, mainBox, sel, { top: term.topMarginShare, bottom: term.bottomMarginShare }));
  }, [selectedKey, cardBoxes, mainBox, scale, marginRev]);

  // угол графика, чип справа сверху, легенда, «A» и карточки — препятствия для подписей разметки и рисунков (координаты
  // основной панели, CSS px)
  const mainGeo = geo.panes[0];
  const mainAuto = mainGeo?.manual && !mainGeo.collapsed ? autoBox(mainGeo, geo.plotW, coarse) : null;
  const [autoL, autoT, autoS] = mainAuto ? [mainAuto.left, mainAuto.top, mainAuto.size] : [0, 0, 0];
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
    // «A» у шкалы основной панели, растянутой вручную, — в её правом нижнем углу (PaneChrome, autoBox)
    if (autoS > 0) rects.push({ x: autoL, y: autoT, w: autoS, h: autoS });
    rects.push(...cardBoxes);
    ctrl.set({ uiObstacles: rects.length ? rects : NONE });
  }, [hasCorner, hasTopRight, mainBox, legendBox, autoL, autoT, autoS, cardBoxes]);

  return (
    <div ref={setWrap} className={s.chart}>
      <div ref={ref} className={s.canvas} data-testid="terminal" />
      {corner && mainBox && !maximized && (
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
      {mainBox && !maximized && <HistoryEdgeNote store={store} h={mainBox.h} />}
      {legend ? (
        // «развернуть» другую панель: основная — заголовок, легенда скрыта (иначе она легла бы на развёрнутую панель)
        <div ref={legendRef} className={c.legendHost} hidden={maximized !== null}>
          <LegendFitContext.Provider value={fit}>{legend}</LegendFitContext.Provider>
        </div>
      ) : (
        device !== "cell" && (
          <>
            <LegendChip store={store} />
            <LiqUnavailableNote store={store} on={resolvePreset(markup, "desktop", { authed }).layers.liq_map} />
          </>
        )
      )}
      <PaneChrome
        host={wrap}
        store={store}
        geo={geo}
        maximized={maximized}
        compact={deviceNow !== "desktop"}
        hint={paneHint}
        mainTitle={dataKey || t("Цена")}
        onCollapse={onCollapse}
        onMove={onMovePane}
        onMaximize={setMaximized}
        onRemove={onRemovePane ? onRemove : undefined}
        onParams={onInstanceParams}
        onResize={onResize}
        onResetHeights={onResetHeights}
        onAutoScale={onAutoScale}
      />
      {candles.length === 0 && <div className={s.empty}>{t("Нет свечей.")}</div>}
    </div>
  );
}

/** Геометрия панелей та же: PaneChrome не перерисовывается на каждом ResizeObserver. */
function sameGeo(a: ChartGeo, b: ChartGeo): boolean {
  if (a.plotW !== b.plotW || a.scaleW !== b.scaleW || a.width !== b.width || a.panes.length !== b.panes.length) return false;
  const la = a.limits;
  const lb = b.limits;
  if (Math.round(la.minMain) !== Math.round(lb.minMain) || la.minPane !== lb.minPane || la.squeezedMin !== lb.squeezedMin || la.squeezed !== lb.squeezed) return false;
  return a.panes.every((p, i) => {
    const q = b.panes[i]!;
    return p.key === q.key && p.index === q.index && p.title === q.title && p.top === q.top && p.height === q.height && p.collapsed === q.collapsed && p.color === q.color && p.manual === q.manual && p.scalable === q.scalable && p.inst === q.inst && p.values === q.values && !!p.grouped === !!q.grouped && groupKey(p) === groupKey(q);
  });
}

/** Состав общей строки свёрнутых панелей (у host): ключи и имена. */
const groupKey = (p: PaneGeo): string => p.group?.map((g) => `${g.key}:${g.title}`).join("|") ?? "";

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
