import type { PriceFormat, PriceFormatCustom } from "lightweight-charts";
import { formatCompactValue, formatIndicatorValue, formatPercentValue, formatPriceLabel, formatPriceShort, formatTicks, tickDecimals, tickFormat, PERCENT_DIGITS } from "./format";

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
