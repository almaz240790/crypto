/**
 * Живая свеча графика (план 2A.3, 2A.7; ADR-0010, ADR-0003): автомат из @platform/charts плюс история закрытых свечей
 * и подписчики — единственный источник правды и для истории React, и для графика. Тики, формирующаяся и закрытая
 * минуты меняют свечу здесь и сразу уходят графику (ChartSurface подписывается и обновляет серию инкрементально — без
 * React и без setCandles). React узнаёт о закрытии свечи, уточнении закрытой и, редко, о текущей — для индикаторов и
 * отсчёта до закрытия.
 *
 * События до загрузки свечей не теряются: копятся (не больше EARLY_MAX) и сворачиваются в свечу при старте; through
 * ответа истории (последняя закрытая минута в БД) — lastClosed автомата: минуты, уже учтённые текущей свечой, не
 * считаются дважды. Догон (переподключение, пропуск, возврат вкладки, просрочка) — catchUp: порция истории сливается с
 * концом (catchUpLive), текущую с тиками решает liveRestart, график получает хвост для Terminal.replaceTail или замену
 * целиком. Когда догонять, решает CatchUpGate — не больше одного запроса за раз.
 */
import { catchUpLive, firstChange, liveCandle, liveDueAt, liveForming, liveRestart, liveStart, liveTick, type Candle, type LiveBarState, type LiveStep, type Timeframe } from "@platform/charts";
import type { LiveBarMsg, LiveCandle, LiveTick } from "./useLive";

/**
 * Шаг живой свечи для графика. Догон: `tail` — свечи графика с from заменить bars (Terminal.replaceTail: устаревшая
 * текущая уходит, подгруженная слева история и вид остаются); `reset` — история заменена целиком (разрыв длиннее порции).
 */
export type LiveEvent = LiveStep & { tail?: { from: number; bars: Candle[] }; reset?: { candles: Candle[]; hasOlder: boolean } };
export type LiveListener = (step: LiveEvent) => void;

/** Подписка графика на живую свечу; отписка — возвращаемой функцией. snapshot — история и текущая для замены свечей. */
export type LiveSource = { subscribe(fn: LiveListener): () => void; snapshot(): { closed: readonly Candle[]; bar: Candle | null } };

/** Сколько событий до загрузки свечей держим (тики раз в секунду — пара минут). */
export const EARLY_MAX = 200;

/** Догон по пропуску в живых событиях — не чаще, мс (после любого догона). */
export const RESYNC_MIN_MS = 10_000;
/** Догон по просрочке — не чаще, мс; если сервер сам отстаёт (новой свечи нет и после ответа), пауза удваивается. */
export const LIVE_RETRY_MS = 15_000;
export const LIVE_BACKOFF_MAX_MS = 300_000;

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

const sameCandle = (a: Candle | null, b: Candle | null): boolean => (a === null || b === null ? a === b : firstChange([a], [b]) === 1);

type Early = { kind: "tick"; m: LiveTick } | { kind: "forming" | "candle"; m: LiveCandle };

export class LiveBar implements LiveSource {
  private state: LiveBarState | null = null;
  /** Закрытые свечи (история React): ответ истории, закрытые автоматом и порции догона. */
  private hist: Candle[] = [];
  private early: Early[] = [];
  private readonly listeners = new Set<LiveListener>();

  constructor(
    readonly symbol: string,
    readonly tf: Timeframe,
  ) {}

  /**
   * Свечи с сервера загружены (`history` — закрытые, `current` — текущая, `through` — последняя закрытая минута,
   * учтённая ответом): дальше события меняют текущую свечу. События, пришедшие до загрузки, сворачиваются сразу;
   * возвращается история с их поправками (уточнённые и закрытые ими свечи) — её и показывать, текущая — `bar`.
   */
  start(current: Candle | null, history: readonly Candle[] = [], through?: number | null): Candle[] {
    this.state = liveStart(this.tf, current, history.at(-1) ?? null, through);
    this.hist = history.slice();
    const early = this.early;
    this.early = [];
    for (const e of early) {
      const step = this.apply(e);
      if (!step) continue;
      this.state = step.state;
      this.record(step);
    }
    return this.hist;
  }

  get started(): boolean {
    return this.state !== null;
  }

  get bar(): Candle | null {
    return this.state?.head ?? null;
  }

  /** Закрытые свечи — новый массив при каждом изменении (состояние React). */
  get closed(): Candle[] {
    return this.hist;
  }

  snapshot(): { closed: Candle[]; bar: Candle | null } {
    return { closed: this.hist, bar: this.bar };
  }

