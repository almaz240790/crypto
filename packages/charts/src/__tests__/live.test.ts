import { describe, expect, it } from "vitest";
import { applyMinute, bucketStart, catchUpLive, countdownSeconds, foldMinute, isClosed, LIVE_PENDING_MINUTES, liveCandle, liveDueAt, liveForming, liveRestart, liveStart, liveTick, mergeLive, minuteNeedsHistory, nextBucket, restThrough, secondsToClose, type LiveBars, type LiveStep } from "../live";
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

/**
 * Живой поток и догон (продовый баг «график встал после фона»): закрытая минута на 1m/5m/15m заменяет текущую
 * свечу с тем же временем и открывает следующую, дубли минут не удваивают объём, свежая порция истории
 * сливается с концом без повторов времени, просроченная свеча видна по часам.
 */
const M = 60;
const T = Date.UTC(2026, 10, 4, 7, 0) / 1000; // 07:00 UTC, начало часа
const bar = (time: number, close: number, open_ = false, volume = 1): Candle => ({ time, open: close, high: close + 1, low: close - 1, close, volume, open_ });
const times = (s: LiveBars) => s.closed.map((c) => c.time);

describe("минута из WebSocket в свечах tf", () => {
  it("1m: закрытая минута заменяет недописанную текущую с тем же временем, следующая — новая свеча справа", () => {
    // история: закрытые до 07:02, текущая 07:03 (недописанная, из БД с флагом open)
    let s: LiveBars = { closed: [bar(T, 1), bar(T + M, 2), bar(T + 2 * M, 3)], current: bar(T + 3 * M, 4, true, 0.4), through: T + 2 * M };
    s = applyMinute(s, m1(T + 3 * M, 4, 6, 3, 5, 2), "1m")!;
    // объём не сложился с недописанным (0.4 + 2), свеча закрыта, текущей нет
    expect(s.current).toBeNull();
    expect(s.closed.at(-1)).toEqual({ time: T + 3 * M, open: 4, high: 6, low: 3, close: 5, volume: 2, open_: false });
    expect(times(s)).toEqual([T, T + M, T + 2 * M, T + 3 * M]);
    s = applyMinute(s, m1(T + 4 * M, 5, 7, 5, 6), "1m")!;
    expect(times(s)).toEqual([T, T + M, T + 2 * M, T + 3 * M, T + 4 * M]);
    expect(s.through).toBe(T + 4 * M);
    // повтор той же минуты — замена, не дубль
    s = applyMinute(s, m1(T + 4 * M, 5, 8, 5, 6.5), "1m")!;
    expect(times(s)).toHaveLength(5);
    expect(s.closed.at(-1)!.high).toBe(8);
    // минута из прошлого не переписывает историю
    expect(applyMinute(s, m1(T + M, 1, 1, 1, 1), "1m")).toBeNull();
  });

  it("1m: минута позже текущей закрывает текущую как есть; минута раньше текущей правит последнюю закрытую", () => {
    const s: LiveBars = { closed: [bar(T, 1), bar(T + M, 2)], current: bar(T + 2 * M, 3, true), through: T };
    const late = applyMinute(s, m1(T + M, 2, 9, 1, 2.5), "1m")!;
    expect(late.current).toBe(s.current);
    expect(late.closed.at(-1)!.high).toBe(9);
    const jump = applyMinute(s, m1(T + 4 * M, 3, 3, 3, 3), "1m")!;
    expect(times(jump)).toEqual([T, T + M, T + 2 * M, T + 4 * M]);
    expect(jump.closed[2]!.open_).toBe(false);
    expect(jump.current).toBeNull();
    // пустая история — первая минута становится первой свечой
    expect(times(applyMinute({ closed: [], current: null, through: 0 }, m1(T, 1, 1, 1, 1), "1m")!)).toEqual([T]);
  });

  it("5m: минута с временем текущей свечи заменяет её, остальные минуты сворачиваются, новая корзина закрывает текущую", () => {
    const B = T + 5 * M;
    // текущая 5m из истории: только недописанная первая минута (запрос в 07:05:20)
    let s: LiveBars = { closed: [bar(T, 1)], current: bar(B, 2, true, 0.3), through: restThrough(B + 20) };
    expect(s.through).toBe(B - M);
    s = applyMinute(s, m1(B, 2, 3, 1.5, 2.5, 2), "5m")!;
    expect(s.current).toMatchObject({ time: B, open: 2, high: 3, low: 1.5, close: 2.5, volume: 2, open_: true });
    s = applyMinute(s, m1(B + M, 2.5, 4, 2, 3, 1), "5m")!;
    expect(s.current).toMatchObject({ time: B, open: 2, high: 4, low: 1.5, close: 3, volume: 3 });
    // повтор уже учтённой минуты не удваивает объём
    expect(applyMinute(s, m1(B + M, 2.5, 4, 2, 3, 1), "5m")).toBeNull();
    // минута следующей корзины: текущая закрыта, новая открыта
    s = applyMinute(s, m1(B + 5 * M, 3, 3.5, 2.9, 3.2, 4), "5m")!;
    expect(times(s)).toEqual([T, B]);
    expect(s.closed.at(-1)).toMatchObject({ time: B, close: 3, volume: 3, open_: false });
    expect(s.current).toMatchObject({ time: B + 5 * M, open: 3, volume: 4, open_: true });
    // запоздавшая минута старой корзины пропускается
    expect(applyMinute(s, m1(B + 4 * M, 1, 1, 1, 1), "5m")).toBeNull();
  });

  it("15m: минута, уже учтённая историей, пропускается; без текущей свечи минута открывает новую", () => {
    const B = T + 15 * M;
    const s: LiveBars = { closed: [bar(T, 1)], current: bar(B, 2, true, 5), through: B + 3 * M };
    expect(applyMinute(s, m1(B + 2 * M, 9, 9, 9, 9), "15m")).toBeNull();
    expect(applyMinute(s, m1(B + 3 * M, 9, 9, 9, 9), "15m")).toBeNull();
    expect(applyMinute(s, m1(B + 4 * M, 2, 9, 1, 8, 1), "15m")!.current).toMatchObject({ high: 9, close: 8, volume: 6 });
    const none: LiveBars = { closed: [bar(T, 1)], current: null, through: 0 };
    expect(applyMinute(none, m1(T + 14 * M, 1, 1, 1, 1), "15m")).toBeNull();
    expect(applyMinute(none, m1(B + 2 * M, 1, 2, 1, 2), "15m")!.current).toMatchObject({ time: B, open_: true });
  });
});

