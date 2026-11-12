import type { IChartApiBase, ISeriesApi, SeriesType, Time } from "lightweight-charts";
import type { SceneProjector } from "../layout/project";
import type { Candle } from "../types";

/**
 * Координаты кадра из LWC для projectScene (план 2B.2): время → логический индекс по буферу свечей
 * (как TimeProjector рисунков: между свечами — интерполяция, правее последней и левее первой — экстраполяция
 * шагом таймфрейма), индекс → x через шкалу времени, цена → y через основную серию.
 */

/** Логический индекс времени относительно первой свечи буфера (дробный между свечами и за краями). */
export function timeToIndex(candles: readonly Candle[], time: number, step: number): number {
  const n = candles.length;
  if (n === 0) return 0;
  const first = candles[0]!.time;
  const last = candles[n - 1]!.time;
  if (time <= first) return (time - first) / step;
  if (time >= last) return n - 1 + (time - last) / step;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid]!.time < time) lo = mid + 1;
    else hi = mid;
  }
  if (candles[lo]!.time === time) return lo;
  const a = candles[lo - 1]!.time;
  const b = candles[lo]!.time;
  return lo - 1 + (time - a) / (b - a);
}

/**
 * x логического индекса на шкале времени (lx — logicalToCoordinate шкалы LWC). LWC 5 даёт координату только целому
 * индексу, дробному — 0 (левый край панели). Дробный индекс — время между свечами (рисунок с другого таймфрейма:
 * 15:00 на 4ч, 04:00 на 1Д) или правее последней свечи не кратно шагу, поэтому x — от целой части с долей до
 * следующего индекса (на шкале времени индексы равноотстоящие).
 */
export function logicalX(lx: (logical: number) => number | null, logical: number): number | null {
  const i = Math.floor(logical);
  const x0 = lx(i);
  if (x0 === null || i === logical) return x0;
  const x1 = lx(i + 1);
  return x1 === null ? x0 : x0 + (logical - i) * (x1 - x0);
}

export interface FrameProjector extends SceneProjector {
  /** Логический индекс первой свечи буфера на шкале времени. */
  firstIndex: number;
  /** Видимые свечи буфера (по видимому логическому диапазону). */
  visible: readonly Candle[];
}

type ChartLike = Pick<IChartApiBase<Time>, "timeScale" | "paneSize">;
type SeriesLike = Pick<ISeriesApi<SeriesType>, "priceToCoordinate">;

export function frameProjector(chart: ChartLike, series: SeriesLike, candles: readonly Candle[], step: number): FrameProjector {
  const ts = chart.timeScale();
  const n = candles.length;
  const firstIndex = n > 0 ? ((ts.timeToIndex(candles[0]!.time as Time, true) as number | null) ?? 0) : 0;
  const lx = (logical: number): number | null => logicalX((l) => ts.logicalToCoordinate(l as never) as number | null, logical);
  const range = ts.getVisibleLogicalRange();
  const r = range ? { from: range.from as number, to: range.to as number } : null;
  const x0 = lx(firstIndex);
  const x1 = lx(firstIndex + 1);
  const spacing = x0 !== null && x1 !== null ? x1 - x0 : 6;
  let visible: readonly Candle[] = [];
  if (r && n > 0) {
    const i0 = Math.max(0, Math.floor(r.from) - firstIndex);
    const i1 = Math.min(n - 1, Math.ceil(r.to) - firstIndex);
    visible = i1 >= i0 ? candles.slice(i0, i1 + 1) : [];
  }
  return {
    firstIndex,
    visible,
    width: ts.width(),
    height: chart.paneSize(0).height,
    x: (time) => lx(firstIndex + timeToIndex(candles, time, step)),
    y: (price) => series.priceToCoordinate(price) as number | null,
    visibleLogical: () => r,
    barSpacing: () => spacing,
    lastBarX: () => (n > 0 ? lx(firstIndex + n - 1) : null),
  };
}
