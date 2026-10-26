import type { Candle } from "../types";

/**
 * Индикаторы терминала (план 2A.4): чистые функции `(candles, params) → series` и инкрементальные
 * калькуляторы `push(candle) → value`. Полный расчёт = прогон калькулятора по всем свечам, поэтому
 * инкрементальный результат по построению равен полному. Эталон — engine/indicators.py (golden).
 */
export type Value = number | null;

export interface Calc<T> {
  push(c: Candle): T;
}

function run<T>(calc: Calc<T>, candles: readonly Candle[]): T[] {
  return candles.map((c) => calc.push(c));
}

/** Скользящее окно с суммой — SMA по любому источнику. */
export class SmaCalc implements Calc<Value> {
  private readonly buf: number[] = [];
  private sum = 0;
  constructor(private readonly period: number, private readonly src: (c: Candle) => Value = (c) => c.close) {
    if (period < 1) throw new Error("period должен быть >= 1");
  }
  push(c: Candle): Value {
    return this.pushValue(this.src(c));
  }
  pushValue(v: Value): Value {
    if (v === null) return null;
    this.buf.push(v);
    this.sum += v;
    if (this.buf.length > this.period) this.sum -= this.buf.shift()!;
    if (this.buf.length < this.period) return null;
    // среднее по окну — пересчёт суммой окна, как numpy mean (без накопленной ошибки)
    let s = 0;
    for (const x of this.buf) s += x;
    return s / this.period;
  }
}

/** EMA с сидом простым средним первых period значений (как в engine.indicators.ema). */
export class EmaCalc implements Calc<Value> {
  private readonly seed: number[] = [];
  private value: number | null = null;
  private readonly alpha: number;
  constructor(private readonly period: number, private readonly src: (c: Candle) => Value = (c) => c.close) {
    if (period < 1) throw new Error("period должен быть >= 1");
    this.alpha = 2 / (period + 1);
  }
  push(c: Candle): Value {
    return this.pushValue(this.src(c));
  }
  pushValue(v: Value): Value {
    if (v === null) return null;
    if (this.value === null) {
      this.seed.push(v);
      if (this.seed.length < this.period) return null;
      let s = 0;
      for (const x of this.seed) s += x;
      this.value = s / this.period;
      return this.value;
    }
    this.value = this.alpha * v + (1 - this.alpha) * this.value;
    return this.value;
  }
}

export class TrueRangeCalc implements Calc<number> {
  private prevClose: number | null = null;
  push(c: Candle): number {
    const tr = this.prevClose === null ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - this.prevClose), Math.abs(c.low - this.prevClose));
    this.prevClose = c.close;
    return tr;
  }
}

/** ATR по Уайлдеру: сид SMA(TR, period), далее (prev*(p-1)+tr)/p. */
export class AtrCalc implements Calc<Value> {
  private readonly tr = new TrueRangeCalc();
  private readonly seed: number[] = [];
  private value: number | null = null;
  constructor(private readonly period = 14) {
    if (period < 1) throw new Error("period должен быть >= 1");
  }
  push(c: Candle): Value {
    const tr = this.tr.push(c);
    if (this.value === null) {
      this.seed.push(tr);
      if (this.seed.length < this.period) return null;
      let s = 0;
      for (const x of this.seed) s += x;
      this.value = s / this.period;
      return this.value;
    }
    this.value = (this.value * (this.period - 1) + tr) / this.period;
    return this.value;
  }
}

/** RSI по Уайлдеру (engine.indicators.rsi). */
export class RsiCalc implements Calc<Value> {
  private prevClose: number | null = null;
  private readonly gains: number[] = [];
  private readonly losses: number[] = [];
  private avgGain: number | null = null;
  private avgLoss = 0;
  constructor(private readonly period = 14) {
    if (period < 1) throw new Error("period должен быть >= 1");
  }
  push(c: Candle): Value {
    if (this.prevClose === null) {
      this.prevClose = c.close;
      return null;
    }
    const d = c.close - this.prevClose;
    this.prevClose = c.close;
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    if (this.avgGain === null) {
      this.gains.push(g);
      this.losses.push(l);
      if (this.gains.length < this.period) return null;
      let sg = 0, sl = 0;
      for (let i = 0; i < this.period; i++) { sg += this.gains[i]!; sl += this.losses[i]!; }
      this.avgGain = sg / this.period;
      this.avgLoss = sl / this.period;
    } else {
      this.avgGain = (this.avgGain * (this.period - 1) + g) / this.period;
      this.avgLoss = (this.avgLoss * (this.period - 1) + l) / this.period;
    }
    return this.avgLoss === 0 ? 100 : 100 - 100 / (1 + this.avgGain / this.avgLoss);
  }
}

export type MacdValue = { line: Value; signal: Value; hist: Value };

export class MacdCalc implements Calc<MacdValue> {
  private readonly fast: EmaCalc;
  private readonly slow: EmaCalc;
  private readonly sig: EmaCalc;
  constructor(fast = 12, slow = 26, signal = 9) {
    if (!(fast > 0 && fast < slow) || signal < 1) throw new Error("ожидается 0 < fast < slow и signal >= 1");
    this.fast = new EmaCalc(fast);
    this.slow = new EmaCalc(slow);
    this.sig = new EmaCalc(signal);
  }
  push(c: Candle): MacdValue {
    const f = this.fast.push(c);
    const s = this.slow.push(c);
    if (f === null || s === null) return { line: null, signal: null, hist: null };
    const line = f - s;
    const signal = this.sig.pushValue(line);
    return { line, signal, hist: signal === null ? null : line - signal };
  }
}

