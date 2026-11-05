import { tickPrecision } from "@platform/charts";

/** Значащих цифр в поле цены, если шаг инструмента неизвестен. */
const FALLBACK_SIGNIFICANT = 8;
/** Больше знаков после запятой не бывает ни у одного инструмента (как у tickPrecision). */
const MAX_DECIMALS = 12;
const MIN_DECIMALS = 2;

/**
 * Цена для поля формы алерта (план 2A.6, 2B.9 §9): по шагу инструмента — столько знаков, сколько даёт шаг, без
 * разрядов и экспоненты («77441.7», «0.00000045»), как шкала и шапка. Шаг неизвестен — до 8 значащих цифр без нулей
 * в конце (не меньше двух знаков после запятой).
 */
export function alertPriceText(price: number, tick: string | null): string {
  if (tick != null) return price.toFixed(tickPrecision(tick));
  const magnitude = Math.floor(Math.log10(Math.abs(price) || 1));
  const decimals = Math.min(MAX_DECIMALS, Math.max(MIN_DECIMALS, FALLBACK_SIGNIFICANT - 1 - magnitude));
  const [int, frac = ""] = price.toFixed(decimals).split(".");
  return `${int}.${frac.replace(/0+$/, "").padEnd(MIN_DECIMALS, "0")}`;
}
