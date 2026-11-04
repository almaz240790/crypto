import type { LiveStep } from "@platform/charts";
import { describe, expect, it } from "vitest";
import { CatchUpGate, EARLY_MAX, LIVE_BACKOFF_MAX_MS, LIVE_RETRY_MS, LiveBar, replaceByTime, RESYNC_MIN_MS, type LiveEvent } from "./liveBar";

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

  it("пропуск после сна: шаг с gap; догон вливает свежую историю хвостом (replaceTail) без отката текущей", () => {
    const { live, steps } = bar();
    const prev = { ...current, time: T - 4 * 3600, open_: false };
    live.start(current, [prev]);
    const step = live.tick({ s: "BTCUSDT", p: "120", at: iso(T + 12 * 3600 + 5) }); // 2 интервала пропущены
    expect(step!.gap).toBe(true);
    expect(live.closed.map((c) => c.time)).toEqual([T - 4 * 3600, T]); // 08:00 закрыта тиком
    const server = [0, 4, 8].map((h) => ({ ...current, time: T + h * 3600, close: 99 + h, open_: false }));
    const ev = live.catchUp(server, { ...current, time: T + 12 * 3600, close: 119, high: 121 }, null, undefined, true) as LiveEvent;
    // история React: окончательные свечи ответа вместо закрытой тиком, пропущенные — дописаны, старее — те же объекты
    expect(live.closed.map((c) => c.time)).toEqual([T - 4 * 3600, T, T + 4 * 3600, T + 8 * 3600]);
    expect(live.closed[0]).toBe(prev);
    expect(live.closed[1]!.close).toBe(99);
    // график: хвост с первой изменённой свечи и текущая; тик новее ответа (времени сервера нет) — close тика
    expect(ev.tail!.from).toBe(T);
    expect(ev.tail!.bars.map((c) => c.time)).toEqual([T, T + 4 * 3600, T + 8 * 3600, T + 12 * 3600]);
    expect(ev.bar).toMatchObject({ time: T + 12 * 3600, close: 120, high: 121 });
    expect(steps.at(-1)).toBe(ev);
    expect(replaceByTime(live.closed, { ...prev, time: T + 1 })).toBe(live.closed);
  });

  it("догон без изменений — ничего; ответ не стыкуется (разрыв длиннее порции) — замена целиком", () => {
    const { live, steps } = bar();
    const hist = [{ ...current, time: T - 4 * 3600, open_: false }];
    live.start(current, hist);
    expect(live.catchUp(hist, current, null, undefined, true)).toBeNull();
    expect(steps).toEqual([]);
    const far = [{ ...current, time: T + 400 * 3600, open_: false }];
    const ev = live.catchUp(far, { ...current, time: T + 404 * 3600 }, null, undefined, false)!;
    expect(ev.reset!.candles.map((c) => c.time)).toEqual([T + 400 * 3600, T + 404 * 3600]);
    expect(ev.reset!.hasOlder).toBe(false);
    expect(live.closed.map((c) => c.time)).toEqual([T + 400 * 3600]);
    expect(live.bar!.time).toBe(T + 404 * 3600);
  });

  it("догон в той же свече: тики во время запроса не теряются (low тика), объём — из ответа, close тика новее ответа", () => {
    const { live } = bar();
    live.start(current, [], T + 600); // through 08:10
    live.tick({ s: "BTCUSDT", p: "95", at: iso(T + 700) }); // провал в минуте 08:11 — пока шёл запрос
    live.tick({ s: "BTCUSDT", p: "100.9", at: iso(T + 701) });
    const ev = live.catchUp([], { ...current, high: 101.5, close: 100.2, volume: 30 }, T + 660, T + 690, true)!;
    expect(ev.bar).toMatchObject({ time: T, low: 95, high: 101.5, close: 100.9, volume: 30 });
    expect(ev.tail!.bars).toHaveLength(1);
    // через through ответа 08:11 — минута учтена ответом; тик старше ответа — close ответа
    const late = new LiveBar("BTCUSDT", "4h");
    late.start(current, [], T + 600);
    late.tick({ s: "BTCUSDT", p: "101", at: iso(T + 700) });
    expect(late.catchUp([], { ...current, close: 100.4, volume: 31 }, T + 720, T + 730, true)!.bar).toMatchObject({ close: 100.4, high: 101, volume: 31 });
  });

  it("server_time нет (заглушки e2e): через through не оценивается, close тика побеждает, тики не отбрасываются", () => {
    const { live } = bar();
    live.start(current, [], null);
    expect(live.tick({ s: "BTCUSDT", p: "100.7", at: iso(T + 60) })!.bar!.close).toBe(100.7);
    // тот же объём — свеча та же: шага нет, close тика на месте
    expect(live.catchUp([], { ...current, close: 100.1 }, null, undefined, true)).toBeNull();
    expect(live.bar).toMatchObject({ close: 100.7 });
    const ev = live.catchUp([], { ...current, close: 100.1, volume: 12 }, null, undefined, true)!;
    expect(ev.bar).toMatchObject({ close: 100.7, volume: 12 });
  });

  it("through при старте: ранние события не новее него не складываются, после — один раз; dueAt — по текущей", () => {
    const { live } = bar();
    live.forming({ s: "BTCUSDT", tf: "1m", c: { t: T + 540, o: "100", h: "101", l: "99", c: "100.5", v: "9" } }); // уже в current
    live.forming({ s: "BTCUSDT", tf: "1m", c: { t: T + 600, o: "100.5", h: "100.8", l: "100.2", c: "100.6", v: "2" } });
    live.start(current, [], T + 540);
    expect(live.bar).toMatchObject({ volume: 12, close: 100.6 });
    expect(live.dueAt(8)).toBe(T + 4 * 3600 + 8);
    expect(new LiveBar("BTCUSDT", "4h").dueAt(8)).toBeNull();
  });

  it("до старта копится не больше EARLY_MAX событий; догон до старта ничего не делает", () => {
    const { live } = bar();
    for (let i = 0; i < EARLY_MAX + 50; i++) live.tick({ s: "BTCUSDT", p: String(90 + i / 1000), at: iso(T + 60 + i * 0.01) });
    expect(live.catchUp([], current, null, undefined, true)).toBeNull();
    live.start(current, []);
    expect(live.bar!.low).toBeCloseTo(90.05, 5); // первые 50 вытеснены
  });
});

