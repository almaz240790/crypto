import type { IChartApi, ISeriesApi, LogicalRange, SeriesType, Time, UTCTimestamp } from "lightweight-charts";
import { BarSeries, CandlestickSeries, HistogramSeries, LineSeries, createChart, type IPaneApi } from "lightweight-charts";
import { createBuffer, needsNewer, needsOlder, prependOlder, pushLatest, replaceNewest, type BufferState } from "./buffer";
import { heikinAshi } from "./heikin";
import { LayerManager } from "./layers";
import { chartOptions, seriesColors } from "./theme";
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
  private panes = 1;

  constructor(container: HTMLElement, opts: TerminalOptions) {
    this.opts = opts;
    this.tokens = opts.tokens;
    this.type = opts.type ?? "candles";
    this.chart = createChart(container, { ...chartOptions(opts.tokens), autoSize: true });
    this.main = this.createMain(this.type);
    this.volume = this.chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "", lastValueVisible: false, priceLineVisible: false });
    this.volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    this.layers.attach({ chart: this.chart, main: this.main });
    this.chart.timeScale().subscribeVisibleLogicalRangeChange((r) => this.onRange(r));
  }

  private createMain(type: ChartType): ISeriesApi<SeriesType> {
    const c = seriesColors(this.tokens);
    if (type === "bars") return this.chart.addSeries(BarSeries, c.bars);
    if (type === "line") return this.chart.addSeries(LineSeries, c.line);
    return this.chart.addSeries(CandlestickSeries, c.candles);
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

  setTheme(tokens: ThemeTokens): void {
    this.tokens = tokens;
    this.chart.applyOptions(chartOptions(tokens));
    const c = seriesColors(tokens);
    if (this.type === "bars") this.main.applyOptions(c.bars);
    else if (this.type === "line") this.main.applyOptions(c.line);
    else this.main.applyOptions(c.candles);
    this.render();
  }

  /** Полная история (последняя порция). hasOlder — есть ли ещё слева. */
  setCandles(candles: Candle[], hasOlder = true): void {
    this.buffer = createBuffer(candles, hasOlder);
    this.requesting = false;
    this.render();
  }

  addOlder(older: Candle[], hasOlder: boolean): void {
    this.buffer = prependOlder(this.buffer, older, hasOlder);
    this.requesting = false;
    this.render();
  }

  replaceNewest(newest: Candle[]): void {
    this.buffer = replaceNewest(this.buffer, newest);
    this.requesting = false;
    this.render();
  }

  /** Обновление текущей (или новой) свечи из WebSocket — без полного перерисовывания. */
  update(c: Candle): void {
    const before = this.buffer;
    this.buffer = pushLatest(before, c);
    if (this.buffer === before) return;
    const data = this.seriesData();
    const last = data[data.length - 1];
    if (!last) return;
    if (this.buffer.candles.length === before.candles.length || before.candles.length === 0) {
      this.main.update(last as never);
      this.volume.update(this.volumeData()[data.length - 1]!);
    } else {
      this.render();
    }
  }

  /** Отдельная панель под индикатор: возвращает индекс панели. */
  addPane(height = 100): number {
    const idx = this.panes++;
    const pane = this.chart.panes()[idx] ?? this.chart.addPane();
    pane.setHeight(height);
    return idx;
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

  addLine(paneIndex: number, color: string, lineWidth: 1 | 2 = 1): ISeriesApi<"Line"> {
    return this.chart.addSeries(LineSeries, { color, lineWidth, priceLineVisible: false, lastValueVisible: true }, paneIndex);
  }

  addHistogram(paneIndex: number, color: string): ISeriesApi<"Histogram"> {
    return this.chart.addSeries(HistogramSeries, { color, priceLineVisible: false, lastValueVisible: false }, paneIndex);
  }

  removeSeries(s: PaneSeries): void {
    this.chart.removeSeries(s);
  }

  /** Показать последние n свечей с автомасштабом (двойной тап, план 2A.7). */
  resetView(n = 120): void {
    const len = this.buffer.candles.length;
    this.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, len - n), to: len + 5 });
    this.chart.priceScale("right").applyOptions({ autoScale: true });
  }

  destroy(): void {
    this.layers.detachAll();
    this.chart.remove();
  }

  private onRange(r: LogicalRange | null): void {
    this.opts.onVisibleRange?.(r);
    if (!r || this.requesting) return;
    if (needsOlder(this.buffer, r.from) && this.opts.onNeedOlder) {
      const first = this.buffer.candles[0];
      if (first) {
        this.requesting = true;
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

  private render(): void {
    const range = this.chart.timeScale().getVisibleLogicalRange();
    this.main.setData(this.seriesData() as never);
    this.volume.setData(this.volumeData());
    if (range) this.chart.timeScale().setVisibleLogicalRange(range);
  }
}

export function createTerminal(container: HTMLElement, opts: TerminalOptions): Terminal {
  return new Terminal(container, opts);
}
