import { fibLevels, type Drawing } from "@platform/charts";

/**
 * Карточка выбранного рисунка не закрывает его (ADR-0009, «Рисование», дополнение 2026-11-12). Карточка — внизу колонки
 * графика: на телефоне раскрытые «уровни» Фибоначчи (234 px из ~600) и «параметры» позиции закрывали нижние 40–55 %
 * области свечей — там, где у текущей цены последний ход. Нижнее поле шкалы цены основной панели растёт
 * (Terminal.setBottomMargin) ровно настолько, чтобы рисунок был над карточкой; рисунок и так над ней — поле прежнее.
 * Чистые функции — vitest.
 */

/** Запас между нижней точкой рисунка и верхом карточки, px: ручка под пальцем — радиус 10 px. */
export const CARD_GAP_PX = 16;

type Box = { x: number; y: number; w: number; h: number };
/** Рисунок на экране: края по горизонтали и самая нижняя его точка (y растёт вниз), px области свечей. */
export type DrawingExtent = { left: number; right: number; low: number };

/**
 * Рисунок на экране: точки, у Фибоначчи — и показанные уровни (их и переключают в карточке); горизонтальная линия —
 * через всю панель, луч — до правого края. null — ни одной точки на шкалах.
 */
export function drawingExtent(d: Pick<Drawing, "type" | "points" | "levels">, proj: { x: (t: number) => number | null; y: (p: number) => number | null; width: number }): DrawingExtent | null {
  const prices = d.points.map((p) => p.price);
  const [p1, p2] = d.points;
  if (d.type === "fib" && p1 && p2) prices.push(...fibLevels(p1, p2, d.levels).map((l) => l.price));
  const xs = d.points.map((p) => proj.x(p.time)).filter((x): x is number => x !== null);
  const ys = prices.map((p) => proj.y(p)).filter((y): y is number => y !== null && Number.isFinite(y));
  if (xs.length === 0 || ys.length === 0) return null;
  const left = d.type === "hline" ? 0 : Math.min(...xs);
  const right = d.type === "hline" || d.type === "hray" ? proj.width : Math.max(...xs);
  return { left, right, low: Math.max(...ys) };
}

/**
 * Нижнее поле шкалы цены (доля основной панели высотой main.h, шириной области свечей main.w), при котором нижняя точка
 * выбранного рисунка sel — над карточками cards (прямоугольники в координатах графика) с запасом CARD_GAP_PX.
 * Считаются карточки над областью свечей и над рисунком по горизонтали. margins — поля шкалы сейчас (доли): по ним
 * место точки среди свечей, от поля не зависящее, — ответ тот же и после того, как поле выросло. Рисунок над карточкой
 * и так, нет таких карточек или выбранного рисунка — 0 (Terminal держит поле по умолчанию и оставляет свечам четверть
 * панели).
 */
export function cardBottomMargin(cards: readonly Box[], main: { w: number; h: number }, sel: DrawingExtent | null, margins: { top: number; bottom: number }): number {
  const H = main.h;
  if (!(H > 0) || !sel) return 0;
  let top = H;
  for (const c of cards) if (c.x < Math.min(main.w, sel.right) && c.x + c.w > Math.max(0, sel.left) && c.y < H && c.y + c.h > 0) top = Math.min(top, c.y);
  const limit = top - CARD_GAP_PX;
  const y0 = margins.top * H;
  // место нижней точки среди свечей: 0 — верх свечей, 1 — низ; больше 1 — ниже свечей (в нижнем поле, у объёма)
  const area = (1 - margins.top - margins.bottom) * H;
  const u = area > 0 ? (sel.low - y0) / area : 0;
  if (top >= H || !(u > 0) || !(limit > y0)) return 0;
  // поле, при котором точка — ровно на limit
  return Math.max(0, 1 - margins.top - (limit - y0) / (u * H));
}
