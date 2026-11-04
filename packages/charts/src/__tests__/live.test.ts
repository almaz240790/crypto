import { describe, expect, it } from "vitest";
import { bucketStart, foldMinute, isClosed, LIVE_PENDING_MINUTES, liveCandle, liveForming, liveRestart, liveStart, liveTick, nextBucket, secondsToClose, type LiveStep } from "../live";
import type { Candle } from "../types";

const m1 = (time: number, o: number, h: number, l: number, c: number, v = 1): Candle => ({ time, open: o, high: h, low: l, close: c, volume: v, open_: false });

describe("живая свеча", () => {
  it("начало интервала: 4h, 1d, неделя с понедельника", () => {
    const wed = Date.UTC(2026, 9, 28, 13, 37) / 1000; // среда
    expect(bucketStart("4h", wed)).toBe(Date.UTC(2026, 9, 28, 12) / 1000);
    expect(bucketStart("1d", wed)).toBe(Date.UTC(2026, 9, 28) / 1000);
    expect(bucketStart("1w", wed)).toBe(Date.UTC(2026, 9, 26) / 1000);
    const mon = Date.UTC(2026, 9, 26, 0, 30) / 1000;
    expect(bucketStart("1w", mon)).toBe(Date.UTC(2026, 9, 26) / 1000);
  });

  it("свёртка минутных свечей в текущую 4h и переход в новую корзину", () => {
    const t0 = Date.UTC(2026, 9, 28, 12) / 1000;
    let cur = foldMinute(null, m1(t0, 100, 101, 99, 100.5), "4h");
    expect(cur).toMatchObject({ time: t0, open: 100, high: 101, low: 99, close: 100.5, volume: 1, open_: true });
    cur = foldMinute(cur, m1(t0 + 60, 100.5, 103, 100, 102, 2), "4h");
    expect(cur).toMatchObject({ open: 100, high: 103, low: 99, close: 102, volume: 3 });
    const next = foldMinute(cur, m1(t0 + 4 * 3600, 102, 102, 101, 101.5), "4h");
    expect(next).toMatchObject({ time: t0 + 4 * 3600, open: 102, volume: 1 });
    expect(isClosed(cur, "4h", t0 + 4 * 3600)).toBe(true);
    expect(isClosed(next, "4h", t0 + 4 * 3600 + 10)).toBe(false);
    expect(secondsToClose("4h", t0, t0 + 1000)).toBe(4 * 3600 - 1000);
  });
});

/** Последовательность событий автомата живой свечи; возвращает все шаги. */
function run(start: ReturnType<typeof liveStart>, events: ((s: ReturnType<typeof liveStart>) => LiveStep)[]): LiveStep[] {
  const out: LiveStep[] = [];
  let st = start;
  for (const e of events) {
    const step = e(st);
    out.push(step);
    st = step.state;
  }
  return out;
}

const T4 = Date.UTC(2026, 9, 28, 8) / 1000; // 08:00 UTC — начало свечи H4
const H4 = 4 * 3600;
const cur4h: Candle = { time: T4, open: 100, high: 105, low: 95, close: 101, volume: 1000, open_: true };

