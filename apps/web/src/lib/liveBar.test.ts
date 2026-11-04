import type { LiveStep } from "@platform/charts";
import { describe, expect, it } from "vitest";
import { LiveBar } from "./liveBar";

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
  it("до загрузки свечей тики график не трогают", () => {
    const { live, steps } = bar();
    expect(live.tick({ s: "BTCUSDT", p: "105", at: iso(T + 60) })).toBeNull();
    expect(steps).toEqual([]);
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
    live.forming({ s: "BTCUSDT", tf: "1m", c: { t: T + 4 * 3600, o: "101.9", h: "102.5", l: "101.5", c: "102.1", v: "12" } });
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
