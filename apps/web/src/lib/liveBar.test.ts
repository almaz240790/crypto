import type { LiveStep } from "@platform/charts";
import { describe, expect, it } from "vitest";
import { CatchUpGate, EARLY_MAX, LIVE_BACKOFF_MAX_MS, LIVE_RETRY_MS, LiveBar, pageThrough, replaceByTime, RESYNC_MIN_MS, type CatchUpResult, type LiveEvent } from "./liveBar";

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

  it("through ответа: поле API, без него — оценка по времени сервера, без времени — неизвестно", () => {
    expect(pageThrough(T + 60, T + 200)).toBe(T + 60);
    expect(pageThrough(null, T + 200)).toBe(T + 120); // идущая 08:03 — в недописанной, учтена 08:02
    expect(pageThrough(undefined, undefined)).toBeNull();
  });

  it("до старта копится не больше EARLY_MAX событий; догон до старта ничего не делает", () => {
    const { live } = bar();
    for (let i = 0; i < EARLY_MAX + 50; i++) live.tick({ s: "BTCUSDT", p: String(90 + i / 1000), at: iso(T + 60 + i * 0.01) });
    expect(live.catchUp([], current, null, undefined, true)).toBeNull();
    live.start(current, []);
    expect(live.bar!.low).toBeCloseTo(90.05, 5); // первые 50 вытеснены
  });
});

/** Поток с дырами и ответ догона старее его последней закрытой минуты (LIVE-1); пропуск до старта (LIVE-4). */
describe("LiveBar: поток с пропуском во время запроса и до загрузки", () => {
  const M = 60;
  const m = (k: number) => T + k * M;
  const msg = (t: number, v: number, h = 101, l = 99, o = 100) => ({ s: "BTCUSDT", tf: "1m" as const, c: { t, o: String(o), h: String(h), l: String(l), c: "100.5", v: String(v) } });
  const C = (time: number, volume: number, high = 101, low = 99, open_ = false, open = 100) => ({ time, open, high, low, close: 100.5, volume, open_ });

  it("минута с пропуском пришла, пока шёл запрос: ответ — до through, минуты потока после него — сверху, тики остаются", () => {
    const { live } = bar();
    const hist = [C(T - 4 * 3600, 3)];
    live.start(C(T, 2, 101, 99, true), hist, m(1));
    live.candle(msg(m(2), 1));
    expect(live.bar!.volume).toBe(3);
    // обрыв: минуты 3 и 4 пропущены (в минуте 3 — пик 120); новый сокет, запрос догона ушёл, БД прочитана до записи
    // минуты 5 — а она пришла по сокету раньше ответа
    expect(live.candle(msg(m(5), 1))!.gap).toBe(true);
    live.tick({ s: "BTCUSDT", p: "100.9", at: iso(m(6) + 10) });
    const ev = live.catchUp(hist, C(T, 5, 120, 99, true), m(4), m(5) + 50, true)!;
    expect(ev.bar).toMatchObject({ time: T, volume: 6, high: 120, close: 100.9 });
    expect(ev.tail!.bars.at(-1)).toBe(ev.bar);
    expect(live.takeResync()).toBe(false);
    // дальше — обычная свёртка, без новой дыры
    const next = live.candle(msg(m(6), 1))!;
    expect(next.gap).toBe(false);
    expect(next.bar).toMatchObject({ volume: 7, high: 120 });
  });

  it("через границу интервала: open и объём новой свечи — из ответа и минуты потока, закрытая — из ответа", () => {
    const { live } = bar();
    const N = T + 4 * 3600;
    const hist = [C(T - 4 * 3600, 3)];
    live.start(C(T, 10, 101, 99, true), hist, m(10));
    // телефон спал через границу: новый сокет принёс минуту 7 новой свечи, пока шёл запрос
    expect(live.candle(msg(N + 7 * M, 1, 106, 104, 105))!.gap).toBe(true);
    expect(live.bar).toMatchObject({ time: N, open: 105, volume: 1 });
    const ev = live.catchUp([...hist, C(T, 240)], C(N, 7, 103, 89, true, 90), N + 6 * M, undefined, true)!;
    expect(ev.bar).toMatchObject({ time: N, open: 90, high: 106, low: 89, volume: 8 });
    expect(live.closed.at(-1)).toMatchObject({ time: T, volume: 240 });
  });

  it("минуты потока не покрывают промежуток после through — ответ как раньше и ещё один догон; следующий ответ покрывает", () => {
    const { live } = bar();
    live.start(C(T, 2, 101, 99, true), [], m(1));
    live.candle(msg(m(2), 1));
    live.candle(msg(m(5), 1)); // 3 и 4 пропущены
    // ответ на запрос, ушедший ещё до записи минуты 4: through — минута 3
    live.catchUp([], C(T, 4, 120, 99, true), m(3), undefined, true);
    expect(live.takeResync()).toBe(true);
    const ev = live.catchUp([], C(T, 6, 120, 99, true), m(5), undefined, true)!;
    expect(ev.bar).toMatchObject({ volume: 6, high: 120 });
    expect(live.takeResync()).toBe(false);
  });

  it("пропуск без запроса в пути: ответ новее потока — как всегда, дыра закрыта", () => {
    const { live } = bar();
    live.start(C(T, 2, 101, 99, true), [], m(1));
    live.candle(msg(m(4), 1)); // 2 и 3 пропущены
    const ev = live.catchUp([], C(T, 5, 101, 99, true), m(4), undefined, true)!;
    expect(ev.bar).toMatchObject({ volume: 5 });
    expect(live.candle(msg(m(6), 1))!.gap).toBe(true); // 5 пропущена — снова пропуск
  });

  it("пропуск в событиях до загрузки, вытесненная закрытая минута, переподключение до загрузки — догон сразу после старта", () => {
    const a = new LiveBar("BTCUSDT", "4h");
    a.candle(msg(m(3), 1)); // минута 2 пропущена; through ответа — 1
    a.start(C(T, 2, 101, 99, true), [], m(1));
    expect(a.bar!.volume).toBe(3);
    expect(a.takeResync()).toBe(true);
    expect(a.takeResync()).toBe(false);
    // тот же поток без пропуска — догон не нужен
    const ok = new LiveBar("BTCUSDT", "4h");
    ok.candle(msg(m(2), 1));
    ok.start(C(T, 2, 101, 99, true), [], m(1));
    expect(ok.takeResync()).toBe(false);
    // переподключение до загрузки: до старта не отдаётся, после — один раз
    const b = new LiveBar("BTCUSDT", "4h");
    b.resyncLater();
    expect(b.takeResync()).toBe(false);
    b.start(current, []);
    expect(b.takeResync()).toBe(true);
    // закрытая минута вытеснена тиками из буфера ранних событий
    const c = new LiveBar("BTCUSDT", "4h");
    c.candle(msg(m(2), 1));
    for (let i = 0; i < EARLY_MAX; i++) c.tick({ s: "BTCUSDT", p: "100", at: iso(m(3) + i * 0.1) });
    c.start(C(T, 2, 101, 99, true), [], m(1));
    expect(c.takeResync()).toBe(true);
  });
});

