/**
 * Форматирование чисел и времени по правилам плана 5.4:
 * цены — с точностью инструмента, без лишних нулей; изменения — со знаком;
 * время — всегда с зоной, формат `25.10 16:00 UTC`.
 * Все цены приходят из API строками (Decimal); здесь только отображение.
 */

const MINUS = "−"; // типографский минус
const NBSP = " ";

/** Число знаков после запятой по шагу цены: "0.01" → 2, "1" → 0, "0.00001000" → 5. */
export function decimalsFromTick(tick: string | null | undefined): number {
  if (!tick) return 2;
  const t = tick.trim().replace(/0+$/, "");
  const i = t.indexOf(".");
  if (i < 0) return 0;
  return Math.max(0, t.length - i - 1);
}

/** Группировка разрядов тонким пробелом: 65432.1 → "65 432.1". */
function group(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}

export function formatPrice(
  value: string | number | null | undefined,
  tick?: string | null,
): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "—";
  const d = decimalsFromTick(tick);
  const fixed = Math.abs(n).toFixed(d);
  const [i, f] = fixed.split(".");
  const sign = n < 0 ? MINUS : "";
  return sign + group(i) + (f ? "." + f : "");
}

/** Значение со знаком: +0.62 / −1.00 / 0.00. */
export function formatSigned(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "—";
  const r = Math.abs(n).toFixed(digits);
  const zero = Number(r) === 0;
  const sign = zero ? "" : n < 0 ? MINUS : "+";
  return sign + r;
}

/** Результат в R: "+0.62 R". */
export function formatR(n: number | string | null | undefined, digits = 2): string {
  if (n === null || n === undefined || n === "") return "—";
  const v = typeof n === "number" ? n : Number(n);
  return formatSigned(v, digits) + NBSP + "R";
}

/** Проценты с одним знаком: "+1.2 %", "47.0 %" (без знака, если signed=false). */
export function formatPct(n: number | null | undefined, { signed = true, digits = 1 } = {}): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const body = signed ? formatSigned(n, digits) : Math.abs(n).toFixed(digits);
  return body + NBSP + "%";
}

function pad(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

/** `25.10 16:00 UTC`. С годом, если он отличается от текущего или withYear=true. */
export function formatTimeUTC(
  iso: string | Date,
  { withYear = false, now = new Date() }: { withYear?: boolean; now?: Date } = {},
): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "—";
  const dd = pad(d.getUTCDate());
  const mm = pad(d.getUTCMonth() + 1);
  const yy = d.getUTCFullYear();
  const date = withYear || yy !== now.getUTCFullYear() ? `${dd}.${mm}.${yy}` : `${dd}.${mm}`;
  return `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** Длительность в часах → "2 ч 14 мин", "3 д 5 ч", "40 мин". */
export function formatDuration(hours: number | string | null | undefined, t: (s: string, vars?: Record<string, string | number>) => string = (s, v) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(v?.[k] ?? ""))): string {
  if (hours === null || hours === undefined || hours === "") return "—";
  const h = typeof hours === "number" ? hours : Number(hours);
  if (!Number.isFinite(h) || h < 0) return "—";
  const totalMin = Math.round(h * 60);
  const days = Math.floor(totalMin / 1440);
  const hrs = Math.floor((totalMin % 1440) / 60);
  const min = totalMin % 60;
  if (days > 0) return t("{d} д {h} ч", { d: days, h: hrs });
  if (hrs > 0) return t("{h} ч {m} мин", { h: hrs, m: min });
  return t("{m} мин", { m: min });
}

/** Склонение: 1 сигнал, 2 сигнала, 5 сигналов. */
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