describe("догон: свежая порция истории поверх живых свечей", () => {
  it("заменяет пересекающийся хвост, дописывает пропущенные свечи, времена не повторяются, старая история — те же объекты", () => {
    const old = [bar(T, 1), bar(T + M, 2), bar(T + 2 * M, 3)];
    // поток встал на 07:03 (текущая), сервер ушёл до 07:30
    const s: LiveBars = { closed: old, current: bar(T + 3 * M, 4, true), through: T + 2 * M };
    const page = Array.from({ length: 29 }, (_, i) => bar(T + (1 + i) * M, 10 + i));
    const cur = bar(T + 30 * M, 50, true);
    const r = mergeLive(s, page, cur, restThrough(T + 30 * M + 12), "1m")!;
    expect(times(r)).toEqual([T, ...page.map((c) => c.time)]);
    expect(new Set(times(r)).size).toBe(r.closed.length);
    expect(r.closed[0]).toBe(old[0]);
    expect(r.closed[1]!.close).toBe(10); // хвост заменён окончательными свечами
    expect(r.current).toBe(cur);
    expect(r.through).toBe(T + 29 * M);
  });

  it("закрытые потоком после ответа свечи остаются; текущая — более новая, при равном времени — с большим числом целых минут", () => {
    const s: LiveBars = { closed: [bar(T, 1), bar(T + M, 2), bar(T + 2 * M, 3)], current: bar(T + 3 * M, 4, true), through: T + 3 * M };
    // ответ сервера старше потока: последняя закрытая 07:01, текущая 07:02
    const r = mergeLive(s, [bar(T, 1), bar(T + M, 2.5)], bar(T + 2 * M, 3, true), T + M, "1m")!;
    expect(times(r)).toEqual([T, T + M, T + 2 * M]);
    expect(r.closed[1]!.close).toBe(2.5);
    expect(r.current).toBe(s.current);
    // одна и та же текущая: у потока больше целых минут — остаётся его
    const h1 = T + 3600;
    const live: LiveBars = { closed: [bar(T, 1)], current: bar(h1, 5, true), through: h1 + 10 * M };
    expect(mergeLive(live, [bar(T, 1)], bar(h1, 6, true), h1 + 9 * M, "1h")!.current!.close).toBe(5);
    expect(mergeLive(live, [bar(T, 1)], bar(h1, 6, true), h1 + 10 * M, "1h")!.current!.close).toBe(6);
    expect(mergeLive(live, [bar(T, 1)], bar(h1, 6, true), h1 + 11 * M, "1h")!.current!.close).toBe(6);
  });

  it("прежняя текущая, которую порция не закрыла, становится закрытой; без текущей в ответе — закрытые остаются", () => {
    const s: LiveBars = { closed: [bar(T, 1)], current: bar(T + M, 2, true), through: T };
    const r = mergeLive(s, [bar(T, 1.5)], bar(T + 2 * M, 3, true), T + M, "1m")!;
    expect(times(r)).toEqual([T, T + M]);
    expect(r.closed[1]!.open_).toBe(false);
    expect(r.current!.time).toBe(T + 2 * M);
    // 1m: ответ без текущей, порция закрыла и нашу текущую
    const one = mergeLive(s, [bar(T, 1), bar(T + M, 2.2)], null, T + M, "1m")!;
    expect(one.current).toBeNull();
    expect(one.closed.at(-1)!.close).toBe(2.2);
    // только текущая в ответе — закрытые не трогаются
    const onlyCur = mergeLive(s, [], bar(T + M, 2.4, true), T + M, "1m")!;
    expect(onlyCur.closed).toEqual(s.closed);
    expect(onlyCur.current!.close).toBe(2.4);
  });

  it("разрыв длиннее порции — null (замена целиком); пустой ответ ничего не меняет; пустая история — порция как есть", () => {
    const s: LiveBars = { closed: [bar(T, 1)], current: bar(T + M, 2, true), through: T };
    expect(mergeLive(s, [bar(T + 600 * M, 1)], null, T + 600 * M, "1m")).toBeNull();
    expect(mergeLive(s, [], null, T, "1m")).toBe(s);
    const empty = mergeLive({ closed: [], current: null, through: 0 }, [bar(T, 1)], bar(T + M, 2, true), T, "1m")!;
    expect(times(empty)).toEqual([T]);
    expect(empty.current!.time).toBe(T + M);
  });

  it("1m: минута потока пришла раньше ответа после отсутствия длиннее порции — не дыра в истории, а замена с этой минутой сверху", () => {
    // поток стоял на минутах 501…1000, приложение спало 700 минут; на возврате минута 1700 пришла раньше ответа
    const old = Array.from({ length: 500 }, (_, i) => bar(T + (501 + i) * M, 1));
    let s: LiveBars = { closed: old, current: null, through: T + 1000 * M };
    s = applyMinute(s, m1(T + 1700 * M, 7, 8, 6, 7.5, 3), "1m")!;
    expect(s.closed.at(-1)!.time).toBe(T + 1700 * M);
    const page = Array.from({ length: 500 }, (_, i) => bar(T + (1200 + i) * M, 5));
    const rest = bar(T + 1700 * M, 7.2, true, 1);
    // стык по истории: перед порцией (1200) последняя — 1000, разрыв 200 минут
    expect(mergeLive(s, page, rest, T + 1699 * M, "1m")).toBeNull();
    const r = catchUpLive(s, page, rest, T + 1699 * M, "1m");
    expect(r.replaced).toBe(true);
    expect(times(r.bars)).toEqual([...page.map((c) => c.time), T + 1700 * M]);
    // закрытая минута потока, а не недописанная из ответа
    expect(r.bars.closed.at(-1)).toMatchObject({ close: 7.5, volume: 3, open_: false });
    expect(r.bars.current).toBeNull();
    for (let i = 1; i < r.bars.closed.length; i++) expect(r.bars.closed[i]!.time - r.bars.closed[i - 1]!.time).toBe(M);
    // то же с минутой 1699 (последней в порции): в истории — окончательная из порции, дыры нет
    const s2 = applyMinute({ closed: old, current: null, through: T + 1000 * M }, m1(T + 1699 * M, 7, 8, 6, 7.5), "1m")!;
    expect(mergeLive(s2, page, rest, T + 1699 * M, "1m")).toBeNull();
    const r2 = catchUpLive(s2, page, rest, T + 1699 * M, "1m");
    expect(times(r2.bars)).toEqual(page.map((c) => c.time));
    expect(r2.bars.current).toBe(rest);
  });

  it("15m: минута потока открыла далёкую корзину раньше ответа — замена целиком, недописанная прежняя текущая не остаётся закрытой", () => {
    const Q = 15 * M;
    const old = Array.from({ length: 500 }, (_, i) => bar(T + (1 + i) * Q, 1));
    let s: LiveBars = { closed: old, current: bar(T + 501 * Q, 2, true), through: T + 501 * Q + 3 * M };
    s = applyMinute(s, m1(T + 1501 * Q + 2 * M, 9, 9, 9, 9), "15m")!;
    expect(s.current!.time).toBe(T + 1501 * Q);
    const page = Array.from({ length: 500 }, (_, i) => bar(T + (1001 + i) * Q, 4));
    const rest = bar(T + 1501 * Q, 9, true);
    expect(mergeLive(s, page, rest, T + 1501 * Q + 2 * M, "15m")).toBeNull();
    const r = catchUpLive(s, page, rest, T + 1501 * Q + 2 * M, "15m");
    expect(r.replaced).toBe(true);
    expect(r.bars.closed[0]!.time).toBe(T + 1001 * Q);
    expect(r.bars.closed.some((c) => c.time === T + 501 * Q)).toBe(false);
    expect(r.bars.current!.time).toBe(T + 1501 * Q);
    // стыкуется — обычное слияние, история слева на месте
    const near = catchUpLive({ closed: old, current: bar(T + 501 * Q, 2, true), through: 0 }, old.slice(100).concat(bar(T + 501 * Q, 3)), bar(T + 502 * Q, 3, true), T + 502 * Q, "15m");
    expect(near.replaced).toBe(false);
    expect(near.bars.closed[0]).toBe(old[0]);
    expect(near.bars.current!.time).toBe(T + 502 * Q);
  });

  it("прежняя текущая старше начала порции — окончательной её версии в порции нет: замена целиком", () => {
    const s: LiveBars = { closed: [bar(T, 1)], current: bar(T + M, 2, true), through: T };
    expect(mergeLive(s, [bar(T + 2 * M, 3)], bar(T + 3 * M, 4, true), T + 2 * M, "1m")).toBeNull();
    const r = catchUpLive(s, [bar(T + 2 * M, 3)], bar(T + 3 * M, 4, true), T + 2 * M, "1m");
    expect(r).toMatchObject({ replaced: true, bars: { current: { time: T + 3 * M } } });
    expect(times(r.bars)).toEqual([T + 2 * M]);
  });
});