/**
 * Свеча, закрытая за доли секунды до ответа: последняя минута в БД ещё недописанная (chart-data-live-2). Сервер отдаёт
 * такую свечу текущей — свёрткой закрытых минут с through перед недописанной; поток досворачивает её закрытую минуту.
 */
describe("LiveBar: свеча, закрытая перед самым ответом истории (chart-data-live-2)", () => {
  const F = 5 * 60;
  const msg = (t: number, o: number, h: number, l: number, c: number, v: number, at?: number) => ({ s: "BTCUSDT", tf: "1m" as const, c: { t, o: String(o), h: String(h), l: String(l), c: String(c), v: String(v), ...(at ? { at: iso(at) } : {}) } });
  const C = (time: number, open: number, high: number, low: number, close: number, volume: number, open_ = false) => ({ time, open, high, low, close, volume, open_ });
  const prev = C(T - F, 99, 100, 98, 100, 30);
  const final = C(T, 100, 104, 99, 103.9, 50);
  /** Поток 08:00–08:04 (5m): закрытые 08:02 и 08:03, снимок 08:04, закрытая 08:04 — свеча закрыта целиком. */
  function streamed() {
    const live = new LiveBar("BTCUSDT", "5m");
    live.start(C(T, 100, 102, 99, 101, 20, true), [prev], T + 60, T + 180);
    live.candle(msg(T + 120, 101, 103, 100.5, 102, 10));
    live.candle(msg(T + 180, 102, 102.5, 101, 101.5, 10));
    live.forming(msg(T + 240, 101.5, 103, 101, 102.8, 7, T + 299));
    live.candle(msg(T + 240, 101.5, 104, 101, 103.9, 10));
    live.tick({ s: "BTCUSDT", p: "104", at: iso(T + F + 0.3) });
    return live;
  }

  it("догон: свеча ответа со снимком недописанной минуты не затирает закрытую потоком, поздняя минута сервера — не дубль", () => {
    const live = streamed();
    expect(live.closed.at(-1)).toEqual(final);
    // ответ прочитал БД до записи закрытой 08:04: его 08:00 — со снимком (старый сервер или гонка), through — 08:03
    live.catchUp([prev, C(T, 100, 103, 99, 102.8, 47)], C(T + F, 104, 104, 104, 104, 1, true), T + 180, T + F + 0.6, true);
    expect(live.closed.at(-1)).toEqual(final);
    live.candle(msg(T + 240, 101.5, 104, 101, 103.9, 10)); // закрытая 08:04 сервера — уже учтена потоком
    expect(live.closed.at(-1)).toEqual(final);
    expect(live.bar).toMatchObject({ time: T + F, close: 104 });
  });

  it("загрузка: 08:00 — текущая из закрытых минут, through 08:03; закрытая 08:04 до или после тика 08:05 — свеча целиком", () => {
    const page = C(T, 100, 103, 99, 101.5, 40, true); // 08:00–08:03, без снимка 08:04
    // закрытая 08:04 пришла раньше тика следующего интервала
    const a = new LiveBar("BTCUSDT", "5m");
    a.start(page, [prev], T + 180, T + F + 0.6);
    a.candle(msg(T + 240, 101.5, 104, 101, 103.9, 10));
    a.tick({ s: "BTCUSDT", p: "104", at: iso(T + F + 0.8) });
    expect(a.closed.at(-1)).toEqual(final);
    // REST-опрос: тик 08:05 раньше закрытой 08:04 — свеча закрыта тиком и уточняется минутой (amended)
    const b = new LiveBar("BTCUSDT", "5m");
    b.forming(msg(T + 240, 101.5, 103, 101, 102.8, 7, T + 299)); // снимок до ответа — в буфере ранних событий
    b.start(page, [prev], T + 180, T + F + 0.6);
    b.tick({ s: "BTCUSDT", p: "104", at: iso(T + F + 0.8) });
    expect(b.closed.at(-1)).toMatchObject({ time: T, volume: 47 });
    b.candle(msg(T + 240, 101.5, 104, 101, 103.9, 10));
    expect(b.closed.at(-1)).toEqual(final);
    expect(b.bar).toMatchObject({ time: T + F, close: 104 });
  });
});

