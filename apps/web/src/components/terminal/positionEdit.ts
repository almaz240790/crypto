import { positionFieldError, positionParts, positionPoints, roundToTick, withRiskPct, withRiskReward, type Drawing, type Point, type PositionError, type PositionParts } from "@platform/charts";

/**
 * Поля позиции в карточке выбранного рисунка (ADR-0009, «Рисование», дополнение «Позиция»): вход, стоп, цель — цены
 * по шагу инструмента; R:R — цель на R:R риска за входом; риск, % — стоп на этом расстоянии от входа (R:R тот же).
 * Чистые функции: разбор ввода, проверка, новые точки.
 */
export type PosField = "entry" | "stop" | "target" | "rr" | "risk";
export const POS_FIELDS: readonly PosField[] = ["entry", "stop", "target", "rr", "risk"];

/** Ошибки ввода — ключи t() (тексты на подтверждение, en.json). */
export const POS_ERROR_TEXT: Readonly<Record<PositionError | "number" | "rr" | "risk", string>> = {
  positive: "больше нуля",
  number: "введите число",
  "entry-between": "вход — между стопом и целью",
  "stop-below": "у Long стоп ниже входа",
  "stop-above": "у Short стоп выше входа",
  "target-above": "у Long цель выше входа",
  "target-below": "у Short цель ниже входа",
  rr: "R:R больше нуля",
  risk: "риск от 0 до 100 %",
};

/** Число из поля: «65 000,5», «65000.5», «1:2» у R:R не нужен — только число. null — не число. */
export function parseNumber(raw: string): number | null {
  const s = raw.replace(/[\s  ]/g, "").replace(",", ".");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** R:R и риск позиции (как в подписи на графике). */
export function positionMetrics(p: PositionParts): { rr: number; riskPct: number } {
  const risk = Math.abs(p.entry - p.stop);
  return { rr: risk > 0 ? Math.abs(p.target - p.entry) / risk : 0, riskPct: p.entry > 0 ? (risk / p.entry) * 100 : 0 };
}

/** Значение поля для показа: цены — с точностью инструмента, R:R и риск — два знака без лишних нулей. */
export function formatField(p: PositionParts, f: PosField, digits: number): string {
  const m = positionMetrics(p);
  switch (f) {
    case "entry":
    case "stop":
    case "target":
      return p[f].toFixed(digits);
    case "rr":
      return String(Number(m.rr.toFixed(2)));
    case "risk":
      return String(Number(m.riskPct.toFixed(2)));
  }
}

/** Новые точки позиции по значению поля или ключ ошибки (стоп и цель — по свои стороны от входа). */
export function applyField(d: Pick<Drawing, "type" | "points">, f: PosField, raw: string, tick: number | null): { points: Point[] } | { error: string } {
  const p = positionParts(d);
  const n = parseNumber(raw);
  if (!p) return { error: POS_ERROR_TEXT.number };
  if (n === null) return { error: POS_ERROR_TEXT.number };
  if (f === "rr") return n > 0 && n <= 100 ? { points: withRiskReward(d, n, tick) } : { error: POS_ERROR_TEXT.rr };
  if (f === "risk") return n > 0 && n < 100 ? { points: withRiskPct(d, n, tick) } : { error: POS_ERROR_TEXT.risk };
  const v = roundToTick(n, tick);
  const err = positionFieldError(p, f, v);
  if (err) return { error: POS_ERROR_TEXT[err] };
  return { points: positionPoints({ ...p, [f]: v }) };
}

/** Точки совпадают (правка не изменила позицию — шага отмены нет). */
export function samePoints(a: readonly Point[], b: readonly Point[]): boolean {
  return a.length === b.length && a.every((p, i) => p.time === b[i]!.time && p.price === b[i]!.price);
}
