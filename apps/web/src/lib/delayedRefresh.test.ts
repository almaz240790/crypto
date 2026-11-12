import { describe, expect, it } from "vitest";
import { DelayedRefresh } from "./delayedRefresh";

/** Перечитывание слоёв после закрытия свечи и по событию сигнала (OVL-1): с паузой, пачкой, с ограниченным повтором. */

function fakeTimers() {
  let now = 0;
  const queue: { at: number; fn: () => void; id: number }[] = [];
  let id = 0;
  return {
    timers: {
      set: (fn: () => void, ms: number) => {
        queue.push({ at: now + ms, fn, id: ++id });
        return id;
      },
      clear: (t: unknown) => {
        const i = queue.findIndex((q) => q.id === t);
        if (i >= 0) queue.splice(i, 1);
      },
    },
    /** Время идёт на ms: таймеры срабатывают по порядку, каждый — в свой момент (поставленные ими — тоже). */
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        queue.sort((a, b) => a.at - b.at);
        const q = queue[0];
        if (!q || q.at > end) break;
        queue.shift();
        now = q.at;
        q.fn();
      }
      now = end;
    },
    pending: () => queue.length,
    time: () => now,
  };
}

describe("DelayedRefresh", () => {
  it("перечитывает через паузу, не раньше; просьбы во время паузы — одно перечитывание", () => {
    const t = fakeTimers();
    let runs = 0;
    const r = new DelayedRefresh(20_000, 3, t.timers);
    const run = (done: (stale: boolean) => void) => (runs++, done(false));
    r.request(run);
    t.advance(10_000);
    let latest = 0;
    r.request((done) => (latest++, run(done)));
    expect(runs).toBe(0);
    t.advance(10_000);
    expect([runs, latest]).toEqual([1, 1]); // одно перечитывание — с run последней просьбы
    t.advance(60_000);
    expect(runs).toBe(1);
    // следующее закрытие — снова
    r.request(run);
    t.advance(20_000);
    expect(runs).toBe(2);
  });

  it("сервер отстал — повтор через ту же паузу, не больше retries раз подряд", () => {
    const t = fakeTimers();
    let runs = 0;
    const r = new DelayedRefresh(20_000, 2, t.timers);
    r.request((done) => (runs++, done(true)));
    t.advance(20_000);
    expect(runs).toBe(1);
    t.advance(20_000);
    expect(runs).toBe(2);
    t.advance(20_000);
    expect(runs).toBe(3);
    t.advance(100_000);
    expect(runs).toBe(3);
    expect(t.pending()).toBe(0);
  });

  it("догнал — повторов нет; ответ не пришёл (сеть) — повторов нет, следующее закрытие попросит снова", () => {
    const t = fakeTimers();
    const stale = [true, false];
    let runs = 0;
    const r = new DelayedRefresh(1000, 5, t.timers);
    r.request((done) => done(stale[runs++] ?? false));
    t.advance(10_000);
    expect(runs).toBe(2);
    let silent = 0;
    const s = new DelayedRefresh(1000, 5, t.timers);
    s.request(() => void silent++);
    t.advance(10_000);
    expect(silent).toBe(1);
  });

  it("dispose (смена инструмента, таймфрейма) — ожидающее перечитывание и его повтор отменены", () => {
    const t = fakeTimers();
    let runs = 0;
    let finish: ((stale: boolean) => void) | null = null;
    const r = new DelayedRefresh(1000, 3, t.timers);
    r.request(() => void runs++);
    r.dispose();
    t.advance(10_000);
    expect(runs).toBe(0);
    expect(t.pending()).toBe(0);
    // ответ, пришедший после dispose, повтора не ставит
    r.request((done) => (runs++, (finish = done)));
    t.advance(1000);
    expect(runs).toBe(1);
    r.dispose();
    finish!(true);
    t.advance(10_000);
    expect(runs).toBe(1);
    expect(t.pending()).toBe(0);
  });

  it("после dispose тот же объект снова принимает просьбы: StrictMode снимает и заново ставит эффекты, объект из useMemo — прежний", () => {
    const t = fakeTimers();
    let runs = 0;
    const r = new DelayedRefresh(1000, 0, t.timers);
    r.dispose(); // разработка: эффект снят и поставлен заново до первой просьбы
    r.request((done) => (runs++, done(false)));
    t.advance(1000);
    expect(runs).toBe(1);
  });

  it("пауза — функцией: у каждого ожидания своя (разброс, чтобы графики всех пользователей не шли на сервер в одну секунду)", () => {
    const t = fakeTimers();
    const pauses = [25_000, 21_000];
    const at: number[] = [];
    const r = new DelayedRefresh(() => pauses.shift() ?? 20_000, 1, t.timers);
    r.request((done) => (at.push(t.time()), done(true)));
    t.advance(60_000);
    expect(at).toEqual([25_000, 46_000]);
  });
});