/** Очередь догона: никогда не два запроса сразу; поводы во время запроса — по правилам (ADR-0003, ADR-0010). */
describe("CatchUpGate", () => {
  function gate(late = false) {
    let now = 1_000_000;
    const pending: ((v: CatchUpResult) => void)[] = [];
    let runs = 0;
    let again = false;
    const run = () =>
      new Promise<CatchUpResult>((resolve) => {
        runs++;
        pending.push(resolve);
      });
    const inner = new CatchUpGate(() => now);
    const g = { request: (r: Parameters<CatchUpGate["request"]>[0]) => inner.request(r, run), get inFlight() { return inner.inFlight; }, get overdueEvery() { return inner.overdueEvery; } };
    const finish = async () => {
      pending.shift()!({ late, again });
      await new Promise((r) => setTimeout(r, 0));
    };
    return { g, finish, runs: () => runs, advance: (ms: number) => (now += ms), setLate: (v: boolean) => (late = v), setAgain: (v: boolean) => (again = v) };
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

  it("ответ не покрыл поток (again) — ровно один повтор сразу, без паузы gap; повтор сам повтора не просит", async () => {
    const t = gate();
    t.setAgain(true);
    expect(t.g.request("gap")).toBe(true);
    await t.finish();
    expect(t.runs()).toBe(2); // повтор начат сразу, хотя RESYNC_MIN_MS не прошло
    expect(t.g.inFlight).toBe(true);
    await t.finish();
    expect(t.runs()).toBe(2);
    expect(t.g.inFlight).toBe(false);
    // следующий эпизод — снова один повтор
    t.advance(RESYNC_MIN_MS);
    t.g.request("gap");
    await t.finish();
    expect(t.runs()).toBe(4);
    t.setAgain(false);
    await t.finish();
    expect(t.runs()).toBe(4);
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
    const run = () => (fail ? Promise.reject(new Error("net")) : Promise.resolve({}));
    expect(g.request("wake", run)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(g.inFlight).toBe(false);
    fail = false;
    expect(g.request("wake", run)).toBe(true);
  });
});
