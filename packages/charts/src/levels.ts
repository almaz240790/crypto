import { atr } from "./indicators/core";
import type { Candle } from "./types";

/**
 * Уровни поддержки/сопротивления и расчётная карта ликвидаций (план 2A.4, 2A.6).
 * Только закрытые свечи: незакрытую отбрасываем здесь, чтобы уровни не «дрожали» на каждом тике.
 */

export type SrLevel = { price: number; side: "support" | "resistance"; touches: number; firstT: number; lastT: number };
export type SrOptions = {
  /** Свечей слева и справа, чтобы точка считалась разворотом. */
  pivot: number;
  lookback: number;
  /** Точки ближе этой доли ATR склеиваются в один уровень. */
  mergeAtr: number;
  minTouches: number;
  perSide: number;
  atrPeriod: number;
};
export const SR_DEFAULTS: SrOptions = { pivot: 3, lookback: 300, mergeAtr: 0.35, minTouches: 2, perSide: 3, atrPeriod: 14 };

function closedTail(candles: readonly Candle[], lookback: number): Candle[] {
  const closed = candles.filter((c) => !c.open_);
  return closed.slice(Math.max(0, closed.length - lookback));
}

function lastAtr(candles: readonly Candle[], period: number): number | null {
  const v = atr(candles, period).at(-1);
  return v == null || !Number.isFinite(v) || v <= 0 ? null : v;
}

/** Развороты (фракталы) → кластеры по близости цены → ближайшие к текущей цене сверху и снизу. */
export function supportResistance(candles: readonly Candle[], opts: Partial<SrOptions> = {}): SrLevel[] {
  const o = { ...SR_DEFAULTS, ...opts };
  const cs = closedTail(candles, o.lookback);
  const a = lastAtr(cs, o.atrPeriod);
  if (cs.length < o.pivot * 2 + 1 || a === null) return [];
  const pts: { p: number; t: number }[] = [];
  for (let i = o.pivot; i < cs.length - o.pivot; i++) {
    let hi = true;
    let lo = true;
    for (let k = i - o.pivot; k <= i + o.pivot && (hi || lo); k++) {
      if (k === i) continue;
      if (cs[k]!.high > cs[i]!.high) hi = false;
      if (cs[k]!.low < cs[i]!.low) lo = false;
    }
    if (hi) pts.push({ p: cs[i]!.high, t: cs[i]!.time });
    if (lo) pts.push({ p: cs[i]!.low, t: cs[i]!.time });
  }
  pts.sort((x, y) => x.p - y.p);
  const gap = o.mergeAtr * a;
  const clusters: { sum: number; n: number; firstT: number; lastT: number; top: number }[] = [];
  for (const pt of pts) {
    const c = clusters.at(-1);
    if (c && pt.p - c.top <= gap) {
      c.sum += pt.p;
      c.n += 1;
      c.top = pt.p;
      c.firstT = Math.min(c.firstT, pt.t);
      c.lastT = Math.max(c.lastT, pt.t);
    } else clusters.push({ sum: pt.p, n: 1, firstT: pt.t, lastT: pt.t, top: pt.p });
  }
  const price = cs.at(-1)!.close;
  const levels = clusters.filter((c) => c.n >= o.minTouches).map((c) => ({ price: c.sum / c.n, touches: c.n, firstT: c.firstT, lastT: c.lastT }));
  const below = levels.filter((l) => l.price < price).sort((x, y) => y.price - x.price).slice(0, o.perSide);
  const above = levels.filter((l) => l.price >= price).sort((x, y) => x.price - y.price).slice(0, o.perSide);
  return [...below.map((l) => ({ ...l, side: "support" as const })), ...above.map((l) => ({ ...l, side: "resistance" as const }))];
}

