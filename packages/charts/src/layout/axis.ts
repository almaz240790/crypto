import type { AxisBudget } from "../presets";
import type { AxisCandidate, AxisFixed, AxisLayout, AxisPlaced, AxisScale, DropReason } from "./types";

/** Порядок групп при равном приоритете: алерты, позиции, уровни, «Разбор». */
export const AXIS_GROUP_ORDER: readonly AxisCandidate["group"][] = ["alert", "position", "sr", "topdown"];
const groupRank = (g: AxisCandidate["group"]) => AXIS_GROUP_ORDER.indexOf(g);

/** Полуширина полосы без делений вокруг центра метки высотой h: текст деления не заходит на метку + 1 px. */
export const hideHalf = (h: number, tickFontPx: number): number => (h + tickFontPx) / 2 + 1;

/** Попадает ли y в полосу без делений. */
export function inBands(y: number, bands: AxisLayout["hiddenBands"]): boolean {
  for (const [y0, y1] of bands) if (y >= y0 && y <= y1) return true;
  return false;
}

/** Ключ полос для повторного применения формата шкалы: округление до 0.5 px исключает петлю. */
export function bandsKey(bands: AxisLayout["hiddenBands"]): string {
  return bands.map(([a, b]) => `${Math.round(a * 2) / 2}:${Math.round(b * 2) / 2}`).join(",");
}

function groupCap(budget: AxisBudget, group: AxisCandidate["group"]): number {
  return group === "alert" ? budget.alerts : group === "position" ? budget.positions : group === "topdown" ? budget.topdown : budget.srPerSide;
}

/**
 * Метки на ценовой шкале (M04). Одинаковые тексты склеиваются (старший по приоритету остаётся); порядок —
 * приоритет, группа, близость к цене, id; бюджет — по группам (S/R — на сторону) и общий. Фиксированные метки
 * (цена, отсчёт, наложение) не двигаются. Метка встаёт на свой y или ближайший свободный в сторону от цены,
 * не дальше maxShift; не нашлось — выбрасывается (остаётся подпись на холсте).
 */
export function layoutAxis(candidates: readonly AxisCandidate[], fixed: readonly AxisFixed[], scale: AxisScale, budget: AxisBudget): AxisLayout {
  const yLast = fixed.find((f) => f.id === "last")?.y;
  const near = (c: AxisCandidate) => (yLast === undefined ? 0 : Math.abs(c.y - yLast));
  const sorted = [...candidates].sort((a, b) => b.priority - a.priority || groupRank(a.group) - groupRank(b.group) || near(a) - near(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // склейка одинаковых цен: «83 528» у сопротивления и алерта — одна метка
  const reps: { c: AxisCandidate; merged: string[] }[] = [];
  const byText = new Map<string, { c: AxisCandidate; merged: string[] }>();
  for (const c of sorted) {
    const rep = byText.get(c.text);
    if (rep) rep.merged.push(c.id);
    else {
      const r = { c, merged: [] as string[] };
      byText.set(c.text, r);
      reps.push(r);
    }
  }
  const occupied: { y: number; h: number }[] = fixed.map((f) => ({ y: f.y, h: f.h }));
  const placed: AxisPlaced[] = [];
  const dropped: { id: string; reason: DropReason }[] = [];
  const counts = new Map<string, number>();
  const half = scale.labelH / 2;
  const fits = (y: number) => y >= half && y <= scale.height - half;
  const conflicts = (y: number) => occupied.filter((o) => Math.abs(o.y - y) < (o.h + scale.labelH) / 2 + scale.gap);
  for (const { c, merged } of reps) {
    const drop = (reason: DropReason) => {
      dropped.push({ id: c.id, reason });
      for (const m of merged) dropped.push({ id: m, reason });
    };
    const groupKey = c.group === "sr" ? `sr:${c.side}` : c.group;
    if (placed.length >= budget.total || (counts.get(groupKey) ?? 0) >= groupCap(budget, c.group)) {
      drop("budget");
      continue;
    }
    if (!Number.isFinite(c.y) || !fits(c.y)) {
      drop("offscreen");
      continue;
    }
    const dir = c.side === "above" ? -1 : 1;
    let y = c.y;
    let ok = false;
    for (let guard = 0; guard <= occupied.length; guard++) {
      const hit = conflicts(y);
      if (hit.length === 0) {
        ok = true;
        break;
      }
      y = dir < 0 ? Math.min(...hit.map((o) => o.y - (o.h + scale.labelH) / 2 - scale.gap)) : Math.max(...hit.map((o) => o.y + (o.h + scale.labelH) / 2 + scale.gap));
      if (Math.abs(y - c.y) > scale.maxShift + 1e-9 || !fits(y)) break;
    }
    if (!ok) {
      drop("collision");
      continue;
    }
    occupied.push({ y, h: scale.labelH });
    counts.set(groupKey, (counts.get(groupKey) ?? 0) + 1);
    placed.push({ id: c.id, objectId: c.objectId, y, text: c.text, tone: c.tone, style: c.style, merged });
  }
  const hiddenBands: [number, number][] = [
    ...fixed.map((f) => [f.y - hideHalf(f.h, scale.tickFontPx), f.y + hideHalf(f.h, scale.tickFontPx)] as [number, number]),
    ...placed.map((p) => [p.y - hideHalf(scale.labelH, scale.tickFontPx), p.y + hideHalf(scale.labelH, scale.tickFontPx)] as [number, number]),
  ].sort((a, b) => a[0] - b[0]);
  return { placed, hiddenBands, dropped };
}
