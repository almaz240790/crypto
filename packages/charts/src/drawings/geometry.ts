import type { Candle } from "../types";
import { POSITION_PARTS, positionParts, type PositionPart } from "./position";
import { FIB_LEVELS, POSITION_EDGE_PX, POSITION_MIN_PX, isPosition, type Drawing, type Point } from "./types";

/** Магнит к OHLC: ближайшая из цен свечи, если она в пределах tolerance (в единицах цены). */
export function magnetSnap(candle: Candle | undefined, price: number, tolerance: number): number {
  if (!candle) return price;
  const cands = [candle.open, candle.high, candle.low, candle.close];
  let best = price;
  let dist = tolerance;
  for (const c of cands) {
    const d = Math.abs(c - price);
    if (d <= dist) {
      dist = d;
      best = c;
    }
  }
  return best;
}

/** Цена на линии через две точки в момент time (линейная экстраполяция по времени). */
export function lineAt(p1: Point, p2: Point, time: number): number {
  if (p2.time === p1.time) return p1.price;
  return p1.price + ((p2.price - p1.price) * (time - p1.time)) / (p2.time - p1.time);
}

/** Угол (градусы, по пикселям не считаем — по соотношению цены и времени в единицах пользователя) и изменение в %. */
export function trendInfo(p1: Point, p2: Point): { changePct: number; bars: number; seconds: number } {
  const changePct = p1.price === 0 ? 0 : ((p2.price - p1.price) / p1.price) * 100;
  return { changePct, bars: 0, seconds: p2.time - p1.time };
}

export function fibLevels(p1: Point, p2: Point, levels: number[] = FIB_LEVELS): { level: number; price: number }[] {
  const diff = p2.price - p1.price;
  return levels.map((l) => ({ level: l, price: p2.price - diff * l }));
}

export type PositionStats = {
  direction: "long" | "short";
  entry: number;
  stop: number;
  target: number;
  riskPerUnit: number;
  rewardPerUnit: number;
  rr: number;
  riskPct: number;
  /** Риск в деньгах и размер позиции — если задан депозит и доля риска. */
  riskUsd: number | null;
  size: number | null;
  notional: number | null;
};

/** Позиция Long/Short: вход, стоп, цель → R:R, риск, размер по профилю (план 2A.5, 3.9). */
export function positionStats(
  direction: "long" | "short",
  entry: number,
  stop: number,
  target: number,
  profile?: { deposit: number; riskPct: number } | null,
): PositionStats {
  const riskPerUnit = Math.abs(entry - stop);
  const rewardPerUnit = direction === "long" ? target - entry : entry - target;
  const rr = riskPerUnit > 0 ? rewardPerUnit / riskPerUnit : 0;
  const riskPct = entry > 0 ? (riskPerUnit / entry) * 100 : 0;
  let riskUsd: number | null = null;
  let size: number | null = null;
  let notional: number | null = null;
  if (profile && profile.deposit > 0 && profile.riskPct > 0 && riskPerUnit > 0) {
    riskUsd = (profile.deposit * profile.riskPct) / 100;
    size = riskUsd / riskPerUnit;
    notional = size * entry;
  }
  return { direction, entry, stop, target, riskPerUnit, rewardPerUnit, rr, riskPct, riskUsd, size, notional };
}

export type RulerInfo = { changePct: number; priceDiff: number; bars: number; seconds: number; atrMultiple: number | null };

export function rulerInfo(p1: Point, p2: Point, tfSeconds: number, atr: number | null): RulerInfo {
  const priceDiff = p2.price - p1.price;
  return {
    changePct: p1.price === 0 ? 0 : (priceDiff / p1.price) * 100,
    priceDiff,
    bars: Math.round((p2.time - p1.time) / tfSeconds),
    seconds: p2.time - p1.time,
    atrMultiple: atr ? priceDiff / atr : null,
  };
}

/** Канал: третья точка задаёт сдвиг параллельной линии. */
export function channelOffset(p1: Point, p2: Point, p3: Point): number {
  return p3.price - lineAt(p1, p2, p3.time);
}

/** Расстояние от точки до отрезка (в пикселях). */
export function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/**
 * Попадание по рисунку: хэндл точки (index — номер точки) или тело. У позиции index — часть (POSITION_PART_INDEX):
 * 0 — вход, 1 — стоп, 2 — цель, 3 — правый край.
 */
export type Hit = { id: string; part: "point" | "body"; index: number };

