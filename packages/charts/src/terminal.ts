import type { IChartApi, ISeriesApi, LogicalRange, PriceFormat, SeriesType, Time, UTCTimestamp } from "lightweight-charts";
import { BarSeries, CandlestickSeries, HistogramSeries, LineSeries, PriceScaleMode, createChart, type IPaneApi } from "lightweight-charts";

/** Режим ценовой шкалы (план 2A.3): линейная, логарифмическая, процентная (для сравнения инструментов). */
export type ScaleMode = "linear" | "log" | "percent";
const SCALE_MODES: Record<ScaleMode, PriceScaleMode> = { linear: PriceScaleMode.Normal, log: PriceScaleMode.Logarithmic, percent: PriceScaleMode.Percentage };
const OVERLAY_SCALE = "overlay";
import { createBuffer, EDGE, needsNewer, needsOlder, prependOlder, pushLatest, replaceNewest, type BufferState } from "./buffer";
import { heikinAshi } from "./heikin";
import { LayerManager } from "./layers";
import { chartOptions, RIGHT_OFFSET, seriesColors } from "./theme";
import type { Candle, ChartType, ThemeTokens } from "./types";

export type TerminalOptions = {
  tokens: ThemeTokens;
  type?: ChartType;
  /** Запрос старых свечей: до времени (unix с), штук. Ответ — через terminal.addOlder(). */
  onNeedOlder?: (before: number) => void;
  /** Запрос свежих свечей после выгрузки правого края. Ответ — terminal.replaceNewest(). */
  onNeedNewer?: () => void;
  onVisibleRange?: (range: LogicalRange | null) => void;
};

export type PaneSeries = ISeriesApi<"Line" | "Histogram">;

/**
 * Обёртка над Lightweight Charts v5 (план 2A.2, 2B.2): основная серия (свечи / бары / линия / HA),
 * объём внизу основной панели, дополнительные панели для индикаторов, буфер свечей с ленивой подгрузкой,
 * тема из токенов, слои. Без React — его обёртка живёт в apps/web.
 */
const MIN_STRETCH = 0.01;
/** Главной панели (свечам) — не меньше половины высоты, сколько бы индикаторов ни добавили. */
const MAIN_MIN_SHARE = 0.5;
/** Масштаб колесом: множитель на пиксель deltaY (300 px ≈ ×2.1); с Ctrl/⌘ (pinch) — втрое сильнее. */
const WHEEL_ZOOM = 0.0025;
/** Прокрутка горизонтальным жестом: доля «один пиксель — один бар». */
const WHEEL_SCROLL = 0.6;
const MIN_VISIBLE_BARS = 10;
/** Объём занимает нижние 14 % основной панели и не налезает на свечи. */
const VOLUME_TOP = 0.86;
/** Целевой шаг бара при сбросе вида (план 2A.7): около 8 px на десктопе, около 6 px на телефоне. */
export const VIEW_BAR_PX = { desktop: 8, phone: 6 } as const;
/** Сколько свечей показывать при сбросе вида: не меньше и не больше, какой бы ни была ширина. */
export const VIEW_MIN_BARS = 40;
export const VIEW_MAX_BARS = 150;
/** Ширина области ещё неизвестна (график не размечен) — столько свечей. */
const VIEW_FALLBACK_BARS = 100;
/** Формат цены до того, как известен шаг инструмента (как у LWC по умолчанию). */
const DEFAULT_PRICE_FORMAT: PriceFormat = { type: "price", precision: 2, minMove: 0.01 };
/** Размер шрифта шкал по умолчанию (как в chartOptions); на телефоне TerminalView ставит мельче. */
const DEFAULT_FONT_PX = 11;

/**
 * Сколько свечей показать при сбросе вида: ширина области графика / целевой шаг бара минус пустые бары
 * справа, в пределах VIEW_MIN_BARS…VIEW_MAX_BARS. Не фиксированные 150: на телефоне это 2 px на свечу.
 */
