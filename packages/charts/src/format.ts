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

/** Точность цены, если шаг инструмента неизвестен. */
export const DEFAULT_PRECISION = 2;
/** Больше знаков шаг цены не даёт ни у одного инструмента; защита от мусора в данных. */
const MAX_TICK_DECIMALS = 12;
const TICK_RE = /^[+]?(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/;

/**
 * Число знаков после запятой по шагу цены (план 5.4). Понимает и экспоненциальную запись, которую
 * отдаёт str(Decimal): "1.000E-7" → 7, "2.5E-6" → 7, "0.00001000" → 5, "0.1" → 1, "1" → 0.
 */
export function tickPrecision(tick: string | number | null | undefined, fallback = DEFAULT_PRECISION): number {
  if (tick === null || tick === undefined) return fallback;
  const s = String(tick).trim().toLowerCase();
  const m = TICK_RE.exec(s);
  if (!m || !(Number(s) > 0)) return fallback;
  const frac = (m[2] ?? "").replace(/0+$/, "");
  const exp = m[3] ? Number(m[3]) : 0;
  return Math.min(MAX_TICK_DECIMALS, Math.max(0, frac.length - exp));
}

export type TickFormat = { precision: number; minMove: number };

/** Точность и минимальный шаг цены для шкалы и подписей; без шага — две цифры после запятой. */
export function tickFormat(tick: string | number | null | undefined): TickFormat {
  const precision = tickPrecision(tick);
  const v = Number(tick);
  return { precision, minMove: tick !== null && tick !== undefined && Number.isFinite(v) && v > 0 ? v : 10 ** -precision };
}

/** Знаков у процентов на панели фандинга: ставка 0.0100 %, а не «0.0». */
export const PERCENT_DIGITS = 4;

/** Проценты на панели (фандинг): «0.0100 %», «−0.0111 %». */
export function formatPercentValue(v: number, digits = PERCENT_DIGITS): string {
  return `${fixed(v, digits)} %`;
}

const COMPACT_VALUE = [
  [1e12, "T"],
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "K"],
] as const;

/** Объём, открытый интерес, суммы: 7.82B, 78.2M, 781M, 54.3K; меньше тысячи — как есть, до двух знаков. */
export function formatCompactValue(v: number): string {
  const a = Math.abs(v);
  const sign = v < 0 && a > 0 ? "−" : "";
  for (const [base, suffix] of COMPACT_VALUE) {
    if (a >= base) {
      const x = a / base;
      return `${sign}${x.toFixed(x >= 100 ? 0 : x >= 10 ? 1 : 2)}${suffix}`;
    }
  }
  return `${sign}${Number(a.toFixed(2))}`;
}

/** Значащих цифр у малых значений индикаторов на отдельных панелях (MACD, ATR у монет дешевле цента). */
const VALUE_SIGNIFICANT = 3;

/** Значение индикатора на отдельной панели: разряды, два знака; малые — три значащие цифры; огромные — компактно. */
export function formatIndicatorValue(v: number): string {
  const a = Math.abs(v);
  if (a >= COMPACT_FROM) return formatCompactValue(v);
  if (a === 0 || a >= 1) return fixed(v, 2);
  const d = Math.min(MAX_DECIMALS, Math.max(2, VALUE_SIGNIFICANT - 1 - Math.floor(Math.log10(a))));
  return fixed(v, d);
}