export type StochValue = { k: Value; d: Value };

export class StochasticCalc implements Calc<StochValue> {
  private readonly highs: number[] = [];
  private readonly lows: number[] = [];
  private readonly kSma: SmaCalc;
  private readonly dSma: SmaCalc;
  constructor(private readonly k = 14, d = 3, smooth = 3) {
    if (k < 1 || d < 1 || smooth < 1) throw new Error("периоды должны быть >= 1");
    this.kSma = new SmaCalc(smooth);
    this.dSma = new SmaCalc(d);
  }
  push(c: Candle): StochValue {
    this.highs.push(c.high);
    this.lows.push(c.low);
    if (this.highs.length > this.k) { this.highs.shift(); this.lows.shift(); }
    if (this.highs.length < this.k) return { k: null, d: null };
    let hh = -Infinity, ll = Infinity;
    for (let i = 0; i < this.k; i++) { if (this.highs[i]! > hh) hh = this.highs[i]!; if (this.lows[i]! < ll) ll = this.lows[i]!; }
    const raw = hh === ll ? 50 : (100 * (c.close - ll)) / (hh - ll);
    const k = this.kSma.pushValue(raw);
    const d = k === null ? null : this.dSma.pushValue(k);
    return { k, d };
  }
}

export type BollingerValue = { mid: Value; up: Value; lo: Value };

export class BollingerCalc implements Calc<BollingerValue> {
  private readonly buf: number[] = [];
  constructor(private readonly period = 20, private readonly mult = 2) {
    if (period < 1) throw new Error("period должен быть >= 1");
  }
  push(c: Candle): BollingerValue {
    this.buf.push(c.close);
    if (this.buf.length > this.period) this.buf.shift();
    if (this.buf.length < this.period) return { mid: null, up: null, lo: null };
    let s = 0;
    for (const x of this.buf) s += x;
    const m = s / this.period;
    let v = 0;
    for (const x of this.buf) v += (x - m) * (x - m);
    const sd = Math.sqrt(v / this.period);
    return { mid: m, up: m + this.mult * sd, lo: m - this.mult * sd };
  }
}

/** Дневной VWAP: сброс в 00:00 UTC. */
export class VwapCalc implements Calc<Value> {
  private day = -1;
  private pv = 0;
  private vol = 0;
  push(c: Candle): Value {
    const day = Math.floor(c.time / 86400);
    if (day !== this.day) { this.day = day; this.pv = 0; this.vol = 0; }
    const tp = (c.high + c.low + c.close) / 3;
    this.pv += tp * c.volume;
    this.vol += c.volume;
    return this.vol > 0 ? this.pv / this.vol : tp;
  }
}

export type SupertrendValue = { line: Value; dir: 1 | -1 | null };

export class SupertrendCalc implements Calc<SupertrendValue> {
  private readonly atr: AtrCalc;
  private fu = NaN;
  private fl = NaN;
  private trend: 1 | -1 | 0 = 0;
  private prevClose: number | null = null;
  constructor(period = 10, private readonly mult = 3) {
    this.atr = new AtrCalc(period);
  }
  push(c: Candle): SupertrendValue {
    const a = this.atr.push(c);
    const prev = this.prevClose;
    this.prevClose = c.close;
    if (a === null) return { line: null, dir: null };
    const hl2 = (c.high + c.low) / 2;
    const bu = hl2 + this.mult * a;
    const bl = hl2 - this.mult * a;
    if (this.trend === 0) {
      this.fu = bu;
      this.fl = bl;
      this.trend = c.close < bl ? -1 : 1;
    } else {
      this.fu = bu < this.fu || (prev !== null && prev > this.fu) ? bu : this.fu;
      this.fl = bl > this.fl || (prev !== null && prev < this.fl) ? bl : this.fl;
      if (this.trend === 1 && c.close < this.fl) this.trend = -1;
      else if (this.trend === -1 && c.close > this.fu) this.trend = 1;
    }
    return { line: this.trend === 1 ? this.fl : this.fu, dir: this.trend };
  }
}

// --- полные расчёты --------------------------------------------------------------------------------

export const sma = (candles: readonly Candle[], period: number): Value[] => run(new SmaCalc(period), candles);
export const ema = (candles: readonly Candle[], period: number): Value[] => run(new EmaCalc(period), candles);
export const atr = (candles: readonly Candle[], period = 14): Value[] => run(new AtrCalc(period), candles);
export const rsi = (candles: readonly Candle[], period = 14): Value[] => run(new RsiCalc(period), candles);
export const macd = (candles: readonly Candle[], fast = 12, slow = 26, signal = 9): MacdValue[] => run(new MacdCalc(fast, slow, signal), candles);
export const stochastic = (candles: readonly Candle[], k = 14, d = 3, smooth = 3): StochValue[] => run(new StochasticCalc(k, d, smooth), candles);
export const bollinger = (candles: readonly Candle[], period = 20, mult = 2): BollingerValue[] => run(new BollingerCalc(period, mult), candles);
export const vwapDaily = (candles: readonly Candle[]): Value[] => run(new VwapCalc(), candles);
export const supertrend = (candles: readonly Candle[], period = 10, mult = 3): SupertrendValue[] => run(new SupertrendCalc(period, mult), candles);
export const volumeSma = (candles: readonly Candle[], period = 20): Value[] => run(new SmaCalc(period, (c) => c.volume), candles);
