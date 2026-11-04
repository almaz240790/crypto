import { AtrCalc } from "../indicators/core";
import type { Candle } from "../types";
import { POSITION_ATR_PERIOD, POSITION_FALLBACK_PCT, POSITION_RR, POSITION_STOP_ATR, isPosition, type Drawing, type DrawingType, type Point } from "./types";

/**
 * Геометрия позиции Long/Short (план 2A.5, 3.9; ADR-0009, «Рисование», дополнение «Позиция»). Чистые функции.
 *
 * Точки: [вход (время — левый край), стоп (время — правый край), цель (время — правый край)]. У прежних позиций,
 * поставленных тремя нажатиями, время цели может быть любым: ширину задают вход и стоп, как раньше.
 */

export type PositionDir = "long" | "short";
/** Что правится: цена входа, стопа, цели или правый край (длительность). */
export type PositionPart = "entry" | "stop" | "target" | "end";
/** Индекс части в Hit.index: точки 0–2, правый край — 3. */
export const POSITION_PART_INDEX: Readonly<Record<PositionPart, number>> = { entry: 0, stop: 1, target: 2, end: 3 };
export const POSITION_PARTS: readonly PositionPart[] = ["entry", "stop", "target", "end"];

export const positionDir = (type: DrawingType): PositionDir => (type === "position-short" ? "short" : "long");
export const positionType = (dir: PositionDir): "position-long" | "position-short" => (dir === "long" ? "position-long" : "position-short");

export type PositionParts = { dir: PositionDir; entry: number; stop: number; target: number; start: number; end: number };

/** Вход, стоп, цель и края позиции; null — не позиция или точек не хватает. */
export function positionParts(d: Pick<Drawing, "type" | "points">): PositionParts | null {
  if (!isPosition(d.type)) return null;
  const [e, s, t] = d.points;
  if (!e || !s || !t) return null;
  return { dir: positionDir(d.type), entry: e.price, stop: s.price, target: t.price, start: Math.min(e.time, s.time), end: Math.max(e.time, s.time) };
}

/** Точки позиции из частей: вход — на левом краю, стоп и цель — на правом. */
export function positionPoints(p: Pick<PositionParts, "entry" | "stop" | "target" | "start" | "end">): Point[] {
  return [
    { time: p.start, price: p.entry },
    { time: p.end, price: p.stop },
    { time: p.end, price: p.target },
  ];
}

/** Знаков после запятой у шага цены (0.1 → 1, 0.00001 → 5, 1e-8 → 8). */
function tickDigits(tick: number): number {
  const s = tick.toExponential();
  const [m, e] = s.split("e");
  const frac = (m!.split(".")[1] ?? "").length;
  return Math.max(0, frac - Number(e));
}

/** Цена по шагу инструмента (без хвостов float: 0.1 + 0.2 → 0.3); без шага — как есть. */
export function roundToTick(price: number, tick: number | null | undefined): number {
  if (!tick || !(tick > 0) || !Number.isFinite(price)) return price;
  const d = Math.min(12, tickDigits(tick));
  return Number((Math.round(price / tick) * tick).toFixed(d));
}

/** Наименьший зазор между входом и стопом или целью: шаг цены, без него — миллионная доля цены. */
function minGap(entry: number, tick: number | null | undefined): number {
  return tick && tick > 0 ? tick : Math.max(Math.abs(entry) * 1e-6, Number.EPSILON);
}

/**
 * ATR(period) на свече входа (последняя свеча не позже time; правее последней — последний ATR). null — свечей меньше
 * периода. Считается по свечам показанного таймфрейма — те же, что на графике.
 */
export function atrAt(candles: readonly Candle[], time: number, period = POSITION_ATR_PERIOD): number | null {
  if (candles.length === 0) return null;
  const calc = new AtrCalc(period);
  let at: number | null = null;
  for (const c of candles) {
    if (c.time > time) break;
    at = calc.push(c);
  }
  return at !== null && at > 0 ? at : null;
}

/**
 * Позиция одним нажатием: вход — нажатая цена, стоп — на POSITION_STOP_ATR × ATR от входа (ниже у Long, выше у Short;
 * без ATR — POSITION_FALLBACK_PCT % цены), цель — POSITION_RR риска за входом; цены — по шагу инструмента.
 */
export function positionFromEntry(dir: PositionDir, entry: Point, o: { atr: number | null; end: number; tick?: number | null }): Point[] {
  // вход — тоже по шагу цены: в карточке и на плашках те же цифры, что на шкале
  entry = { time: entry.time, price: roundToTick(entry.price, o.tick) };
  const fallback = (Math.abs(entry.price) * POSITION_FALLBACK_PCT) / 100;
  let risk = o.atr !== null && o.atr > 0 ? o.atr * POSITION_STOP_ATR : fallback;
  // у Long стоп ниже нуля — бессмысленно: тогда — доля цены
  if (dir === "long" && entry.price - risk <= 0) risk = fallback;
  const sign = dir === "long" ? 1 : -1;
  const gap = minGap(entry.price, o.tick);
  let stop = roundToTick(entry.price - sign * risk, o.tick);
  if (sign * (entry.price - stop) < gap) stop = roundToTick(entry.price - sign * gap, o.tick);
  const r = Math.abs(entry.price - stop);
  const target = roundToTick(entry.price + sign * POSITION_RR * r, o.tick);
  return positionPoints({ entry: entry.price, stop, target, start: entry.time, end: Math.max(o.end, entry.time) });
}

