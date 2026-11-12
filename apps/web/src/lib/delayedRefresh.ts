/**
 * Перечитывание данных с паузой (слои терминала, план 2A.4; ADR-0010): просьбы, пришедшие, пока ждём, сливаются в
 * одно перечитывание (с run последней просьбы, как у CatchUpGate); run сообщает (done(true)), что сервер ещё
 * отстаёт, — повтор через ту же паузу, не больше retries раз подряд. Пауза — число или функция (своя у каждого
 * ожидания: разброс, чтобы графики всех пользователей не шли на сервер в одну и ту же секунду после закрытия).
 * Таймер — подменяемый (vitest).
 */
export type RefreshRun = (done: (stale: boolean) => void) => void;

type Timers = { set: (fn: () => void, ms: number) => unknown; clear: (t: unknown) => void };
const REAL: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) };

export class DelayedRefresh {
  private timer: unknown = null;
  private run: RefreshRun | null = null;
  /** Номер очереди: dispose его меняет — ответ, начатый до dispose, повтора не ставит. */
  private epoch = 0;

  constructor(
    private readonly delayMs: number | (() => number),
    private readonly retries = 0,
    private readonly timers: Timers = REAL,
  ) {}

  /** Попросить перечитывание через паузу; уже ждём — то же перечитывание, с этим run. */
  request(run: RefreshRun): void {
    this.run = run;
    this.schedule(0);
  }

  /**
   * Отменить ожидание и повторы (смена инструмента или таймфрейма, размонтирование). Объект остаётся рабочим, как
   * HeaderPrice: в разработке StrictMode снимает и заново ставит эффекты, а объект из useMemo — тот же, и просьбы
   * после этого должны перечитывать.
   */
  dispose(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    this.run = null;
    this.epoch++;
  }

  private schedule(attempt: number): void {
    if (this.timer !== null) return;
    const epoch = this.epoch;
    const ms = typeof this.delayMs === "function" ? this.delayMs() : this.delayMs;
    this.timer = this.timers.set(() => {
      this.timer = null;
      if (epoch !== this.epoch || !this.run) return;
      this.run((stale) => {
        if (stale && attempt < this.retries && epoch === this.epoch) this.schedule(attempt + 1);
      });
    }, ms);
  }
}