describe("минута, которой нужна история", () => {
  it("пропуск после учтённой минуты — догон; следующая по порядку — нет", () => {
    const s: LiveBars = { closed: [bar(T, 1)], current: bar(T + 3600, 2, true), through: T + 3600 + 4 * M };
    expect(minuteNeedsHistory(s, m1(T + 3600 + 5 * M, 1, 1, 1, 1), "1h")).toBe(false);
    expect(minuteNeedsHistory(s, m1(T + 3600 + 6 * M, 1, 1, 1, 1), "1h")).toBe(true);
    // уже учтённая — нет
    expect(minuteNeedsHistory(s, m1(T + 3600 + 2 * M, 1, 1, 1, 1), "1h")).toBe(false);
    const one: LiveBars = { closed: [bar(T, 1)], current: bar(T + M, 1, true), through: T };
    expect(minuteNeedsHistory(one, m1(T + M, 1, 1, 1, 1), "1m")).toBe(false);
    expect(minuteNeedsHistory(one, m1(T + 3 * M, 1, 1, 1, 1), "1m")).toBe(true);
  });

  it("минута уже закрытой свечи, которой нет в ответе (закрылась после него) — догон", () => {
    // 1h: ответ пришёл в 08:00:00.5, последняя минута 07:59 ещё не была закрыта в БД — through 07:58
    const h = T + 3600;
    const s: LiveBars = { closed: [bar(T, 1)], current: bar(h, 2, true), through: h - 2 * M };
    expect(applyMinute(s, m1(h - M, 1, 1, 1, 1), "1h")).toBeNull();
    expect(minuteNeedsHistory(s, m1(h - M, 1, 1, 1, 1), "1h")).toBe(true);
    // учтённая ответом — нет
    expect(minuteNeedsHistory({ ...s, through: h - M }, m1(h - M, 1, 1, 1, 1), "1h")).toBe(false);
    // без текущей: минута последней закрытой свечи
    expect(minuteNeedsHistory({ closed: [bar(T, 1)], current: null, through: T + 58 * M }, m1(T + 59 * M, 1, 1, 1, 1), "1h")).toBe(true);
    expect(minuteNeedsHistory({ closed: [bar(T, 1)], current: null, through: T + 59 * M }, m1(T + 60 * M, 1, 1, 1, 1), "1h")).toBe(false);
  });
});

