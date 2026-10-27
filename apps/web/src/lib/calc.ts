/** Расчёты калькулятора позиции (план 3.9). Чистые функции, проверяются тестами. */

export type CalcInput = {
  deposit: number;
  riskPct: number;
  entry: number;
  stop: number;
  direction: "long" | "short";
  leverage: number;
  marketType: "spot" | "futures";
  lotSize: number | null;
  tps: (number | null)[];
  mmr?: number; // поддерживающая маржа, доля (≈ 0.005 для крупных пар Binance)
};

export type CalcOutput = {
  riskUsd: number;
  riskPerUnit: number;
  sizeRaw: number;
  size: number;
  notional: number;
  requiredLeverage: number;
  margin: number;
  liquidation: number | null;
  tps: { price: number; r: number; pct: number; profitUsd: number }[];
  rrTp2: number | null;
  warnings: string[];
};

export function roundToLot(size: number, lot: number | null): number {
  if (!lot || lot <= 0) return size;
  const steps = Math.floor(size / lot + 1e-9);
  const digits = Math.max(0, Math.round(-Math.log10(lot)));
  return Number((steps * lot).toFixed(digits));
}

type Tr = (s: string, vars?: Record<string, string | number>) => string;
const plain: Tr = (s, v) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(v?.[k] ?? ""));

/** Предупреждения — через `t`, чтобы страница могла показать их на языке пользователя. */
export function calculate(i: CalcInput, t: Tr = plain): CalcOutput | null {
  const warnings: string[] = [];
  if (!(i.deposit > 0) || !(i.riskPct > 0) || !(i.entry > 0) || !(i.stop > 0)) return null;
  const sign = i.direction === "long" ? 1 : -1;
  const riskPerUnit = (i.entry - i.stop) * sign;
  if (riskPerUnit <= 0) {
    warnings.push(i.direction === "long" ? t("стоп должен быть ниже входа") : t("стоп должен быть выше входа"));
    return { riskUsd: 0, riskPerUnit: 0, sizeRaw: 0, size: 0, notional: 0, requiredLeverage: 0, margin: 0, liquidation: null, tps: [], rrTp2: null, warnings };
  }
  const riskUsd = (i.deposit * i.riskPct) / 100;
  const sizeRaw = riskUsd / riskPerUnit;
  const size = roundToLot(sizeRaw, i.lotSize);
  const notional = size * i.entry;
  const lev = i.marketType === "spot" ? 1 : Math.max(1, i.leverage || 1);
  const requiredLeverage = i.deposit > 0 ? notional / i.deposit : 0;
  if (i.marketType === "spot" && notional > i.deposit) warnings.push(t("на споте позиция больше депозита: уменьшите риск или сдвиньте стоп"));
  if (i.marketType === "futures" && requiredLeverage > lev) warnings.push(t("для такого размера нужно плечо ≥ {n}×", { n: requiredLeverage.toFixed(1) }));
  const margin = notional / lev;
  const mmr = i.mmr ?? 0.005;
  let liquidation: number | null = null;
  if (i.marketType === "futures") {
    liquidation = i.direction === "long" ? i.entry * (1 - 1 / lev + mmr) : i.entry * (1 + 1 / lev - mmr);
    const liqBeyondStop = i.direction === "long" ? liquidation > i.stop : liquidation < i.stop;
    if (liqBeyondStop) warnings.push(t("ликвидация ближе стопа: уменьшите плечо"));
  }
  const tps = i.tps
    .map((p) => (p && p > 0 ? p : null))
    .filter((p): p is number => p !== null)
    .map((price) => {
      const r = ((price - i.entry) * sign) / riskPerUnit;
      return { price, r, pct: ((price - i.entry) / i.entry) * 100 * sign, profitUsd: r * riskUsd };
    });
  return { riskUsd, riskPerUnit, sizeRaw, size, notional, requiredLeverage, margin, liquidation, tps, rrTp2: tps[1]?.r ?? tps[0]?.r ?? null, warnings };
}