  /** Когда новая свеча просрочена (unix с, liveDueAt); null — не начато или свечей нет. */
  dueAt(grace: number): number | null {
    return this.state ? liveDueAt(this.state, grace) : null;
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
   * Догон: свежая порция истории с сервера (page — закрытые, current — текущая ответа, through — его последняя учтённая
   * минута, serverTime — время ответа). Закрытые свечи порции заменяют свои времена, история старее порции — те же
   * объекты, закрытые потоком после ответа — остаются (catchUpLive); порция не стыкуется — история заменяется. Текущая —
   * новее из двух, у той же свечи — объём из стороны с большим числом целых минут, high/low — объединение, close тика
   * новее ответа, неподтверждённые минуты после through — сверху (liveRestart). Тики, пришедшие во время запроса, уже
   * в автомате и на графике — ответ их не откатывает.
   *
   * null — не начато или ничего не изменилось; иначе шаг уже отдан подписчикам: `tail` или `reset`.
   */
  catchUp(page: readonly Candle[], current: Candle | null, through: number | null, serverTime: number | undefined, hasOlder: boolean): LiveEvent | null {
    const s = this.state;
    if (!s) return null;
    const old = this.hist;
    const { bars, replaced } = catchUpLive({ closed: old, current: s.head, through: s.lastClosed }, page, current, through ?? -Infinity, this.tf);
    const state = liveRestart(s, this.tf, bars.current, bars.closed.at(-1) ?? null, through, serverTime);
    this.state = state;
    const next = bars.closed as Candle[];
    const head = state.head;
    const base = { state, bar: head, closed: [], amended: null, gap: false };
    let ev: LiveEvent;
    if (replaced) {
      this.hist = next.slice();
      ev = { ...base, reset: { candles: head ? [...this.hist, head] : this.hist.slice(), hasOlder } };
    } else {
      const i = firstChange(old, next);
      if (i === old.length && next.length === old.length && sameCandle(s.head, head)) return null;
      const from = i < old.length || i < next.length ? Math.min(old[i]?.time ?? Infinity, next[i]?.time ?? Infinity) : (old.at(-1)?.time ?? -Infinity) + 1;
      this.hist = next;
      ev = { ...base, tail: { from, bars: head ? [...next.slice(i), head] : next.slice(i) } };
    }
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

  /** История React: уточнённая закрытая — на месте, закрытые событием — справа. */
  private record(step: LiveStep): void {
    if (step.amended) this.hist = replaceByTime(this.hist, step.amended);
    if (step.closed.length) this.hist = [...this.hist, ...step.closed];
  }

  private emit(step: LiveStep): LiveStep | null {
    const changed = step.bar !== this.state?.head || step.closed.length > 0 || step.amended !== null || step.gap;
    this.state = step.state;
    if (!changed) return null;
    this.record(step);
    for (const fn of this.listeners) fn(step);
    return step;
  }
}

/** Повод догона: сокет открыт заново, вкладка снова видна (сокет не открыт), пропуск в событиях, просрочка. */
export type CatchUpReason = "reconnect" | "wake" | "gap" | "overdue";

/**
 * Когда догонять (план 2A.7, ADR-0003/0010): одна очередь на все поводы — никогда не два запроса сразу.
 * - reconnect во время запроса — ровно один повтор после него (минуты за обрыв могли не попасть в ответ);
 * - wake, gap, overdue во время запроса — отбрасываются: их покрывает ответ, который уже в пути;
 * - gap — не чаще RESYNC_MIN_MS после любого догона;
 * - overdue — не чаще паузы (LIVE_RETRY_MS), которая удваивается до LIVE_BACKOFF_MAX_MS, пока сервер сам отстаёт.
 * run выполняет запрос и сообщает, просрочена ли свеча и после ответа (сервер отстаёт); повтор после reconnect — с run
 * последней просьбы. Часы — подменяемые (vitest).
 */
export type CatchUpRun = () => Promise<boolean | void>;

export class CatchUpGate {
  private busy = false;
  private again: CatchUpRun | null = null;
  private last = -Infinity;
  private backoff = LIVE_RETRY_MS;

  constructor(private readonly clock: () => number = () => Date.now()) {}

  get inFlight(): boolean {
    return this.busy;
  }

  /** Текущая пауза догона по просрочке, мс. */
  get overdueEvery(): number {
    return this.backoff;
  }

  /** Попросить догон; true — запрос начат. */
  request(reason: CatchUpReason, run: CatchUpRun): boolean {
    if (this.busy) {
      if (reason === "reconnect") this.again = run;
      return false;
    }
    const now = this.clock();
    if (reason === "gap" && now - this.last < RESYNC_MIN_MS) return false;
    if (reason === "overdue" && now - this.last < this.backoff) return false;
    this.busy = true;
    this.last = now;
    void run()
      .then((late) => {
        this.backoff = late ? Math.min(this.backoff * 2, LIVE_BACKOFF_MAX_MS) : LIVE_RETRY_MS;
      })
      .catch(() => {
        // сеть недоступна — следующая попытка по таймеру просрочки или событию
      })
      .finally(() => {
        this.busy = false;
        const next = this.again;
        this.again = null;
        if (next) this.request("reconnect", next);
      });
    return true;
  }
}
