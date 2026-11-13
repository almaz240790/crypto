import { formatCompactValue, formatPriceShort, formatSignedPercent, tickPrecision, type Candle } from "@platform/charts";
import { formatPrice } from "@/lib/format";

/**
 * Значения свечи под перекрестием для строки состояния телефона (ADR-0009, дополнение 2026-11-13). Строка не
 * переносится: если не влезает, CrosshairStrip сжимает её по шагам, пока не влезет (уровень — номер последнего шага):
 * 1 — промежутки 8 px и короткие подписи («инд.», «не закрыта»), 2 — шрифт 11 px, 3 — цены короче (formatPriceShort,
 * как шкала цены телефона: от 10 000 — целым числом), 4 — время без «UTC». Чистые функции — vitest.
 */
export const CROSS_TIGHT = 1;
export const CROSS_SMALL = 2;
export const CROSS_SHORT = 3;
export const CROSS_NO_ZONE = 4;
export const CROSS_FIT_MAX = CROSS_NO_ZONE;

/** Время свечи — UTC, как было в карточке: «20.09, 00:00». */
const DATE = new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export type CrossText = {
  date: string;
  open: string;
  high: string;
  low: string;
  close: string;
  /** Изменение от открытия, как в легенде десктопа: «+0.62 %», «−0.10 %»; у открытия 0 — нет. */
  change: string | null;
  up: boolean;
  volume: string;
};

export function crossText(k: Candle, tick: string | null, level: number): CrossText {
  const precision = tickPrecision(tick);
  const px = (v: number) => (level >= CROSS_SHORT ? formatPriceShort(v, precision) : formatPrice(v, tick));
  const date = DATE.format(new Date(k.time * 1000));
  return {
    date: level >= CROSS_NO_ZONE ? date : `${date} UTC`,
    open: px(k.open),
    high: px(k.high),
    low: px(k.low),
    close: px(k.close),
    change: k.open ? formatSignedPercent(((k.close - k.open) / k.open) * 100) : null,
    up: k.close >= k.open,
    volume: formatCompactValue(k.volume),
  };
}

/**
 * Ключ подгонки: шрифт строки моноширинный, поэтому её ширина зависит только от длины текстов, пометки «не закрыта» и
 * кнопки индикаторов. Палец идёт по свечам с той же длиной цен — строка не перемеряется; длина сменилась — подгонка
 * начинается заново с полного вида.
 */
export function crossFitKey(k: Candle, tick: string | null, values: number): string {
  const x = crossText(k, tick, 0);
  return `${[x.date, x.open, x.high, x.low, x.close, x.change ?? "", x.volume].map((s) => s.length).join(".")}|${k.open_ ? 1 : 0}|${values > 0 ? String(values).length : 0}`;
}
