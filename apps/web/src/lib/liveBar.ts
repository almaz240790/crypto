/**
 * Живая текущая свеча графика (план 2A.3, ADR-0010): автомат из @platform/charts плюс подписчики.
 * Тики, формирующаяся и закрытая минуты меняют свечу здесь и сразу уходят графику (ChartSurface
 * подписывается и обновляет серию инкрементально — без React и без setCandles). React узнаёт только
 * о закрытии свечи, уточнении закрытой и, редко, о текущей — для индикаторов и отсчёта до закрытия.
 *
 * События до загрузки свечей не теряются: копятся (не больше EARLY_MAX) и сворачиваются в свечу при
 * старте. После переподключения или пропуска (`gap`) свежая история с сервера вливается через `resync`.
 */
import { liveCandle, liveForming, liveRestart, liveStart, liveTick, type Candle, type LiveBarState, type LiveStep, type Timeframe } from "@platform/charts";
import type { LiveBarMsg, LiveCandle, LiveTick } from "./useLive";

/** Шаг живой свечи для графика; `merge` — свежая история справа (вставить и заменить по времени). */
export type LiveEvent = LiveStep & { merge?: Candle[] };
export type LiveListener = (step: LiveEvent) => void;

/** Подписка графика на живую свечу; отписка — возвращаемой функцией. */
export type LiveSource = { subscribe(fn: LiveListener): () => void };

/** Сколько событий до загрузки свечей держим (тики раз в секунду — пара минут). */
export const EARLY_MAX = 200;

export function barFromMsg(c: LiveBarMsg, open: boolean): Candle {
  return { time: c.t, open: Number(c.o), high: Number(c.h), low: Number(c.l), close: Number(c.c), volume: Number(c.v), open_: open };
}

/** Момент снимка формирующейся минуты (unix с); нет или не разобрать — undefined. */
function asOf(c: LiveBarMsg): number | undefined {
  const t = c.at ? Date.parse(c.at) : Number.NaN;
  return Number.isFinite(t) ? t / 1000 : undefined;
}

/** Замена свечи с тем же временем; нет такой — тот же массив. */
export function replaceByTime(list: readonly Candle[], c: Candle): Candle[] {
  for (let i = list.length - 1; i >= 0 && list[i]!.time >= c.time; i--) {
    if (list[i]!.time !== c.time) continue;
    const next = list.slice();
    next[i] = c;
    return next;
  }
  return list as Candle[];
}

/**
 * Свежая история с сервера в историю React: свечи с тем же временем заменяются, новее последней —
 * дописываются; свечи не старше `before` (текущей) не берутся. Вставок в середину нет — данные графика
 * дописываются (append) и вид не сбрасывается; график получает их отдельно (Terminal.merge).
 */
export function mergeHistory(prev: readonly Candle[], fresh: readonly Candle[], before: number): Candle[] {
  let next = prev as Candle[];
  const last = prev.at(-1)?.time ?? -Infinity;
  const tail: Candle[] = [];
  for (const c of fresh) {
    if (c.time >= before) continue;
    if (c.time > last) tail.push(c);
    else next = replaceByTime(next, c);
  }
  return tail.length ? [...next, ...tail] : next;
}

type Early = { kind: "tick"; m: LiveTick } | { kind: "forming" | "candle"; m: LiveCandle };

export class LiveBar implements LiveSource {
  private state: LiveBarState | null = null;
  private early: Early[] = [];
  private readonly listeners = new Set<LiveListener>();

  constructor(
    readonly symbol: string,
    readonly tf: Timeframe,
  ) {}

  /**
   * Свечи с сервера загружены (`history` — закрытые, `current` — текущая): дальше события меняют
   * текущую свечу. События, пришедшие до загрузки, сворачиваются сразу; возвращается история с их
   * поправками (уточнённые и закрытые ими свечи) — её и показывать, текущая — `bar`.
   */
  start(current: Candle | null, history: readonly Candle[] = []): Candle[] {
    this.state = liveStart(this.tf, current, history.at(-1) ?? null);
    let hist = history.slice();
    const early = this.early;
    this.early = [];
    for (const e of early) {
      const step = this.apply(e);
      if (!step) continue;
      this.state = step.state;
      if (step.amended) hist = replaceByTime(hist, step.amended);
      if (step.closed.length) hist = [...hist, ...step.closed];
    }
    return hist;
  }

  get started(): boolean {
    return this.state !== null;
  }

  get bar(): Candle | null {
    return this.state?.head ?? null;
  }

  subscribe(fn: LiveListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  tick(m: LiveTick): LiveStep | null {
    return this.event({ kind: "tick", m });
  }

  forming(m: LiveCandle): LiveStep | null {
    return this.event({ kind: "forming", m });
  }

  candle(m: LiveCandle): LiveStep | null {
    return this.event({ kind: "candle", m });
  }

  /**
   * Свежая история с сервера после переподключения или пропуска: автомат перезапускается (то, что он
   * знает новее сервера, сохраняется), график получает историю для вставки (`merge`).
   */
  resync(current: Candle | null, history: readonly Candle[]): LiveEvent | null {
    if (!this.state) return null;
    const last = history.at(-1) ?? null;
    const state = liveRestart(this.state, this.tf, current, last);
    this.state = state;
    const merge = history.slice();
    if (state.tail && (!last || state.tail.time > last.time)) merge.push(state.tail);
    const ev: LiveEvent = { state, bar: state.head, closed: [], amended: null, gap: false, merge };
    for (const fn of this.listeners) fn(ev);
    return ev;
  }

  private event(e: Early): LiveStep | null {
    if (e.m.s !== this.symbol) return null;
    if (!this.state) {
      this.early.push(e);
      if (this.early.length > EARLY_MAX) this.early.shift();
      return null;
    }
    const step = this.apply(e);
    return step ? this.emit(step) : null;
  }

  private apply(e: Early): LiveStep | null {
    const s = this.state!;
    if (e.kind === "tick") return liveTick(s, Number(e.m.p), Date.parse(e.m.at) / 1000);
    if (e.kind === "forming") return liveForming(s, barFromMsg(e.m.c, true), asOf(e.m.c));
    return liveCandle(s, barFromMsg(e.m.c, false));
  }

  private emit(step: LiveStep): LiveStep | null {
    const changed = step.bar !== this.state?.head || step.closed.length > 0 || step.amended !== null || step.gap;
    this.state = step.state;
    if (!changed) return null;
    for (const fn of this.listeners) fn(step);
    return step;
  }
}
