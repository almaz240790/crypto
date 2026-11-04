/**
 * Живая текущая свеча графика (план 2A.3, ADR-0010): автомат из @platform/charts плюс подписчики.
 * Тики, формирующаяся и закрытая минуты меняют свечу здесь и сразу уходят графику (ChartSurface
 * подписывается и обновляет серию инкрементально — без React и без setCandles). React узнаёт только
 * о закрытии свечи, уточнении закрытой и, редко, о текущей — для индикаторов и отсчёта до закрытия.
 */
import { liveCandle, liveForming, liveStart, liveTick, type Candle, type LiveBarState, type LiveStep, type Timeframe } from "@platform/charts";
import type { LiveBarMsg, LiveCandle, LiveTick } from "./useLive";

export type LiveListener = (step: LiveStep) => void;

/** Подписка графика на живую свечу; отписка — возвращаемой функцией. */
export type LiveSource = { subscribe(fn: LiveListener): () => void };

export function barFromMsg(c: LiveBarMsg, open: boolean): Candle {
  return { time: c.t, open: Number(c.o), high: Number(c.h), low: Number(c.l), close: Number(c.c), volume: Number(c.v), open_: open };
}

export class LiveBar implements LiveSource {
  private state: LiveBarState | null = null;
  private readonly listeners = new Set<LiveListener>();

  constructor(
    readonly symbol: string,
    readonly tf: Timeframe,
  ) {}

  /** Свечи с сервера загружены: дальше события меняют текущую свечу. До этого — только цена в шапке. */
  start(current: Candle | null): void {
    this.state = liveStart(this.tf, current);
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
    if (m.s !== this.symbol || !this.state) return null;
    return this.emit(liveTick(this.state, Number(m.p), Date.parse(m.at) / 1000));
  }

  forming(m: LiveCandle): LiveStep | null {
    if (m.s !== this.symbol || !this.state) return null;
    return this.emit(liveForming(this.state, barFromMsg(m.c, true)));
  }

  candle(m: LiveCandle): LiveStep | null {
    if (m.s !== this.symbol || !this.state) return null;
    return this.emit(liveCandle(this.state, barFromMsg(m.c, false)));
  }

  private emit(step: LiveStep): LiveStep | null {
    const changed = step.bar !== this.state?.head || step.closed.length > 0 || step.amended !== null;
    this.state = step.state;
    if (!changed) return null;
    for (const fn of this.listeners) fn(step);
    return step;
  }
}
