import type { BarPrice, PriceFormat, PriceFormatCustom } from "lightweight-charts";
import { formatCompactValue, formatIndicatorValue, formatPercentValue, formatPriceLabel, formatPriceShort, formatSignedPercent, formatTicks, tickDecimals, tickFormat, PERCENT_DIGITS } from "./format";

/**
 * Форматы цен для серий LWC (план 2A.3, 5.4). Каждая серия форматирует свою шкалу сама: у основной серии
 * точность и минимальный шаг — от шага цены инструмента (иначе у монет дешевле цента нет делений шкалы),
 * у панелей — свои форматы (фандинг в процентах, OI и объём компактно). Общий для графика
 * localization.priceFormatter не используется: он переопределяет форматы всех панелей сразу.
 */

/** Формат основной серии: шаг цены и точность инструмента, подписи с разрядами. */
export type InstrumentPriceFormat = PriceFormatCustom & { precision: number };

/** Формат основной серии по шагу цены. narrow — узкая шкала телефона: крупные цены целым числом. */
export function instrumentPriceFormat(tick: string | number | null | undefined, narrow = false): InstrumentPriceFormat {
  const { precision, minMove } = tickFormat(tick);
  // base = 1 / minMove целым числом: 1 / 1e-7 в float — 9999999.999999998, а шкале нужен ровно 10 000 000
  const inv = 1 / minMove;
  const base = Math.round(inv);
  return {
    type: "custom",
    precision,
    minMove,
    ...(base >= 1 && Math.abs(inv - base) <= 1e-6 * base ? { base } : {}),
    formatter: (p: number) => (narrow ? formatPriceShort(p, precision) : formatPriceLabel(p, precision)),
    tickmarksFormatter: (ps: number[]) => formatTicks(ps),
  };
}

/** Минимальный шаг значений на отдельных панелях: деления строятся и для очень малых величин. */
const PANE_MIN_MOVE = 1e-8;

/** Фандинг в процентах: «0.0100 %». */
export const PERCENT_FORMAT: PriceFormat = {
  type: "custom",
  minMove: 10 ** -PERCENT_DIGITS,
  formatter: (v: number) => formatPercentValue(v),
  tickmarksFormatter: (vs: number[]) => {
    const d = Math.max(tickDecimals(vs), 2);
    return vs.map((v) => formatPercentValue(v, d));
  },
};

/** Открытый интерес, объём, суммы ликвидаций: 7.82B, 781M, 54.3K. */
export const COMPACT_FORMAT: PriceFormat = {
  type: "custom",
  minMove: 1,
  formatter: (v: number) => formatCompactValue(v),
};

/** Индикаторы на отдельных панелях (RSI, MACD, ATR…): разряды, малые значения — три значащие цифры. */
export const VALUE_FORMAT: PriceFormat = {
  type: "custom",
  minMove: PANE_MIN_MOVE,
  formatter: (v: number) => formatIndicatorValue(v),
  tickmarksFormatter: (vs: number[]) => formatTicks(vs),
};

/**
 * Форматы цены инструмента одним объектом (план 2A.3, 5.4): сцена, раскладка шкалы, подсказки и «Найдено»
 * берут один аргумент. Новых правил нет — это функции format.ts с точностью по шагу цены.
 */
export interface PriceFormatter {
  /** tickPrecision(tick): 7 для "1.000E-7". */
  readonly precision: number;
  readonly minMove: number;
  /** Цена с точностью инструмента: «83 528.4», «0.0049400». */
  price(p: number): string;
  /** Метка на шкале: на узкой шкале телефона крупные цены целым числом. */
  axis(p: number): string;
  ticks(prices: readonly number[]): string[];
  value(v: number): string;
  compact(v: number): string;
  /** «+1.24 %». */
  pct(v: number, digits?: number): string;
}

export function priceFormatter(tick: string | number | null | undefined, narrow: boolean): PriceFormatter {
  const { precision, minMove } = tickFormat(tick);
  return {
    precision,
    minMove,
    price: (p) => formatPriceLabel(p, precision),
    axis: (p) => (narrow ? formatPriceShort(p, precision) : formatPriceLabel(p, precision)),
    ticks: (ps) => formatTicks(ps),
    value: (v) => formatIndicatorValue(v),
    compact: (v) => formatCompactValue(v),
    pct: (v, digits = 2) => formatSignedPercent(v, digits),
  };
}

/**
 * Тот же формат, но деления шкалы под нашими метками пустые (M04): tickmarksFormatter отдаёт "" для цены,
 * чей y попадает в полосу размещённой метки. Число знаков считается по всем делениям, как без скрытия,
 * поэтому видимые деления не меняются. formatter (последняя цена, перекрестие) не трогается.
 */
export function withHiddenTicks(format: InstrumentPriceFormat, isHiddenPrice: (price: number) => boolean): InstrumentPriceFormat {
  const base = format.tickmarksFormatter ?? ((ps: BarPrice[]) => ps.map((p) => format.formatter(p)));
  return { ...format, tickmarksFormatter: (ps: BarPrice[]) => base(ps).map((s, i) => (isHiddenPrice(ps[i]!) ? "" : s)) };
}