/** long/short — оценка суммы позиций под ликвидацией в этой цене, USDT. */
export type LiqBucket = { price: number; long: number; short: number };
export type LiqMap = {
  step: number;
  buckets: LiqBucket[];
  max: number;
  topLong: LiqBucket | null;
  topShort: LiqBucket | null;
  /** Крупнейшие скопления по каждой стороне, по убыванию суммы. */
  topLongs: LiqBucket[];
  topShorts: LiqBucket[];
};
export type LiqOptions = {
  lookback: number;
  /** Плечи и их доли в оценке: чем больше плечо, тем меньше позиций. */
  leverages: readonly (readonly [number, number])[];
  /** Поддерживающая маржа (доля), как в калькуляторе. */
  mmr: number;
  buckets: number;
  /** Окно карты вокруг цены, доля от цены. */
  range: number;
  /** Сколько крупнейших скоплений на сторону отдавать для подписей. */
  top: number;
};
export const LIQ_DEFAULTS: LiqOptions = {
  lookback: 300,
  leverages: [
    [10, 0.4],
    [25, 0.3],
    [50, 0.2],
    [100, 0.1],
  ],
  mmr: 0.005,
  buckets: 80,
  range: 0.15,
  top: 3,
};

/**
 * Расчётная карта ликвидаций — оценка, не данные биржи. Позиции «открываются» по типичной цене свечи
 * с весом прироста открытого интереса в USDT (если OI нет — объёма × цена), по половине в лонг и шорт. Для каждого плеча
 * считается цена ликвидации; уровни, до которых цена уже доходила после открытия, считаются сработавшими.
 */
export function liquidationMap(candles: readonly Candle[], oi: readonly { t: number; v: number }[] | null, opts: Partial<LiqOptions> = {}): LiqMap | null {
  const o = { ...LIQ_DEFAULTS, ...opts };
  const cs = closedTail(candles, o.lookback);
  if (cs.length < 2) return null;
  const oiAt = new Map((oi ?? []).map((x) => [x.t, x.v]));
  const useOi = cs.filter((c) => oiAt.has(c.time)).length >= cs.length / 2;
  // после свечи i: минимум low и максимум high до конца — сработала ли ликвидация
  const n = cs.length;
  const minAfter = new Array<number>(n).fill(Infinity);
  const maxAfter = new Array<number>(n).fill(-Infinity);
  for (let i = n - 2; i >= 0; i--) {
    minAfter[i] = Math.min(minAfter[i + 1]!, cs[i + 1]!.low);
    maxAfter[i] = Math.max(maxAfter[i + 1]!, cs[i + 1]!.high);
  }
  const price = cs[n - 1]!.close;
  const lo = price * (1 - o.range);
  const hi = price * (1 + o.range);
  const step = (hi - lo) / o.buckets;
  const buckets: LiqBucket[] = Array.from({ length: o.buckets }, (_, i) => ({ price: lo + step * (i + 0.5), long: 0, short: 0 }));
  let prevOi: number | null = null;
  for (let i = 0; i < n; i++) {
    const c = cs[i]!;
    let w = 0;
    if (useOi) {
      const v = oiAt.get(c.time);
      w = v != null && prevOi != null ? Math.max(0, v - prevOi) : 0;
      if (v != null) prevOi = v;
    }
    const entry = (c.high + c.low + c.close) / 3;
    if (!useOi) w = c.volume * entry;
    if (w <= 0) continue;
    for (const [lev, share] of o.leverages) {
      const half = (w * share) / 2;
      const longLiq = entry * (1 - 1 / lev + o.mmr);
      const shortLiq = entry * (1 + 1 / lev - o.mmr);
      if (longLiq < minAfter[i]! && longLiq >= lo && longLiq < hi) buckets[Math.floor((longLiq - lo) / step)]!.long += half;
      if (shortLiq > maxAfter[i]! && shortLiq >= lo && shortLiq < hi) buckets[Math.floor((shortLiq - lo) / step)]!.short += half;
    }
  }
  let max = 0;
  let topLong: LiqBucket | null = null;
  let topShort: LiqBucket | null = null;
  for (const b of buckets) {
    max = Math.max(max, b.long + b.short);
    if (b.long > 0 && (!topLong || b.long > topLong.long)) topLong = b;
    if (b.short > 0 && (!topShort || b.short > topShort.short)) topShort = b;
  }
  const topLongs = buckets.filter((b) => b.long > 0).sort((a, b) => b.long - a.long).slice(0, o.top);
  const topShorts = buckets.filter((b) => b.short > 0).sort((a, b) => b.short - a.short).slice(0, o.top);
  return max > 0 ? { step, buckets, max, topLong, topShort, topLongs, topShorts } : null;
}
