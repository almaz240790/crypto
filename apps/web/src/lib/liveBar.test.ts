import type { LiveStep } from "@platform/charts";
import { describe, expect, it } from "vitest";
import { EARLY_MAX, LiveBar, mergeHistory, replaceByTime, type LiveEvent } from "./liveBar";

/** Живая свеча терминала (ADR-0010): тики раз в секунду сворачиваются в текущую свечу tf без нового бара. */

const T = Date.UTC(2026, 10, 4, 8) / 1000; // 08:00 UTC — начало H4
const iso = (sec: number) => new Date(sec * 1000).toISOString();
const current = { time: T, open: 100, high: 101, low: 99, close: 100.5, volume: 10, open_: true };

function bar(symbol = "BTCUSDT") {
  const live = new LiveBar(symbol, "4h");
  const steps: LiveStep[] = [];
  live.subscribe((s) => steps.push(s));
  return { live, steps };
}

describe("LiveBar: тики в текущую свечу", () => {
  it("до загрузки свечей тики график не трогают, но не теряются: сворачиваются при старте (W5)", () => {
    const { live, steps } = bar();
    expect(live.tick({ s: "BTCUSDT", p: "95", at: iso(T + 60) })).toBeNull(); // провал ниже свечи
    expect(live.tick({ s: "BTCUSDT", p: "100.9", at: iso(T + 61) })).toBeNull();
    expect(live.tick({ s: "ETHUSDT", p: "1", at: iso(T + 61) })).toBeNull();
    expect(steps).toEqual([]);
    expect(live.started).toBe(false);
    const prev = { ...current, time: T - 4 * 3600, open_: false };
    expect(live.start(current, [prev])).toEqual([prev]);
    expect(live.bar).toEqual({ ...current, low: 95, close: 100.9 });
    expect(steps).toEqual([]); // график получит свечу вместе с историей
  });

  it("тик до загрузки из следующего интервала закрывает свечу с сервера — в истории при старте", () => {
    const { live } = bar();
    live.tick({ s: "BTCUSDT", p: "102", at: iso(T + 4 * 3600 + 1) });
    const hist = live.start(current, []);
    expect(hist).toEqual([{ ...current, open_: false }]);
    expect(live.bar).toMatchObject({ time: T + 4 * 3600, close: 102 });
  });

  it("каждые 250 мс тик: close = цена, high/low расширяются, объём тот же, бар тот же", () => {
    const { live, steps } = bar();
    live.start(current);
    const prices = ["100.7", "101.8", "98.2", "99.9"];
    prices.forEach((p, i) => live.tick({ s: "BTCUSDT", p, at: iso(T + 3600 + i * 0.25) }));
    expect(steps).toHaveLength(4);
    expect(steps.every((s) => s.closed.length === 0 && s.amended === null && s.bar!.time === T)).toBe(true);
    expect(live.bar).toEqual({ time: T, open: 100, high: 101.8, low: 98.2, close: 99.9, volume: 10, open_: true });
  });

  it("чужой символ и битая цена игнорируются; повтор той же цены подписчика не будит", () => {
    const { live, steps } = bar();
    live.start(current);
    expect(live.tick({ s: "ETHUSDT", p: "1", at: iso(T + 10) })).toBeNull();
    expect(live.tick({ s: "BTCUSDT", p: "abc", at: iso(T + 10) })).toBeNull();
    expect(steps).toEqual([]);
    expect(live.bar).toEqual(current);
  });

  it("тик следующего интервала закрывает свечу (closed) и открывает новую; минута-снимок даёт объём", () => {
    const { live, steps } = bar();
    live.start(current);
    live.tick({ s: "BTCUSDT", p: "102", at: iso(T + 4 * 3600 + 0.4) });
    expect(steps[0]!.closed).toEqual([{ ...current, close: 100.5, open_: false }]);
    expect(steps[0]!.bar).toMatchObject({ time: T + 4 * 3600, open: 102, close: 102, volume: 0 });
    // снимок новее тика (момент снимка позже) — close со снимка
    live.forming({ s: "BTCUSDT", tf: "1m", c: { t: T + 4 * 3600, o: "101.9", h: "102.5", l: "101.5", c: "102.1", v: "12", at: iso(T + 4 * 3600 + 1) } });
    expect(live.bar).toMatchObject({ time: T + 4 * 3600, open: 101.9, high: 102.5, low: 101.5, close: 102.1, volume: 12 });
    // запоздавшая закрытая минута прошлого интервала уточняет закрытую свечу
    live.candle({ s: "BTCUSDT", tf: "1m", c: { t: T + 4 * 3600 - 60, o: "100.4", h: "103", l: "100", c: "101.9", v: "4" } });
    expect(steps.at(-1)!.amended).toEqual({ time: T, open: 100, high: 103, low: 99, close: 101.9, volume: 14, open_: false });
    expect(live.bar!.time).toBe(T + 4 * 3600);
  });

  it("отписка: подписчик больше не получает событий", () => {
    const live = new LiveBar("BTCUSDT", "4h");
    const got: LiveStep[] = [];
    const off = live.subscribe((s) => got.push(s));
    live.start(current);
    live.tick({ s: "BTCUSDT", p: "100.6", at: iso(T + 5) });
    off();
    live.tick({ s: "BTCUSDT", p: "100.8", at: iso(T + 6) });
    expect(got).toHaveLength(1);
    expect(live.bar!.close).toBe(100.8);
  });
});