describe("живая свеча: тики, формирующаяся минута, запоздавшие закрытые минуты (ADR-0010)", () => {
  it("тик внутри интервала: close = цена, high/low расширяются, объём тот же, нового бара нет", () => {
    const steps = run(liveStart("4h", cur4h), [
      (s) => liveTick(s, 106, T4 + 3600 + 5),
      (s) => liveTick(s, 94.5, T4 + 3600 + 6),
      (s) => liveTick(s, 100.2, T4 + 3600 + 70),
    ]);
    for (const st of steps) {
      expect(st.closed).toEqual([]);
      expect(st.bar!.time).toBe(T4);
    }
    expect(steps[0]!.bar).toMatchObject({ open: 100, high: 106, low: 95, close: 106, volume: 1000, open_: true });
    expect(steps[1]!.bar).toMatchObject({ high: 106, low: 94.5, close: 94.5, volume: 1000 });
    expect(steps[2]!.bar).toMatchObject({ high: 106, low: 94.5, close: 100.2, volume: 1000 });
  });

  it("первый тик следующего интервала закрывает свечу и открывает новую с ценой тика", () => {
    const [a, b] = run(liveStart("4h", cur4h), [(s) => liveTick(s, 102, T4 + H4 - 2), (s) => liveTick(s, 103, T4 + H4 + 1)]);
    expect(a!.closed).toEqual([]);
    expect(b!.closed).toEqual([{ time: T4, open: 100, high: 105, low: 95, close: 102, volume: 1000, open_: false }]);
    expect(b!.bar).toEqual({ time: T4 + H4, open: 103, high: 103, low: 103, close: 103, volume: 0, open_: true });
  });

  it("формирующаяся минута: объём минуты заменяется, а не копится; закрытие минуты — без двойного счёта", () => {
    const m = T4 + 600;
    const steps = run(liveStart("4h", cur4h), [
      (s) => liveForming(s, { time: m, open: 101, high: 103, low: 100, close: 102, volume: 5, open_: true }),
      (s) => liveTick(s, 108, m + 20),
      (s) => liveForming(s, { time: m, open: 101, high: 104, low: 99, close: 103, volume: 9, open_: true }),
      (s) => liveCandle(s, { time: m, open: 101, high: 108, low: 99, close: 104, volume: 12, open_: false }),
      (s) => liveForming(s, { time: m, open: 1, high: 1, low: 1, close: 1, volume: 1, open_: true }), // устарела
    ]);
    expect(steps[0]!.bar).toMatchObject({ high: 105, low: 95, close: 102, volume: 1005 });
    expect(steps[1]!.bar).toMatchObject({ high: 108, close: 108, volume: 1005 });
    // снимок после тика (без момента снимка — старый сервер): high и close тика сохраняются,
    // low и объём — со снимка; close не откатывается к цене опроса (W3)
    expect(steps[2]!.bar).toMatchObject({ high: 108, low: 95, close: 108, volume: 1009 });
    expect(steps[3]!.bar).toMatchObject({ high: 108, low: 95, close: 104, volume: 1012 });
    expect(steps[4]!.bar).toEqual(steps[3]!.bar);
    expect(steps.every((st) => st.bar!.time === T4 && st.closed.length === 0)).toBe(true);
  });

  it("H4: закрытая минута 11:59 после первого тика 12:00 уточняет закрытую свечу (amended), новую не трогает", () => {
    const last = T4 + H4 - 60;
    const steps = run(liveStart("4h", cur4h), [
      (s) => liveTick(s, 104, last + 30),
      (s) => liveTick(s, 104.5, T4 + H4 + 1),
      (s) => liveCandle(s, { time: last, open: 103, high: 110, low: 103, close: 104.2, volume: 50, open_: false }),
      (s) => liveCandle(s, { time: T4 + H4, open: 104.3, high: 104.6, low: 104, close: 104.4, volume: 7, open_: false }),
    ]);
    expect(steps[1]!.closed[0]).toMatchObject({ time: T4, high: 105, close: 104, volume: 1000 });
    expect(steps[2]!.closed).toEqual([]);
    expect(steps[2]!.amended).toEqual({ time: T4, open: 100, high: 110, low: 95, close: 104.2, volume: 1050, open_: false });
    expect(steps[2]!.bar).toMatchObject({ time: T4 + H4, close: 104.5 });
    // закрытая минута новой свечи заменяет предварительную от тика (объём — с биржи)
    expect(steps[3]!.amended).toBeNull();
    expect(steps[3]!.bar).toEqual({ time: T4 + H4, open: 104.3, high: 104.6, low: 104, close: 104.4, volume: 7, open_: true });
  });

  it("1m: тик следующей минуты закрывает предварительную, запоздавшая закрытая минута её уточняет", () => {
    const t = T4 + 300;
    const steps = run(liveStart("1m", { time: t, open: 10, high: 11, low: 9, close: 10.5, volume: 3, open_: true }), [
      (s) => liveForming(s, { time: t, open: 10, high: 11.5, low: 9, close: 11, volume: 4, open_: true }),
      (s) => liveTick(s, 11.2, t + 61),
      (s) => liveCandle(s, { time: t, open: 10, high: 11.6, low: 9, close: 11.1, volume: 6, open_: false }),
      (s) => liveTick(s, 11.3, t + 62),
    ]);
    expect(steps[0]!.bar).toEqual({ time: t, open: 10, high: 11.5, low: 9, close: 11, volume: 4, open_: true });
    expect(steps[1]!.closed).toEqual([{ time: t, open: 10, high: 11.5, low: 9, close: 11, volume: 4, open_: false }]);
    expect(steps[1]!.bar).toMatchObject({ time: t + 60, close: 11.2, volume: 0 });
    expect(steps[2]!.amended).toEqual({ time: t, open: 10, high: 11.6, low: 9, close: 11.1, volume: 6, open_: false });
    expect(steps[3]!.bar).toMatchObject({ time: t + 60, high: 11.3, low: 11.2, close: 11.3 });
    expect(steps[3]!.amended).toBeNull();
  });

  it("только закрытые минуты (старый протокол) — как foldMinute: свёртка и закрытие по минуте нового интервала", () => {
    const steps = run(liveStart("4h", cur4h), [
      (s) => liveCandle(s, { time: T4 + 60, open: 101, high: 107, low: 100, close: 106, volume: 10, open_: false }),
      (s) => liveCandle(s, { time: T4 + H4, open: 106, high: 106, low: 105, close: 105.5, volume: 2, open_: false }),
      (s) => liveCandle(s, { time: T4 + 60, open: 1, high: 1, low: 1, close: 1, volume: 1, open_: false }), // повтор
    ]);
    expect(steps[0]!.bar).toEqual(foldMinute(cur4h, { time: T4 + 60, open: 101, high: 107, low: 100, close: 106, volume: 10, open_: false }, "4h"));
    expect(steps[1]!.closed).toEqual([{ time: T4, open: 100, high: 107, low: 95, close: 106, volume: 1010, open_: false }]);
    expect(steps[1]!.bar).toMatchObject({ time: T4 + H4, open: 106, volume: 2 });
    expect(steps[2]!.bar).toEqual(steps[1]!.bar);
  });

  it("устаревшие и битые тики не трогают свечу; без данных тик открывает первую", () => {
    const empty = liveStart("1h", null);
    const first = liveTick(empty, 50, T4 + 10);
    expect(first.bar).toMatchObject({ time: T4, open: 50, close: 50 });
    expect(first.closed).toEqual([]);
    expect(liveTick(first.state, Number.NaN, T4 + 20).bar).toBe(first.bar);
    const closed = liveCandle(first.state, { time: T4, open: 50, high: 51, low: 49, close: 50.5, volume: 3, open_: false });
    expect(liveTick(closed.state, 70, T4 + 30).bar).toBe(closed.bar); // минута уже закрыта
  });

  it("неподтверждённых минут не больше LIVE_PENDING_MINUTES: старшие считаются закрытыми", () => {
    let st = liveStart("1h", { ...cur4h });
    for (let i = 0; i < LIVE_PENDING_MINUTES + 3; i++) st = liveTick(st, 100 + i, T4 + i * 60 + 1).state;
    expect(st.minutes).toHaveLength(LIVE_PENDING_MINUTES);
    expect(st.lastClosed).toBe(T4 + 2 * 60);
    expect(st.head).toMatchObject({ time: T4, high: 107, low: 95, close: 107, volume: 1000 });
  });
});