export type PositionError = "entry-between" | "stop-below" | "stop-above" | "target-above" | "target-below" | "positive";

/** Проверка цен позиции: стоп и цель — по свои стороны от входа, все цены больше нуля. null — всё верно. */
export function positionError(dir: PositionDir, entry: number, stop: number, target: number): PositionError | null {
  if (!(entry > 0) || !(stop > 0) || !(target > 0)) return "positive";
  if (dir === "long") {
    if (!(stop < entry)) return "stop-below";
    if (!(target > entry)) return "target-above";
  } else {
    if (!(stop > entry)) return "stop-above";
    if (!(target < entry)) return "target-below";
  }
  return null;
}

/** Ошибка правки одного поля (карточка): какое правило нарушит новое значение. */
export function positionFieldError(p: PositionParts, part: "entry" | "stop" | "target", value: number): PositionError | null {
  if (!Number.isFinite(value) || !(value > 0)) return "positive";
  const next = { ...p, [part]: value };
  const err = positionError(p.dir, next.entry, next.stop, next.target);
  if (err && part === "entry") return "entry-between";
  return err;
}

/**
 * Перетаскивание цены входа, стопа или цели: значение прижимается к своей стороне (стоп не переходит за вход, цель —
 * тоже, вход остаётся между ними) — позиция не выворачивается, направление меняет только «Перевернуть».
 */
export function setPositionPrice(d: Pick<Drawing, "type" | "points">, part: "entry" | "stop" | "target", price: number, tick?: number | null): Point[] {
  const p = positionParts(d);
  if (!p) return d.points;
  const sign = p.dir === "long" ? 1 : -1;
  const gap = minGap(p.entry, tick);
  let v = roundToTick(price, tick);
  if (part === "entry") {
    // между стопом и целью (у прежней «вывернутой» позиции — как есть, без прыжка)
    const lo = Math.min(p.stop, p.target) + gap;
    const hi = Math.max(p.stop, p.target) - gap;
    if (lo <= hi) v = Math.min(Math.max(v, lo), hi);
  } else if (part === "stop") {
    v = sign > 0 ? Math.min(v, p.entry - gap) : Math.max(v, p.entry + gap);
  } else {
    v = sign > 0 ? Math.max(v, p.entry + gap) : Math.min(v, p.entry - gap);
  }
  // цена не ниже нуля: такое значение не принимается, часть остаётся на месте
  if (!(v > 0)) v = p[part];
  const idx = POSITION_PART_INDEX[part];
  return d.points.map((q, i) => (i === idx ? { ...q, price: v } : { ...q }));
}

/** Правый край (длительность): стоп и цель — на новом времени, не левее свечи входа + minStep. */
export function setPositionEnd(d: Pick<Drawing, "type" | "points">, end: number, minStep: number): Point[] {
  const p = positionParts(d);
  if (!p) return d.points;
  const t = Math.max(end, p.start + minStep);
  return d.points.map((q, i) => (i === 0 ? { ...q, time: p.start } : { ...q, time: t }));
}

/** R:R → цель на rr риска за входом. */
export function withRiskReward(d: Pick<Drawing, "type" | "points">, rr: number, tick?: number | null): Point[] {
  const p = positionParts(d);
  if (!p || !(rr > 0)) return d.points;
  const sign = p.dir === "long" ? 1 : -1;
  const target = roundToTick(p.entry + sign * rr * Math.abs(p.entry - p.stop), tick);
  return positionPoints({ ...p, target });
}

/** Риск, % от входа → стоп на этом расстоянии; R:R сохраняется (цель сдвигается вместе со стопом). */
export function withRiskPct(d: Pick<Drawing, "type" | "points">, pct: number, tick?: number | null): Point[] {
  const p = positionParts(d);
  if (!p || !(pct > 0) || !(pct < 100)) return d.points;
  const sign = p.dir === "long" ? 1 : -1;
  const oldRisk = Math.abs(p.entry - p.stop);
  const rr = oldRisk > 0 ? Math.abs(p.target - p.entry) / oldRisk : POSITION_RR;
  const stop = roundToTick(p.entry - (sign * p.entry * pct) / 100, tick);
  const risk = Math.abs(p.entry - stop);
  const target = roundToTick(p.entry + sign * rr * risk, tick);
  return positionPoints({ ...p, stop, target });
}

/** Long ⇄ Short: стоп и цель зеркально относительно входа (риск и R:R те же), цвет — по новому направлению. */
export function flipPosition(d: Pick<Drawing, "type" | "points">): Pick<Drawing, "type" | "points" | "style"> | null {
  const p = positionParts(d);
  if (!p) return null;
  const dir: PositionDir = p.dir === "long" ? "short" : "long";
  // зеркальная цена ниже нуля (стоп или цель дальше входа больше чем вдвое) — половина пути до нуля
  const mirror = (v: number) => (2 * p.entry - v > 0 ? 2 * p.entry - v : p.entry / 2);
  return { type: positionType(dir), points: positionPoints({ ...p, stop: mirror(p.stop), target: mirror(p.target) }), style: { color: dir === "long" ? "up" : "down", width: 1, dashed: false } };
}

/** R:R в подписи: «2», «1.5», «2.37». */
export function formatRR(rr: number): string {
  if (!Number.isFinite(rr)) return "—";
  return String(Number(rr.toFixed(2)));
}
