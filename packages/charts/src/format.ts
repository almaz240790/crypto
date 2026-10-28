/**
 * Подписи цен на шкале (план 2A.3, 5): разряды через пробел, без лишних нулей на делениях,
 * большие значения (OI, объём в панелях) — компактно: 7.82B, 781M.
 */
/** Разделитель разрядов — обычный пробел: узкий неразрывный (U+202F) Safari на iOS меряет в canvas как 0,
 * и LWC сжимал ценовую шкалу до ширины отступов — цены обрезались у правого края. */
const THIN = " ";
const COMPACT = [
  [1e9, "B"],
  [1e6, "M"],
] as const;
/** Значения от этого порога и выше пишем компактно — цены инструментов до него не доходят. */
const COMPACT_FROM = 1e6;
const COMPACT_DIGITS = 2;
const MAX_DECIMALS = 8;
const EPS = 1e-9;

function group(int: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, THIN);
}

function fixed(p: number, decimals: number): string {
  const s = Math.abs(p).toFixed(decimals);
  const [i, f] = s.split(".");
  return `${p < 0 && Number(s) !== 0 ? "−" : ""}${group(i!)}${f ? `.${f}` : ""}`;
}

function compact(p: number): string | null {
  const a = Math.abs(p);
  if (a < COMPACT_FROM) return null;
  for (const [base, suffix] of COMPACT) if (a >= base) return `${p < 0 ? "−" : ""}${(a / base).toFixed(COMPACT_DIGITS)}${suffix}`;
  return null;
}

/** Цена с точностью инструмента (последнее значение, перекрестие). */
export function formatPriceLabel(p: number, precision: number): string {
  return compact(p) ?? fixed(p, precision);
}

/** Значения от этого порога пишем без дробной части на телефоне: «80 724» вместо «80 723.7». */
const SHORT_INT_FROM = 10_000;

/** Цена для узкой шкалы (телефон): крупные значения — целым числом, чтобы шкала занимала меньше места. */
export function formatPriceShort(p: number, precision: number): string {
  return compact(p) ?? fixed(p, Math.abs(p) >= SHORT_INT_FROM ? 0 : precision);
}

/** Сколько знаков нужно, чтобы все деления записались точно (91 000, а не 91 000.0). */
export function tickDecimals(prices: readonly number[]): number {
  for (let d = 0; d < MAX_DECIMALS; d++) {
    const k = 10 ** d;
    if (prices.every((p) => Math.abs(Math.round(p * k) / k - p) <= EPS * Math.max(1, Math.abs(p)))) return d;
  }
  return MAX_DECIMALS;
}

/** Деления шкалы: общее число знаков на всю шкалу, разряды, компактная запись больших значений. */
export function formatTicks(prices: readonly number[]): string[] {
  const d = tickDecimals(prices);
  return prices.map((p) => compact(p) ?? fixed(p, d));
}