describe("через through из ответа: минута, недописанная в ответе, не складывается дважды и не теряется", () => {
  it("1h: текущая из ответа — только закрытые минуты, идущая придёт потоком и свернётся один раз", () => {
    // ответ в 10:05:30: закрыты 10:00…10:04 по 100, идущая 10:05 в текущую не входит; through — 10:04
    const h = T + 3 * 3600;
    let s: LiveBars = { closed: [bar(T, 1)], current: { time: h, open: 1, high: 2, low: 1, close: 2, volume: 500, open_: true }, through: h + 4 * M };
    s = applyMinute(s, m1(h + 5 * M, 2, 3, 2, 2.5, 100), "1h")!;
    expect(s.current!.volume).toBe(600);
    // ответ пришёл до записи закрытой 10:04 в БД: through 10:03 — минута 10:04 из потока не теряется
    let t: LiveBars = { closed: [bar(T, 1)], current: { time: h, open: 1, high: 2, low: 1, close: 2, volume: 400, open_: true }, through: h + 3 * M };
    t = applyMinute(t, m1(h + 4 * M, 2, 9, 1, 3, 100), "1h")!;
    expect(t.current).toMatchObject({ high: 9, low: 1, volume: 500 });
  });
});

describe("просрочка и отсчёт", () => {
  it("текущая просрочена к своему закрытию + запас; без текущей (1m) — ещё через минуту", () => {
    expect(liveDueAt({ closed: [bar(T - 3600, 1)], current: bar(T, 1, true), through: 0 }, "1h", 8)).toBe(T + 3600 + 8);
    expect(liveDueAt({ closed: [bar(T, 1)], current: null, through: T }, "1m", 8)).toBe(T + 2 * M + 8);
    expect(liveDueAt({ closed: [], current: null, through: 0 }, "1m", 8)).toBeNull();
  });

  it("отсчёт: до закрытия последней свечи, а если её интервал прошёл — до закрытия идущего по часам, не «0:00»", () => {
    expect(countdownSeconds("1h", T, T + 600)).toBe(3000);
    // 1m: последняя закрытая минута 07:00, сейчас 07:01:20 — до закрытия 07:01 осталось 40 с
    expect(countdownSeconds("1m", T, T + 80)).toBe(40);
    // свеча в будущем (часы клиента отстают) — от неё
    expect(countdownSeconds("4h", T + 4 * 3600, T)).toBe(8 * 3600);
  });
});