describe("живая свеча: снимок минуты против тика (W3, B6)", () => {
  const m = T4 + 600;
  const snap = (close: number): Candle => ({ time: m, open: 101, high: 102, low: 100.5, close, volume: 9, open_: true });

  it("снимок старше тика (момент снимка раньше) close не откатывает; новее — close со снимка", () => {
    const ticked = run(liveStart("4h", cur4h), [(s) => liveTick(s, 102, m + 10), (s) => liveTick(s, 103, m + 11)]).at(-1)!.state;
    const older = liveForming(ticked, snap(101.9), m + 9);
    expect(older.bar).toMatchObject({ close: 103, high: 105, low: 95, volume: 1009 });
    const newer = liveForming(ticked, snap(101.9), m + 12);
    expect(newer.bar).toMatchObject({ close: 101.9, volume: 1009 });
    // тик другой минуты — снимок этой минуты close берёт свой
    expect(liveForming(ticked, { ...snap(101.9), time: m + 60 }).bar).toMatchObject({ close: 101.9 });
  });

  it("тик не по порядку (старше последнего) расширяет high/low, но close не трогает", () => {
    const steps = run(liveStart("4h", cur4h), [(s) => liveTick(s, 103, m + 11), (s) => liveTick(s, 110, m + 10)]);
    expect(steps[1]!.bar).toMatchObject({ close: 103, high: 110 });
  });
});

