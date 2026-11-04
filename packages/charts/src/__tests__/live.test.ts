import { describe, expect, it } from "vitest";
import { applyMinute, bucketStart, catchUpLive, countdownSeconds, foldMinute, isClosed, liveDueAt, mergeLive, minuteNeedsHistory, restThrough, secondsToClose, type LiveBars } from "../live";
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