export type Projector = { x: (time: number) => number | null; y: (price: number) => number | null; width: number; height: number };

/** Полоса попадания линии позиции не уже этого (px), даже у очень тонкой зоны. */
const LINE_MIN_TOL = 3;

/** Позиция на экране: левый и правый край (не уже POSITION_MIN_PX), середина, y входа, стопа и цели. */
export type PositionScreen = { xL: number; xR: number; xC: number; yE: number; yS: number; yT: number };

/**
 * Позиция на экране. Узкая позиция (уже POSITION_MIN_PX: отдалили график) рисуется шириной POSITION_MIN_PX, но этот
 * запас не уводит правый край и его ручку за правый край области свечей (width − POSITION_EDGE_PX): там нажатие —
 * жест шкалы цены. Позиция, которая сама тянется за край (прокрутили график), — как есть.
 */
export function positionScreen(d: Pick<Drawing, "type" | "points">, proj: Pick<Projector, "x" | "y"> & { width?: number }): PositionScreen | null {
  const p = positionParts(d);
  if (!p) return null;
  const x1 = proj.x(p.start), x2 = proj.x(p.end);
  const yE = proj.y(p.entry), yS = proj.y(p.stop), yT = proj.y(p.target);
  if (x1 === null || x2 === null || yE === null || yS === null || yT === null) return null;
  const xL = Math.min(x1, x2);
  const cap = proj.width !== undefined ? Math.max(xL, proj.width - POSITION_EDGE_PX) : Infinity;
  const xR = Math.max(x1, x2, Math.min(xL + POSITION_MIN_PX, cap));
  return { xL, xR, xC: (xL + xR) / 2, yE, yS, yT };
}

/**
 * Ручки позиции (как в TradingView): вход, стоп и цель — у левого края своих линий, правый край — на линии входа
 * справа. Середина линий свободна: там плашки цели, стопа и входа.
 */
export function positionKnobs(s: PositionScreen): Readonly<Record<PositionPart, { x: number; y: number }>> {
  return { entry: { x: s.xL, y: s.yE }, stop: { x: s.xL, y: s.yS }, target: { x: s.xL, y: s.yT }, end: { x: s.xR, y: s.yE } };
}

/**
 * Что у позиции под точкой: ручка (в пределах knobTol — 22 px под пальцем, цель 44 px), линия входа, стопа или цели
 * по всей длине и правый край (в пределах tol; из нескольких — ближайшая), иначе тело — весь прямоугольник.
 */
export function positionHit(s: PositionScreen, px: number, py: number, tol: number, knobTol: number): PositionPart | "body" | null {
  const knobs = positionKnobs(s);
  let best: { part: PositionPart; d: number } | null = null;
  for (const part of POSITION_PARTS) {
    const k = knobs[part];
    const dist = Math.hypot(px - k.x, py - k.y);
    if (dist <= knobTol && (!best || dist < best.d)) best = { part, d: dist };
  }
  if (best) return best.part;
  const top = Math.min(s.yE, s.yS, s.yT), bottom = Math.max(s.yE, s.yS, s.yT);
  if (px >= s.xL - tol && px <= s.xR + tol) {
    const lines: [PositionPart, number][] = [["entry", s.yE], ["stop", s.yS], ["target", s.yT]];
    for (const [part, y] of lines) {
      // у тонкой зоны полоса линии не шире трети зоны: середина остаётся телом (сдвиг всей позиции)
      const gap = Math.min(...lines.filter(([p]) => p !== part).map(([, o]) => Math.abs(o - y)));
      const dist = Math.abs(py - y);
      if (dist <= Math.min(tol, Math.max(LINE_MIN_TOL, gap / 3)) && (!best || dist < best.d)) best = { part, d: dist };
    }
    if (best) return best.part;
  }
  if (Math.abs(px - s.xR) <= tol && py >= top && py <= bottom) return "end";
  if (px >= s.xL - tol && px <= s.xR + tol && py >= top - tol && py <= bottom + tol) return "body";
  return null;
}