describe("LiveBar: история, снимок минуты, переподключение (W1, W2, W3)", () => {
  it("снимок минуты старше тика close не откатывает: шапка и свеча показывают одно (W3)", () => {
    const { live } = bar();
    live.start(current, []);
    live.tick({ s: "BTCUSDT", p: "102", at: iso(T + 610) });
    live.tick({ s: "BTCUSDT", p: "103", at: iso(T + 611) });
    live.forming({ s: "BTCUSDT", tf: "1m", c: { t: T + 600, o: "101", h: "102.2", l: "100.8", c: "101.9", v: "4", at: iso(T + 609) } });
    expect(live.bar).toMatchObject({ close: 103, high: 103, volume: 14 });
    live.forming({ s: "BTCUSDT", tf: "1m", c: { t: T + 600, o: "101", h: "103.5", l: "100.8", c: "103.4", v: "5", at: iso(T + 612) } });
    expect(live.bar).toMatchObject({ close: 103.4, high: 103.5, volume: 15 });
  });

  it("без текущей свечи с сервера: тик прошлого интервала уточняет последнюю свечу истории, не заменяя её (W1)", () => {
    const { live, steps } = bar();
    const full = { time: T, open: 95, high: 110, low: 90, close: 100.1, volume: 5000, open_: false };
    live.start(null, [full]);
    live.tick({ s: "BTCUSDT", p: "100.3", at: iso(T + 4 * 3600 - 0.2) });
    expect(steps[0]!.amended).toEqual({ ...full, close: 100.3 });
    expect(steps[0]!.bar).toBeNull();
    live.tick({ s: "BTCUSDT", p: "100.4", at: iso(T + 4 * 3600 + 1) });
    expect(steps[1]!.closed).toEqual([]); // 08:00 второй раз в историю не попадает
    expect(live.bar).toMatchObject({ time: T + 4 * 3600, close: 100.4 });
  });

  it("пропуск после сна: шаг с gap; свежая история вливается в график (merge) без отката текущей", () => {
    const { live, steps } = bar();
    live.start(current, [{ ...current, time: T - 4 * 3600, open_: false }]);
    const step = live.tick({ s: "BTCUSDT", p: "120", at: iso(T + 12 * 3600 + 5) }); // 2 интервала пропущены
    expect(step!.gap).toBe(true);
    const server = [4, 8].map((h) => ({ ...current, time: T + h * 3600, open_: false }));
    const ev = live.resync({ ...current, time: T + 12 * 3600, close: 119, high: 121 }, [{ ...current, open_: false }, ...server]) as LiveEvent;
    expect(ev.merge!.map((c) => c.time)).toEqual([T, T + 4 * 3600, T + 8 * 3600]);
    expect(ev.bar).toMatchObject({ time: T + 12 * 3600, close: 120, high: 121 });
    expect(steps.at(-1)).toBe(ev);
    // React: дописываются только новее последней, без вставок в середину; текущая — не в истории
    const prev = [{ ...current, time: T - 4 * 3600, open_: false }, { ...current, close: 99, open_: false }];
    const merged = mergeHistory(prev, ev.merge!, ev.bar!.time);
    expect(merged.map((c) => c.time)).toEqual([T - 4 * 3600, T, T + 4 * 3600, T + 8 * 3600]);
    expect(merged[1]!.close).toBe(current.close);
    expect(mergeHistory(prev, [], 0)).toBe(prev);
    expect(replaceByTime(prev, { ...prev[0]!, time: T + 1 })).toBe(prev);
  });

  it("до старта копится не больше EARLY_MAX событий; resync до старта ничего не делает", () => {
    const { live } = bar();
    for (let i = 0; i < EARLY_MAX + 50; i++) live.tick({ s: "BTCUSDT", p: String(90 + i / 1000), at: iso(T + 60 + i * 0.01) });
    expect(live.resync(current, [])).toBeNull();
    live.start(current, []);
    expect(live.bar!.low).toBeCloseTo(90.05, 5); // первые 50 вытеснены
  });
});