describe("живая свеча: последняя закрытая свеча истории (W1) и пропуски (W2)", () => {
  const M = Date.UTC(2026, 10, 4, 8, 30) / 1000; // 08:30
  const stale: Candle = { time: M, open: 100, high: 101, low: 99.5, close: 100.5, volume: 50, open_: false };

  it("1m без текущей свечи: тик новой минуты — текущая, запоздавшая закрытая минута заменяет свечу истории", () => {
    const steps = run(liveStart("1m", null, stale), [
      (s) => liveTick(s, 100.6, M + 62),
      (s) => liveCandle(s, { time: M, open: 100, high: 101.2, low: 99.3, close: 100.7, volume: 62, open_: false }),
      (s) => liveTick(s, 100.8, M + 90),
    ]);
    expect(steps[0]!.bar).toMatchObject({ time: M + 60, close: 100.6 });
    expect(steps[0]!.closed).toEqual([]);
    expect(steps[0]!.gap).toBe(false);
    // раньше: closed=[] и amended=null — свеча 08:30 оставалась со снимка 08:30:50 до перезагрузки
    expect(steps[1]!.amended).toEqual({ time: M, open: 100, high: 101.2, low: 99.3, close: 100.7, volume: 62, open_: false });
    expect(steps[1]!.bar).toBe(steps[0]!.bar);
    expect(steps[2]!.bar).toMatchObject({ time: M + 60, high: 100.8, low: 100.6, close: 100.8 });
  });

  it("4h, загрузка в 12:00:00.4 без текущей свечи: тик 11:59:59.8 правит свечу 08:00, а не заменяет её плоской", () => {
    const full: Candle = { time: T4, open: 95, high: 110, low: 90, close: 100.1, volume: 5000, open_: false };
    const steps = run(liveStart("4h", null, full), [
      (s) => liveTick(s, 100.3, T4 + H4 - 0.2),
      (s) => liveTick(s, 100.4, T4 + H4 + 1),
      (s) => liveCandle(s, { time: T4 + H4 - 60, open: 100.1, high: 110.5, low: 100, close: 100.3, volume: 7, open_: false }),
    ]);
    expect(steps[0]!.bar).toBeNull();
    expect(steps[0]!.amended).toEqual({ ...full, close: 100.3 });
    // первый тик нового интервала: новая текущая свеча, 08:00 второй раз в историю не дописывается
    expect(steps[1]!.closed).toEqual([]);
    expect(steps[1]!.bar).toMatchObject({ time: T4 + H4, open: 100.4, close: 100.4 });
    // закрытая минута 11:59: high, low, close — в 08:00; объём свечи истории не трогаем
    expect(steps[2]!.amended).toEqual({ ...full, high: 110.5, close: 100.3 });
    expect(steps[2]!.bar).toBe(steps[1]!.bar);
  });

  it("свеча истории и текущая с сервера: минута прошлого интервала уточняет историю, текущую не трогает", () => {
    const hist: Candle = { ...cur4h, open_: false };
    const st = liveStart("4h", { time: T4 + H4, open: 101, high: 101, low: 101, close: 101, volume: 1, open_: true }, hist);
    const step = liveCandle(st, { time: T4 + H4 - 60, open: 101, high: 106, low: 100, close: 100.9, volume: 3, open_: false });
    expect(step.amended).toEqual({ ...hist, high: 106, close: 100.9 });
    expect(step.bar).toBe(st.head);
    // минута старше свечи истории — устарела
    expect(liveCandle(step.state, { time: T4 - 60, open: 1, high: 1, low: 1, close: 1, volume: 1, open_: false }).amended).toBeNull();
  });

  it("пропуск: тик через интервал закрывает свечу и просит историю; минута пропущенного интервала — тоже", () => {
    const M1 = M + 60;
    const steps = run(liveStart("1m", { ...stale, open_: true }, { ...stale, time: M - 60 }), [
      (s) => liveTick(s, 101, M + 180 + 2), // сон телефона: M+1 и M+2 пропущены
      (s) => liveCandle(s, { time: M1, open: 100.5, high: 101, low: 100, close: 100.8, volume: 5, open_: false }),
      (s) => liveTick(s, 101.1, M + 180 + 3),
    ]);
    expect(steps[0]!.closed.map((c) => c.time)).toEqual([M]);
    expect(steps[0]!.gap).toBe(true);
    expect(steps[1]!.gap).toBe(true);
    expect(steps[1]!.state).toBe(steps[0]!.state);
    expect(steps[2]!.gap).toBe(false);
    expect(nextBucket("1m", M)).toBe(M1);
    // без текущей свечи: первый тик через интервал после свечи истории — тоже пропуск
    expect(liveTick(liveStart("4h", null, cur4h), 100, T4 + 2 * H4 + 5).gap).toBe(true);
    expect(liveTick(liveStart("4h", null, cur4h), 100, T4 + H4 + 5).gap).toBe(false);
  });

  it("перезапуск по свежей истории: своя текущая свеча новее серверной остаётся, у той же — шире и с ценой тика", () => {
    const ticked = liveTick(liveStart("4h", cur4h), 120, T4 + H4 + 5).state; // 12:00, серверная 08:00 закрыта
    const server08: Candle = { ...cur4h, high: 107, close: 104 };
    const r = liveRestart(ticked, "4h", server08, { ...cur4h, time: T4 - H4, open_: false });
    expect(r.head).toMatchObject({ time: T4 + H4, close: 120 });
    expect(r.tail).toEqual({ ...server08, open_: false });
    expect(r.tailHist).toBe(true);
    const same = liveRestart(liveTick(liveStart("4h", cur4h), 111, T4 + 100).state, "4h", { ...cur4h, high: 106, volume: 1200 }, null);
    expect(same.head).toMatchObject({ time: T4, high: 111, low: 95, close: 111, volume: 1200 });
    expect(liveRestart(null, "4h", null, cur4h).head).toBeNull();
  });
});