/** Очередь догона: никогда не два запроса сразу; поводы во время запроса — по правилам (ADR-0003, ADR-0010). */
describe("CatchUpGate", () => {
  function gate(late = false) {
    let now = 1_000_000;
    const pending: ((v: boolean) => void)[] = [];
    let runs = 0;
    const run = () =>
      new Promise<boolean>((resolve) => {
        runs++;
        pending.push(resolve);
      });
    const inner = new CatchUpGate(() => now);
    const g = { request: (r: Parameters<CatchUpGate["request"]>[0]) => inner.request(r, run), get inFlight() { return inner.inFlight; }, get overdueEvery() { return inner.overdueEvery; } };
    const finish = async () => {
      pending.shift()!(late);
      await new Promise((r) => setTimeout(r, 0));
    };
    return { g, finish, runs: () => runs, advance: (ms: number) => (now += ms), setLate: (v: boolean) => (late = v) };
  }

  it("никогда не два запроса сразу; reconnect во время запроса — ровно один повтор после него", async () => {
    const t = gate();
    expect(t.g.request("wake")).toBe(true);
    expect(t.g.inFlight).toBe(true);
    expect(t.g.request("reconnect")).toBe(false);
    expect(t.g.request("reconnect")).toBe(false);
    expect(t.runs()).toBe(1);
    await t.finish();
    expect(t.runs()).toBe(2); // повтор после ответа
    await t.finish();
    expect(t.runs()).toBe(2);
    expect(t.g.inFlight).toBe(false);
  });

  it("wake, gap и overdue во время запроса отбрасываются — их покрывает ответ в пути", async () => {
    const t = gate();
    t.g.request("reconnect");
    t.advance(60_000);
    for (const r of ["wake", "gap", "overdue"] as const) expect(t.g.request(r)).toBe(false);
    await t.finish();
    expect(t.runs()).toBe(1);
  });

  it("gap — не чаще RESYNC_MIN_MS после любого догона; wake и reconnect — всегда", async () => {
    const t = gate();
    t.g.request("gap");
    await t.finish();
    t.advance(RESYNC_MIN_MS - 1);
    expect(t.g.request("gap")).toBe(false);
    expect(t.g.request("wake")).toBe(true);
    await t.finish();
    t.advance(RESYNC_MIN_MS);
    expect(t.g.request("gap")).toBe(true);
    await t.finish();
    expect(t.runs()).toBe(3);
  });

  it("overdue: пауза LIVE_RETRY_MS, пока сервер сам отстаёт — удваивается до LIVE_BACKOFF_MAX_MS; догнал — снова LIVE_RETRY_MS", async () => {
    const t = gate(true);
    expect(t.g.request("overdue")).toBe(true);
    await t.finish();
    expect(t.g.overdueEvery).toBe(2 * LIVE_RETRY_MS);
    t.advance(LIVE_RETRY_MS);
    expect(t.g.request("overdue")).toBe(false);
    t.advance(LIVE_RETRY_MS);
    expect(t.g.request("overdue")).toBe(true);
    await t.finish();
    expect(t.g.overdueEvery).toBe(4 * LIVE_RETRY_MS);
    for (let i = 0; i < 10; i++) {
      t.advance(LIVE_BACKOFF_MAX_MS);
      t.g.request("overdue");
      await t.finish();
    }
    expect(t.g.overdueEvery).toBe(LIVE_BACKOFF_MAX_MS);
    t.setLate(false);
    t.advance(LIVE_BACKOFF_MAX_MS);
    t.g.request("overdue");
    await t.finish();
    expect(t.g.overdueEvery).toBe(LIVE_RETRY_MS);
  });

  it("ошибка запроса не блокирует очередь", async () => {
    let fail = true;
    const g = new CatchUpGate();
    const run = () => (fail ? Promise.reject(new Error("net")) : Promise.resolve(false));
    expect(g.request("wake", run)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(g.inFlight).toBe(false);
    fail = false;
    expect(g.request("wake", run)).toBe(true);
  });
});