export function barsForWidth(width: number, barPx: number, rightOffset = RIGHT_OFFSET): number {
  if (!(width > 0) || !(barPx > 0)) return VIEW_FALLBACK_BARS;
  return Math.min(VIEW_MAX_BARS, Math.max(VIEW_MIN_BARS, Math.round(width / barPx) - rightOffset));
}

export class Terminal {
  readonly chart: IChartApi;
  readonly layers = new LayerManager();
  private main: ISeriesApi<SeriesType>;
  private volume: ISeriesApi<"Histogram">;
  private type: ChartType;
  private buffer: BufferState = createBuffer([], true);
  private tokens: ThemeTokens;
  private readonly opts: TerminalOptions;
  private requesting = false;
  /**
   * Подгрузка слева «взведена»: одна порция на один подход к краю. После запроса снова взводится,
   * только когда левый край вида ушёл от края буфера дальше EDGE (сдвиг после вставки порции тоже считается).
   */
  private edgeArmed = true;
  private priceFormat: PriceFormat = DEFAULT_PRICE_FORMAT;
  /** Серии на шкале цены основной панели (наложенные индикаторы): у них формат цены инструмента. */
  private readonly priceSeries = new Set<ISeriesApi<SeriesType>>();
  private panes = 1;
  private scaleMode: ScaleMode = "linear";
  private overlay: ISeriesApi<"Line"> | null = null;
  /** Свечи наложенного инструмента целиком; на графике — только на времени свечей буфера (см. overlayData). */
  private overlayCandles: readonly Candle[] = [];
  private fontSize = DEFAULT_FONT_PX;
  private readonly container: HTMLElement;