/** Что под курсором: сначала хэндлы точек, затем тело. tolerance — в пикселях; knob — ручки позиции (палец — 22). */
export function hitTest(drawings: Drawing[], px: number, py: number, proj: Projector, tolerance: number, knob = tolerance): Hit | null {
  for (let k = drawings.length - 1; k >= 0; k--) {
    const d = drawings[k]!;
    if (isPosition(d.type)) {
      const s = positionScreen(d, proj);
      const part = s ? positionHit(s, px, py, tolerance, knob) : null;
      if (part === "body") return { id: d.id, part: "body", index: -1 };
      if (part) return { id: d.id, part: "point", index: POSITION_PARTS.indexOf(part) };
      continue;
    }
    const pts = d.points.map((p) => ({ x: proj.x(p.time), y: proj.y(p.price) }));
    for (let i = 0; i < pts.length; i++) {
      const q = pts[i]!;
      if (q.x !== null && q.y !== null && Math.hypot(px - q.x, py - q.y) <= tolerance) return { id: d.id, part: "point", index: i };
    }
    if (bodyHit(d, pts, px, py, proj, tolerance)) return { id: d.id, part: "body", index: -1 };
  }
  return null;
}

function bodyHit(d: Drawing, pts: { x: number | null; y: number | null }[], px: number, py: number, proj: Projector, tol: number): boolean {
  const [a, b, c] = pts;
  switch (d.type) {
    case "hline":
    case "hray":
      return a?.y !== null && a?.y !== undefined && Math.abs(py - a.y) <= tol && (d.type === "hline" || (a.x !== null && px >= a.x - tol));
    case "vline":
      return a?.x !== null && a?.x !== undefined && Math.abs(px - a.x) <= tol;
    case "note":
      return a?.x !== null && a?.y !== null && a !== undefined && Math.abs(px - a.x!) <= tol * 3 && Math.abs(py - a.y!) <= tol * 2;
    case "trend":
    case "ray":
    case "extended":
    case "ruler":
    case "fib":
    case "channel": {
      if (!a || !b || a.x === null || a.y === null || b.x === null || b.y === null) return false;
      let x1 = a.x, y1 = a.y, x2 = b.x, y2 = b.y;
      if (d.type === "ray" || d.type === "extended") {
        const ext = extend(x1, y1, x2, y2, proj.width, d.type === "extended");
        x1 = ext.x1; y1 = ext.y1; x2 = ext.x2; y2 = ext.y2;
      }
      if (distToSegment(px, py, x1, y1, x2, y2) <= tol) return true;
      if (d.type === "channel" && c && c.x !== null && c.y !== null) {
        const off = c.y - (a.y + ((b.y - a.y) * (c.x - a.x)) / (b.x - a.x || 1));
        return distToSegment(px, py, a.x, a.y + off, b.x, b.y + off) <= tol;
      }
      if (d.type === "fib") {
        const top = Math.min(a.y, b.y), bottom = Math.max(a.y, b.y);
        if (!(px >= Math.min(a.x, b.x) - tol && px <= Math.max(a.x, b.x) + tol)) return false;
        if (py >= top - tol && py <= bottom + tol) return true;
        // уровни за пределами A–B (1.272, 1.618, отрицательные) нарисованы — значит, выбираются нажатием по линии;
        // промежуток между ними телом не считается: там сдвиг графика (ADR-0009, «Рисование»)
        const [p1, p2] = d.points;
        if (!p1 || !p2) return false;
        return fibLevels(p1, p2, d.levels).some(({ price }) => {
          const y = proj.y(price);
          return y !== null && Math.abs(py - y) <= tol;
        });
      }
      return false;
    }
    case "rect": {
      if (!a || !b || a.x === null || a.y === null || b.x === null || b.y === null) return false;
      const left = Math.min(a.x, b.x) - tol, right = Math.max(a.x, b.x) + tol;
      return px >= left && px <= right && py >= Math.min(a.y, b.y) - tol && py <= Math.max(a.y, b.y) + tol;
    }
    default:
      return false;
  }
}

/** Продление отрезка до краёв холста (луч — только вперёд). */
export function extend(x1: number, y1: number, x2: number, y2: number, width: number, both: boolean): { x1: number; y1: number; x2: number; y2: number } {
  if (x2 === x1) return { x1, y1: both ? -1e4 : y1, x2, y2: 1e4 };
  const k = (y2 - y1) / (x2 - x1);
  const fx2 = x2 >= x1 ? width + 10 : -10;
  const ex2 = fx2, ey2 = y1 + k * (fx2 - x1);
  if (!both) return { x1, y1, x2: ex2, y2: ey2 };
  const fx1 = x2 >= x1 ? -10 : width + 10;
  return { x1: fx1, y1: y1 + k * (fx1 - x1), x2: ex2, y2: ey2 };
}
