/**
 * Профиль объёма по видимой части графика (индикаторы v2, план этап 4): горизонтальные бары
 * у правого края, объём свечи распределяется равномерно по ценовым корзинам, которые она
 * покрывает. POC — корзина с максимальным объёмом, зона стоимости — 70 % объёма вокруг POC.
 * Без градиентов и теней; цвета — из токенов.
 */
import type { IChartApi, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, SeriesAttachedParameter, SeriesType, Time } from "lightweight-charts";

export type VpCandle = { time: number; high: number; low: number; volume: number };
export type VpTokens = { bar: string; value: string; poc: string; text: string };

export const VP_ROWS = 24;
/** Доля ширины панели под самый большой бар. */
export const VP_WIDTH = 0.2;
export const VP_VALUE_AREA = 0.7;

export type VpRow = { top: number; bottom: number; volume: number; poc: boolean; value: boolean };

/** Чистый расчёт: корзины по диапазону видимых свечей. */
export function volumeProfile(candles: readonly VpCandle[], rows = VP_ROWS, valueArea = VP_VALUE_AREA): VpRow[] {
  if (candles.length === 0) return [];
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of candles) {
    if (c.low < lo) lo = c.low;
    if (c.high > hi) hi = c.high;
  }
  if (!(hi > lo)) return [];
  const step = (hi - lo) / rows;
  const vol = new Array<number>(rows).fill(0);
  for (const c of candles) {
    const a = Math.min(rows - 1, Math.max(0, Math.floor((c.low - lo) / step)));
    const b = Math.min(rows - 1, Math.max(0, Math.floor((c.high - lo) / step)));
    const share = c.volume / (b - a + 1);
    for (let i = a; i <= b; i++) vol[i]! += share;
  }
  let poc = 0;
  for (let i = 1; i < rows; i++) if (vol[i]! > vol[poc]!) poc = i;
  const total = vol.reduce((s, v) => s + v, 0);
  // зона стоимости: расширяем от POC в сторону большего соседа, пока не наберём долю объёма
  let a = poc;
  let b = poc;
  let acc = vol[poc]!;
  while (acc < total * valueArea && (a > 0 || b < rows - 1)) {
    const up = b < rows - 1 ? vol[b + 1]! : -1;
    const down = a > 0 ? vol[a - 1]! : -1;
    if (up >= down) {
      b++;
      acc += up;
    } else {
      a--;
      acc += down;
    }
  }
  return vol.map((v, i) => ({ bottom: lo + i * step, top: lo + (i + 1) * step, volume: v, poc: i === poc, value: i >= a && i <= b }));
}

class VpRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly bars: { y1: number; y2: number; w: number; row: VpRow }[],
    private readonly width: number,
    private readonly tokens: VpTokens,
  ) {}

  draw(target: Parameters<IPrimitivePaneRenderer["draw"]>[0]): void {
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const r = scope.horizontalPixelRatio;
      const v = scope.verticalPixelRatio;
      const right = Math.round(this.width * r);
      for (const { y1, y2, w, row } of this.bars) {
        const top = Math.round(Math.min(y1, y2) * v);
        const height = Math.max(1, Math.round(Math.abs(y2 - y1) * v) - 1);
        const bw = Math.max(1, Math.round(w * r));
        ctx.fillStyle = row.poc ? this.tokens.poc : row.value ? this.tokens.value : this.tokens.bar;
        ctx.fillRect(right - bw, top, bw, height);
        if (row.poc) {
          ctx.fillStyle = this.tokens.text;
          ctx.font = `${10 * r}px ui-monospace, monospace`;
          ctx.textBaseline = "middle";
          ctx.textAlign = "right";
          ctx.fillText("POC", right - bw - 4 * r, top + height / 2);
        }
      }
    });
  }
}

class VpPaneView implements IPrimitivePaneView {
  constructor(private readonly source: VolumeProfilePrimitive) {}

  renderer(): IPrimitivePaneRenderer | null {
    const { chart, series } = this.source;
    if (!chart || !series || !this.source.enabled) return null;
    const ts = chart.timeScale();
    const range = ts.getVisibleRange();
    if (!range) return null;
    const from = range.from as number;
    const to = range.to as number;
    const visible = this.source.candles.filter((c) => c.time >= from && c.time <= to);
    const rows = volumeProfile(visible);
    if (rows.length === 0) return null;
    const max = Math.max(...rows.map((x) => x.volume)) || 1;
    const width = ts.width();
    const bars = [];
    for (const row of rows) {
      const y1 = series.priceToCoordinate(row.top);
      const y2 = series.priceToCoordinate(row.bottom);
      if (y1 === null || y2 === null) continue;
      bars.push({ y1, y2, w: (row.volume / max) * width * VP_WIDTH, row });
    }
    return new VpRenderer(bars, width, this.source.tokens);
  }
}

export class VolumeProfilePrimitive implements ISeriesPrimitive<Time> {
  chart: IChartApi | null = null;
  series: ISeriesApi<SeriesType> | null = null;
  candles: readonly VpCandle[] = [];
  enabled = false;
  tokens: VpTokens;
  private requestUpdate: (() => void) | null = null;
  private readonly views = [new VpPaneView(this)];

  constructor(tokens: VpTokens) {
    this.tokens = tokens;
  }

  attached(p: SeriesAttachedParameter<Time>): void {
    this.chart = p.chart;
    this.series = p.series;
    this.requestUpdate = p.requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  setCandles(candles: readonly VpCandle[]): void {
    this.candles = candles;
    this.requestUpdate?.();
  }

  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    this.requestUpdate?.();
  }

  setTokens(tokens: VpTokens): void {
    this.tokens = tokens;
    this.requestUpdate?.();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }
}