  constructor(container: HTMLElement, opts: TerminalOptions) {
    this.opts = opts;
    this.tokens = opts.tokens;
    this.type = opts.type ?? "candles";
    this.chart = createChart(container, { ...chartOptions(opts.tokens), autoSize: true });
    this.container = container;
    container.addEventListener("wheel", this.onWheel, { passive: false });
    this.main = this.createMain(this.type);
    this.volume = this.chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "", lastValueVisible: false, priceLineVisible: false });
    this.volume.priceScale().applyOptions({ scaleMargins: { top: VOLUME_TOP, bottom: 0 } });
    this.layers.attach({ chart: this.chart, main: this.main });
    this.chart.timeScale().subscribeVisibleLogicalRangeChange((r) => this.onRange(r));
  }

  private createMain(type: ChartType): ISeriesApi<SeriesType> {
    const c = seriesColors(this.tokens);
    const priceFormat = this.priceFormat;
    if (type === "bars") return this.chart.addSeries(BarSeries, { ...c.bars, priceFormat });
    if (type === "line") return this.chart.addSeries(LineSeries, { ...c.line, priceFormat });
    return this.chart.addSeries(CandlestickSeries, { ...c.candles, priceFormat });
  }

  /**
   * Формат цены инструмента (точность и минимальный шаг из шага цены): основной серии и наложенным
   * индикаторам. Без minMove = шагу LWC оставляет 0.01, и у монет дешевле цента нет ни делений, ни сетки.
   * Сохраняется и для серии, пересозданной при смене типа графика.
   */
  setPriceFormat(format: PriceFormat): void {
    this.priceFormat = format;
    this.main.applyOptions({ priceFormat: format });
    for (const s of this.priceSeries) s.applyOptions({ priceFormat: format });
  }

  get chartType(): ChartType {
    return this.type;
  }

  /** Основная серия — для примитивов слоёв и маркеров. */
  get mainSeries(): ISeriesApi<SeriesType> {
    return this.main;
  }

  get candles(): readonly Candle[] {
    return this.buffer.candles;
  }

  /** Переключение типа графика: данные и слои сохраняются. */
  setType(type: ChartType): void {
    if (type === this.type) return;
    const range = this.chart.timeScale().getVisibleLogicalRange();
    this.layers.detachAll();
    this.chart.removeSeries(this.main);
    this.type = type;
    this.main = this.createMain(type);
    this.render();
    this.layers.attach({ chart: this.chart, main: this.main });
    if (range) this.chart.timeScale().setVisibleLogicalRange(range);
  }

  /**
   * Размер шрифта шкал (на телефоне мельче). Хранится в Terminal: смена темы заново применяет chartOptions,
   * и без этого шкалы возвращались к 11 px до смены инструмента.
   */
  setFontSize(px: number): void {
    this.fontSize = px;
    this.chart.applyOptions({ layout: { fontSize: px } });
  }

  setTheme(tokens: ThemeTokens): void {
    this.tokens = tokens;
    const o = chartOptions(tokens);
    this.chart.applyOptions({ ...o, layout: { ...o.layout, fontSize: this.fontSize } });
    const c = seriesColors(tokens);
    if (this.type === "bars") this.main.applyOptions(c.bars);
    else if (this.type === "line") this.main.applyOptions(c.line);
    else this.main.applyOptions(c.candles);
    this.render();
  }

  /** Полная история (последняя порция). hasOlder — есть ли ещё слева. Вид не трогает: сброс — resetView. */
  setCandles(candles: Candle[], hasOlder = true): void {
    this.buffer = createBuffer(candles, hasOlder);
    this.requesting = false;
    this.edgeArmed = true;
    this.render();
  }

  /**
   * Порция старых свечей слева. Вид остаётся на тех же свечах: логические индексы сдвигаются на число
   * добавленных баров, и диапазон сдвигается вместе с ними (раньше он оставался на тех же номерах,
   * т. е. на N баров левее, снова у края — и подгрузка шла каскадом до 2022 года).
   */
  addOlder(older: Candle[], hasOlder: boolean): void {
    const anchor = this.buffer.candles[0]?.time;
    this.buffer = prependOlder(this.buffer, older, hasOlder);
    this.requesting = false;
    this.renderAnchored(anchor);
  }

  /** Запрос старых свечей не удался или устарел: можно просить снова — после нового подхода к краю. */
  olderFailed(): void {
    this.requesting = false;
  }

  replaceNewest(newest: Candle[]): void {
    const anchor = this.buffer.candles[0]?.time;
    this.buffer = replaceNewest(this.buffer, newest);
    this.requesting = false;
    this.renderAnchored(anchor);
  }

  /**
   * Обновление текущей свечи или новая свеча справа (WebSocket, закрытие свечи) — инкрементально,
   * без setData: масштаб и прокрутка пользователя сохраняются, загруженная история слева остаётся.
   * За новым баром LWC сдвигает вид сам, только если последний бар был виден (shiftVisibleRangeOnNewBar),
   * иначе компенсирует сдвиг и вид остаётся на тех же свечах.
   *
   * Полный буфер (MAX_CANDLES): сначала новая свеча справа — тем же update, затем из серий убираются
   * выпавшие слева. Диапазон вида здесь не задаётся вовсе: LWC при выпадении точек слева держит правый
   * отступ, т. е. те же свечи на экране, — и у края, и в прокрученной истории. Раньше диапазон
   * восстанавливался явно со сдвигом по шкале времени: у края это прибивало вид к старым свечам (живая
   * свеча уходила за правый край через ~6 закрытий), а с серией отдельной панели, ещё державшей выпавшее
   * время (OBV, объём), сдвиг считался нулевым и вид уезжал на бар вперёд с каждым закрытием.
   */
  update(c: Candle): void {
    const before = this.buffer;
    this.buffer = pushLatest(before, c);
    if (this.buffer === before) return;
    const data = this.seriesData();
    const vol = this.volumeData();
    const last = data[data.length - 1];
    if (!last) return;
    const appended = last.time !== before.candles[before.candles.length - 1]?.time;
    this.main.update(last as never);
    this.volume.update(vol[vol.length - 1]!);
    const dropped = before.candles.length > 0 && this.buffer.candles[0]?.time !== before.candles[0]?.time;
    if (dropped) {
      this.main.setData(data as never);
      this.volume.setData(vol);
    }
    // наложенный инструмент — на новом наборе времён свечей (новая справа, выпавшие слева)
    if (appended || dropped) this.applyOverlay();
  }

  /** Отдельная панель под индикатор: возвращает индекс панели. */
  addPane(height = 100): number {
    const idx = this.panes++;
    const pane = this.chart.panes()[idx] ?? this.chart.addPane();
    pane.setHeight(height);
    return idx;
  }

  /**
   * Раскладка всех панелей сразу (план 2A.7): желаемые высоты дополнительных панелей в пикселях,
   * главная получает остаток, но не меньше MAIN_MIN_SHARE высоты. Высоты задаются stretch-факторами
   * в пикселях — так панели не «плывут» после сворачивания и добавления.
   */
  layoutPanes(heights: Map<IPaneApi<Time>, number>): void {
    const panes = this.chart.panes();
    if (panes.length < 2) return;
    const total = panes.reduce((acc, p) => acc + p.getHeight(), 0);
    if (total <= 0) return;
    const want = panes.slice(1).map((p) => Math.max(1, heights.get(p) ?? p.getHeight()));
    const sum = want.reduce((a, b) => a + b, 0);
    const room = total * (1 - MAIN_MIN_SHARE);
    const k = sum > room ? room / sum : 1;
    const others = want.map((h) => h * k);
    const main = total - others.reduce((a, b) => a + b, 0);
    panes[0]!.setStretchFactor(main);
    panes.slice(1).forEach((p, i) => p.setStretchFactor(others[i]!));
  }

  /**
   * Высота панели в пикселях без ограничения LWC (setHeight не опускает ниже 30 px):
   * через stretch-факторы, разницу забирает главная панель.
   */
  setPaneHeight(pane: IPaneApi<Time>, px: number): void {
    const panes = this.chart.panes();
    const main = panes[0];
    if (!main || main === pane) return;
    const totalStretch = panes.reduce((acc, p) => acc + p.getStretchFactor(), 0);
    const totalHeight = panes.reduce((acc, p) => acc + p.getHeight(), 0);
    if (totalHeight <= 0 || totalStretch <= 0) return;
    const next = (px * totalStretch) / totalHeight;
    const delta = pane.getStretchFactor() - next;
    pane.setStretchFactor(next);
    main.setStretchFactor(Math.max(MIN_STRETCH, main.getStretchFactor() + delta));
  }

  /**
   * Линия на панели. На основной панели (0) — формат цены инструмента; на отдельных — свой формат панели
   * (проценты, компактно, значения индикатора), иначе LWC пишет два знака после запятой.
   */
  addLine(paneIndex: number, color: string, lineWidth: 1 | 2 = 1, priceFormat?: PriceFormat): ISeriesApi<"Line"> {
    const s = this.chart.addSeries(LineSeries, { color, lineWidth, priceLineVisible: false, lastValueVisible: true, priceFormat: this.paneFormat(paneIndex, priceFormat) }, paneIndex);
    if (paneIndex === 0 && !priceFormat) this.priceSeries.add(s);
    return s;
  }

  addHistogram(paneIndex: number, color: string, priceFormat?: PriceFormat): ISeriesApi<"Histogram"> {
    const s = this.chart.addSeries(HistogramSeries, { color, priceLineVisible: false, lastValueVisible: false, priceFormat: this.paneFormat(paneIndex, priceFormat) }, paneIndex);
    if (paneIndex === 0 && !priceFormat) this.priceSeries.add(s);
    return s;
  }

  private paneFormat(paneIndex: number, priceFormat?: PriceFormat): PriceFormat {
    return priceFormat ?? (paneIndex === 0 ? this.priceFormat : DEFAULT_PRICE_FORMAT);
  }

  removeSeries(s: PaneSeries): void {
    this.priceSeries.delete(s);
    this.chart.removeSeries(s);
  }

  /** Режим правой шкалы; наложенный инструмент в процентном режиме делит шкалу с основным. */
  setScaleMode(mode: ScaleMode): void {
    this.scaleMode = mode;
    this.chart.priceScale("right").applyOptions({ mode: SCALE_MODES[mode] });
    this.overlay?.applyOptions({ priceScaleId: mode === "percent" ? "right" : OVERLAY_SCALE });
  }

  /** Фиксация шкалы: автомасштаб выключен, пока пользователь не сбросит вид. */
  setAutoScale(on: boolean): void {
    this.chart.priceScale("right").applyOptions({ autoScale: on });
  }

  /**
   * Наложение второго инструмента (план 2A.3 v2): линия закрытий; null — убрать. Цвет передаётся при каждом
   * вызове (и при смене темы). Точки — только на времени свечей основного инструмента: у монеты, листинг
   * которой моложе наложенного инструмента, старые точки наложения добавляли на шкалу времени деления левее
   * первой свечи, и сброс вида показывал прошлое без единой свечи.
   */
  setOverlay(candles: readonly Candle[] | null, color: string): void {
    if (!candles || candles.length === 0) {
      if (this.overlay) this.chart.removeSeries(this.overlay);
      this.overlay = null;
      this.overlayCandles = [];
      return;
    }
    this.overlayCandles = candles;
    if (!this.overlay) {
      this.overlay = this.chart.addSeries(LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false, priceScaleId: this.scaleMode === "percent" ? "right" : OVERLAY_SCALE }, 0);
      this.chart.priceScale(OVERLAY_SCALE).applyOptions({ visible: false, scaleMargins: { top: 0.08, bottom: 0.2 } });
    } else {
      this.overlay.applyOptions({ color });
    }
    this.applyOverlay();
  }

  /** Точки наложения на времени свечей буфера. */
  private overlayData(): { time: Time; value: number }[] {
    const times = new Set(this.buffer.candles.map((c) => c.time));
    return this.overlayCandles.filter((c) => times.has(c.time)).map((c) => ({ time: c.time as Time, value: c.close }));
  }

  private applyOverlay(): void {
    this.overlay?.setData(this.overlayData());
  }

  /** Масштаб вокруг точки (x в пикселях контейнера; без x — вокруг центра видимой области). */
  zoom(factor: number, anchorX?: number): void {
    const ts = this.chart.timeScale();
    const r = ts.getVisibleLogicalRange();
    if (!r || factor <= 0) return;
    const width = r.to - r.from;
    const mid = (r.from + r.to) / 2;
    const anchor = anchorX === undefined ? mid : (ts.coordinateToLogical(anchorX) ?? mid);
    const maxBars = Math.max(MIN_VISIBLE_BARS, this.buffer.candles.length * 2);
    const next = Math.min(maxBars, Math.max(MIN_VISIBLE_BARS, width / factor));
    const left = width > 0 ? (anchor - r.from) / width : 0.5;
    ts.setVisibleLogicalRange({ from: anchor - left * next, to: anchor + (1 - left) * next });
  }

  /** Прокрутка на n баров (положительное — вправо, к новым свечам). */
  scrollBars(n: number): void {
    const ts = this.chart.timeScale();
    const r = ts.getVisibleLogicalRange();
    if (!r || n === 0) return;
    ts.setVisibleLogicalRange({ from: r.from + n, to: r.to + n });
  }

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const spacing = this.chart.timeScale().options().barSpacing || 1;
      this.scrollBars((e.deltaX / spacing) * WHEEL_SCROLL);
      return;
    }
    const gain = e.ctrlKey || e.metaKey ? WHEEL_ZOOM * 3 : WHEEL_ZOOM;
    const x = e.clientX - this.container.getBoundingClientRect().left;
    this.zoom(Math.exp(-e.deltaY * gain), x);
  };

  /**
   * Сброс вида (первая загрузка, кнопка ⟲, двойной клик/тап — план 2A.7): последние свечи с шагом около
   * barPx пикселей на бар и автомасштаб цены. Число свечей — от ширины области, см. barsForWidth.
   * Индексы — по шкале времени (индекс последней и первой свечи буфера), а не по длине буфера: на шкале
   * бывают и точки других серий.
   */
  resetView(barPx: number = VIEW_BAR_PX.desktop): void {
    const ts = this.chart.timeScale();
    const width = ts.width() || this.container.clientWidth;
    const n = barsForWidth(width, barPx);
    const c = this.buffer.candles;
    const last = c.length > 0 ? (ts.timeToIndex(c[c.length - 1]!.time as Time, true) ?? c.length - 1) : -1;
    ts.setVisibleLogicalRange({ from: Math.max(this.firstIndex(), last + 1 - n), to: last + 1 + RIGHT_OFFSET });
    this.chart.priceScale("right").applyOptions({ autoScale: true });
  }

  /** Индекс первой свечи буфера на шкале времени (0, если левее неё на шкале ничего нет). */
  private firstIndex(): number {
    const first = this.buffer.candles[0];
    return first ? (this.chart.timeScale().timeToIndex(first.time as Time, true) ?? 0) : 0;
  }

  destroy(): void {
    this.container.removeEventListener("wheel", this.onWheel);
    this.layers.detachAll();
    this.chart.remove();
  }

  private onRange(r: LogicalRange | null): void {
    this.opts.onVisibleRange?.(r);
    if (!r) return;
    // левый край вида — от первой свечи буфера, а не от начала шкалы времени
    const from = r.from - this.firstIndex();
    // ушли от левого края — следующий подход снова может подгрузить порцию
    if (from >= EDGE) this.edgeArmed = true;
    if (this.requesting) return;
    if (this.edgeArmed && needsOlder(this.buffer, from) && this.opts.onNeedOlder) {
      const first = this.buffer.candles[0];
      if (first) {
        this.requesting = true;
        this.edgeArmed = false;
        this.opts.onNeedOlder(first.time);
      }
    } else if (needsNewer(this.buffer, r.to) && this.opts.onNeedNewer) {
      this.requesting = true;
      this.opts.onNeedNewer();
    }
  }

  private seriesData() {
    const src = this.type === "heikin" ? heikinAshi(this.buffer.candles) : this.buffer.candles;
    if (this.type === "line") return src.map((c) => ({ time: c.time as UTCTimestamp, value: c.close }));
    return src.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close }));
  }

  private volumeData() {
    const c = seriesColors(this.tokens);
    return this.buffer.candles.map((x) => ({ time: x.time as Time, value: x.volume, color: x.close >= x.open ? c.volumeUp : c.volumeDown }));
  }

  /** Полная перерисовка тех же свечей (тема, тип графика): индексы не меняются, вид — тот же. */
  private render(): void {
    const range = this.chart.timeScale().getVisibleLogicalRange();
    this.setSeriesData();
    if (range) this.chart.timeScale().setVisibleLogicalRange(range);
  }

  /**
   * Перерисовка после вставки или выгрузки свечей слева: вид остаётся на тех же свечах. Сдвиг считаем по
   * индексу свечи-якоря до и после (на шкале времени бывают и точки других серий), без якоря — как render().
   */
  private renderAnchored(anchor: number | undefined): void {
    const ts = this.chart.timeScale();
    const range = ts.getVisibleLogicalRange();
    const i0 = anchor === undefined ? null : ts.timeToIndex(anchor as Time, true);
    this.setSeriesData();
    if (!range) return;
    const i1 = anchor === undefined ? null : ts.timeToIndex(anchor as Time, true);
    const shift = i0 !== null && i1 !== null ? i1 - i0 : 0;
    ts.setVisibleLogicalRange({ from: range.from + shift, to: range.to + shift });
  }

  private setSeriesData(): void {
    this.main.setData(this.seriesData() as never);
    this.volume.setData(this.volumeData());
    this.applyOverlay();
  }
}

export function createTerminal(container: HTMLElement, opts: TerminalOptions): Terminal {
  return new Terminal(container, opts);
}
