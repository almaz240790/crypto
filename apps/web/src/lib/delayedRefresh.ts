/**
 * Перечитывание данных с паузой (слои терминала, план 2A.4; ADR-0010): просьбы, пришедшие, пока ждём, сливаются в
 * одно перечитывание (с run последней просьбы, как у CatchUpGate); run сообщает (done(true)), что сервер ещё
 * отстаёт, — повтор через ту же паузу, не больше retries раз подряд. Таймер — подменяемый (vitest).
 */
export type RefreshRun = (done: (stale: boolean) => void) => void;

type Timers = { set: (fn: () => void, ms: number) => unknown; clear: (t: unknown) => void };
const REAL: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) };

export class DelayedRefresh {
  private timer: unknown = null;
  private run: RefreshRun | null = null;
  private disposed = false;

  constructor(
    private readonly delayMs: number,
    private readonly retries = 0,
    private readonly timers: Timers = REAL,
  ) {}

  /** Попросить перечитывание через паузу; уже ждём — то же перечитывание, с этим run. */
  request(run: RefreshRun): void {
    this.run = run;
    this.schedule(0);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }

  private schedule(attempt: number): void {
    if (this.disposed || this.timer !== null) return;
    this.timer = this.timers.set(() => {
      this.timer = null;
      if (this.disposed || !this.run) return;
      this.run((stale) => {
        if (stale && attempt < this.retries) this.schedule(attempt + 1);
      });
    }, this.delayMs);
  }
}
