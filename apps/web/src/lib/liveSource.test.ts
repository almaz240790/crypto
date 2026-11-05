import type { LiveStep } from "@platform/charts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BATCH_MS, BEHIND_MS, BinanceFeed, RETRY_MIN_MS } from "./binanceFeed";
import { LiveBar } from "./liveBar";
import { HEADER_PRICE_MS, HeaderPrice, LiveMux, type PriceSource } from "./liveSource";
import type { LiveCandle, LivePrice } from "./useLive";

/**
 * Источник живой цены (ADR-0010, дополнение): биржа напрямую, пока свежа, иначе сервер — в один LiveBar; цена в шапке
 * не чаще HEADER_PRICE_MS; переход между источниками без скачков.
 */

const T = Date.UTC(2026, 10, 4, 8) / 1000; // 08:00 UTC — начало H4
const M = T + 3600; // минута внутри свечи
const iso = (sec: number) => new Date(sec * 1000).toISOString();
const current = { time: T, open: 100, high: 101, low: 99, close: 100.5, volume: 10, open_: true };
const minute = (t: number, c: Partial<LiveCandle["c"]>, at?: number): LiveCandle => ({ s: "BTCUSDT", tf: "1m", c: { t, o: "100.5", h: "100.6", l: "100.4", c: "100.5", v: "1", ...c, ...(at !== undefined ? { at: iso(at) } : {}) } });

afterEach(() => {
  vi.useRealTimers();
});

describe("HeaderPrice: цена шапки", () => {
  it("сделки каждый кадр (60 в секунду) — не больше 4 обновлений React в секунду, последняя цена; now() — без ожидания", () => {
    vi.useFakeTimers();
    const store = new HeaderPrice();
    let renders = 0;
    store.subscribe(() => renders++);
    for (let i = 0; i < 120; i++) {
      store.push({ p: String(100 + i / 100), at: iso(M + i / 60) });
      vi.advanceTimersByTime(1000 / 60);
    }
    vi.advanceTimersByTime(HEADER_PRICE_MS);
    expect(renders).toBeLessThanOrEqual(2 * (1000 / HEADER_PRICE_MS) + 1);
    expect(renders).toBeGreaterThanOrEqual(2 * (1000 / HEADER_PRICE_MS) - 1);
    expect(store.get()).toBe("101.19");
    vi.advanceTimersByTime(HEADER_PRICE_MS);
    store.push({ p: "101.5", at: iso(M + 3) });
    expect(store.now()).toBe("101.5");
    expect(store.get()).toBe("101.5"); // после тишины — сразу
    store.dispose();
  });

  it("цена старше уже показанной (сервер отстаёт от биржи) не откатывает; не новее порции истории — не показывается", () => {
    const store = new HeaderPrice(0);
    store.push({ p: "101", at: iso(M + 10) });
    store.push({ p: "100", at: iso(M + 9) });
    expect(store.get()).toBe("101");
    let n = 0;
    store.subscribe(() => n++);
    store.setRestAt(M + 10);
    expect(n).toBe(1);
    expect(store.get()).toBeNull();
    expect(store.now()).toBeNull();
    store.push({ p: "102", at: iso(M + 11) });
    expect(store.get()).toBe("102");
  });
});

/** LiveBar 4h, mux и «биржа свежа» по флагу. */
function setup(fresh = { on: false }) {
  const live = new LiveBar("BTCUSDT", "4h");
  live.start(current, [], M - 60);
  const chart: LiveStep[] = [];
  live.subscribe((s) => chart.push(s));
  const prices: LivePrice[] = [];
  const sources: PriceSource[] = [];
  const steps: (LiveStep | null)[] = [];
  const mux = new LiveMux("BTCUSDT", live, () => fresh.on);
  mux.attach({ step: (s) => steps.push(s), price: (p) => prices.push(p), source: (s) => sources.push(s) });
  return { live, mux, chart, prices, sources, steps, fresh };
}

describe("LiveMux: биржа — основной источник, сервер — запасной", () => {
  it("биржа свежа: её сделки и минуты идут в свечу, тики и формирующиеся минуты сервера — мимо; цена шапки — с биржи", () => {
    const { live, mux, prices, sources, fresh } = setup();
    mux.binance.fresh!(false);
    expect(sources).toEqual(["server"]);
    fresh.on = true;
    mux.binance.fresh!(true);
    expect(sources).toEqual(["server", "binance"]);
    mux.binance.forming!(minute(M, { o: "100.5", h: "101.4", l: "100.2", c: "101.2", v: "3" }, M + 20));
    mux.binance.tick!({ s: "BTCUSDT", p: "101.3", at: iso(M + 21) });
    // сервер отстаёт на 1–2 с: его тик и снимок REST-опроса — не в свечу и не в шапку
    mux.serverTick({ s: "BTCUSDT", p: "100.9", at: iso(M + 19.5) });
    mux.serverForming(minute(M, { h: "101", l: "100.3", c: "100.9", v: "2" }, M + 15));
    mux.serverPrice("BTCUSDT", { p: "100", at: iso(M) });
    expect(live.bar).toEqual({ time: T, open: 100, high: 101.4, low: 99, close: 101.3, volume: 13, open_: true });
    // шапка: close kline на момент события, затем сделка; цены сервера — нет
    expect(prices.map((p) => p.p)).toEqual(["101.2", "101.3"]);
  });

  it("биржа замолчала — сервер: его тик старше последней сделки close не откатывает, снимок старше — объём не уменьшает; затем новые тики сервера двигают цену", () => {
    const { live, mux, prices, fresh } = setup();
    fresh.on = true;
    mux.binance.forming!(minute(M, { h: "101.4", l: "100.2", c: "101.2", v: "3" }, M + 20));
    mux.binance.tick!({ s: "BTCUSDT", p: "101.3", at: iso(M + 21) });
    const shown = live.bar!;
    fresh.on = false;
    mux.binance.fresh!(false);
    mux.serverTick({ s: "BTCUSDT", p: "100.9", at: iso(M + 20.5) }); // отстаёт: только high/low
    mux.serverForming(minute(M, { h: "101", l: "100.3", c: "100.9", v: "2" }, M + 18));
    expect(live.bar).toEqual(shown); // без скачка
    mux.serverTick({ s: "BTCUSDT", p: "101.6", at: iso(M + 23) });
    expect(live.bar).toMatchObject({ close: 101.6, high: 101.6, volume: 13 });
    expect(prices.map((p) => p.p)).toEqual(["101.2", "101.3", "100.9", "101.6"]);
  });

  it("закрытые минуты сервера проходят всегда: пропущенную биржей дописывают, повтор не складывает объём дважды", () => {
    const { live, mux, fresh } = setup();
    fresh.on = true;
    mux.binance.candle!(minute(M, { h: "101", c: "100.8", v: "4" }));
    expect(live.bar).toMatchObject({ volume: 14, close: 100.8 });
    mux.serverCandle(minute(M, { h: "101", c: "100.8", v: "4" })); // та же минута с сервера — повтор
    expect(live.bar).toMatchObject({ volume: 14 });
    // биржа переподключалась и минуту M+60 пропустила — её закрыл сервер, следующая с биржи — без пропуска
    mux.serverCandle(minute(M + 60, { h: "101.1", c: "101", v: "2" }));
    const step = live.candle(minute(M + 120, { c: "101.05", v: "1" }));
    expect(step?.gap).toBe(false);
    expect(live.bar).toMatchObject({ volume: 17, close: 101.05 });
  });

  it("сделки биржи до загрузки свечей не копятся (kline несёт минуту целиком); формирующаяся — копится и сворачивается при старте", () => {
    const live = new LiveBar("BTCUSDT", "4h");
    const prices: LivePrice[] = [];
    const mux = new LiveMux("BTCUSDT", live, () => true);
    mux.attach({ step: () => {}, price: (p) => prices.push(p), source: () => {} });
    for (let i = 0; i < 500; i++) mux.binance.tick!({ s: "BTCUSDT", p: String(100 + i / 1000), at: iso(M + i / 60) });
    mux.binance.forming!(minute(M, { o: "100.5", h: "100.9", l: "98", c: "100.499", v: "5" }, M + 9));
    expect(prices).toHaveLength(501); // шапка — да (сделки и close kline)
    live.start(current, [], M - 60);
    expect(live.bar).toMatchObject({ low: 98, close: 100.499, volume: 15 });
    expect(live.takeResync()).toBe(false); // буфер ранних событий не переполнен сделками
  });

  it("выход не подключён — события не теряют автомат, но наружу не идут; при подключении — текущий источник сразу", () => {
    const live = new LiveBar("BTCUSDT", "4h");
    live.start(current, [], M - 60);
    const mux = new LiveMux("BTCUSDT", live, () => true);
    mux.binance.fresh!(true);
    mux.binance.tick!({ s: "BTCUSDT", p: "101", at: iso(M) });
    expect(live.bar!.close).toBe(101);
    const sources: PriceSource[] = [];
    mux.attach({ step: () => {}, price: () => {}, source: (s) => sources.push(s) });
    expect(sources).toEqual(["binance"]);
    expect(mux.source).toBe("binance");
    mux.serverTick({ s: "ETHUSDT", p: "1", at: iso(M + 1) });
    expect(live.bar!.close).toBe(101);
  });
});

/** WebSocket браузера для полной цепочки: FakeWS → BinanceFeed → LiveMux → LiveBar. */
class FakeWS {
  static all: FakeWS[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWS.all.push(this);
  }
  send(m: string) {
    this.sent.push(m);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  kline(t: number, k: { o: string; h: string; l: string; c: string; v: string; x?: boolean }, E: number) {
    this.onmessage?.({ data: JSON.stringify({ stream: "btcusdt@kline_1m", data: { e: "kline", E: E * 1000, s: "BTCUSDT", k: { t: t * 1000, x: false, ...k } } }) });
  }
  trade(p: string, T: number) {
    this.onmessage?.({ data: JSON.stringify({ stream: "btcusdt@aggTrade", data: { e: "aggTrade", E: T * 1000 + 3, s: "BTCUSDT", p, q: "1", T: T * 1000, m: false } }) });
  }
}

describe("цепочка: BinanceFeed → LiveMux → LiveBar", () => {
  let frames: (() => void)[] = [];
  const frame = () => {
    const f = frames;
    frames = [];
    f.forEach((fn) => fn());
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime((M + 20) * 1000);
    FakeWS.all = [];
    frames = [];
  });

  it("kline и сделки двигают свечу графика несколько раз в секунду; закрытая минута — в свечу; биржа недоступна — тики сервера; вернулась — снова биржа", async () => {
    const feed = new BinanceFeed({ url: "wss://x/stream", WebSocketImpl: FakeWS as unknown as typeof WebSocket, raf: (fn) => void frames.push(fn), random: () => 0, doc: null, win: null, store: null });
    const live = new LiveBar("BTCUSDT", "1m");
    live.start({ time: M, open: 100.5, high: 100.6, low: 100.4, close: 100.5, volume: 1, open_: true }, [{ ...current, time: M - 60, open_: false }]);
    const chart: LiveStep[] = [];
    live.subscribe((s) => chart.push(s));
    const sources: PriceSource[] = [];
    const prices: string[] = [];
    const mux = new LiveMux("BTCUSDT", live, () => feed.isFresh("BTCUSDT"), (t) => feed.server(t));
    mux.attach({ step: () => {}, price: (p) => prices.push(p.p), source: (s) => sources.push(s) });
    feed.subscribe("BTCUSDT", mux.binance);
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    const ws = FakeWS.all[0]!;
    ws.open();
    // полсекунды биржи: kline раз в 250 мс, сделки каждый кадр
    const now = () => Date.now() / 1000;
    ws.kline(M, { o: "100.5", h: "100.8", l: "100.3", c: "100.7", v: "3" }, now());
    for (let i = 0; i < 6; i++) {
      ws.trade((100.7 + i / 100).toFixed(2), now());
      frame();
      await vi.advanceTimersByTimeAsync(80);
    }
    // снимок kline старше последней сделки (сделка — 80 мс назад): close сделки остаётся, high/low и объём — из снимка
    ws.kline(M, { o: "100.5", h: "100.9", l: "100.2", c: "100.74", v: "5" }, now() - 0.1);
    expect(sources).toEqual(["server", "binance"]);
    expect(chart.length).toBeGreaterThanOrEqual(7);
    expect(live.bar).toEqual({ time: M, open: 100.5, high: 100.9, low: 100.2, close: 100.75, volume: 5, open_: true });
    // сервер отстаёт: пока биржа свежа, его тик не нужен
    mux.serverTick({ s: "BTCUSDT", p: "99", at: iso(now()) });
    expect(live.bar!.low).toBe(100.2);
    // минута закрылась на бирже (x = true) — закрытая свеча 1m; следующая — новая справа
    ws.kline(M, { o: "100.5", h: "100.9", l: "100.2", c: "100.8", v: "6", x: true }, M + 60);
    const final = { time: M, open: 100.5, high: 100.9, low: 100.2, close: 100.8, volume: 6, open_: false };
    expect(live.bar).toEqual(final);
    vi.setSystemTime((M + 60.3) * 1000);
    ws.kline(M + 60, { o: "100.8", h: "100.85", l: "100.8", c: "100.85", v: "1" }, M + 60.3);
    expect(live.closed.at(-1)).toEqual(final);
    expect(live.bar).toMatchObject({ time: M + 60, close: 100.85 });
    // геоблок / обрыв: сразу сервер, без ожидания FRESH_MS
    ws.onerror!();
    expect(sources.at(-1)).toBe("server");
    expect(feed.isFresh("BTCUSDT")).toBe(false);
    mux.serverTick({ s: "BTCUSDT", p: "100.9", at: iso(M + 61) });
    expect(live.bar).toMatchObject({ time: M + 60, close: 100.9, high: 100.9 });
    // новая попытка через RETRY_MIN_MS — биржа снова основная
    await vi.advanceTimersByTimeAsync(RETRY_MIN_MS + 100);
    const ws2 = FakeWS.all[1]!;
    ws2.open();
    ws2.kline(M + 60, { o: "100.8", h: "100.95", l: "100.7", c: "100.92", v: "4" }, Date.now() / 1000);
    expect(sources.at(-1)).toBe("binance");
    expect(live.bar).toMatchObject({ time: M + 60, close: 100.92, high: 100.95, low: 100.7, volume: 4 });
    // тихий рынок: сделок нет 30 с, сервер повторяет ту же цену — биржа остаётся основной (соединение отвечает)
    for (let i = 0; i < 30; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      for (const c of ws2.sent.splice(0)) ws2.onmessage?.({ data: JSON.stringify({ result: [], id: (JSON.parse(c) as { id: number }).id }) });
      mux.serverTick({ s: "BTCUSDT", p: "100.92", at: iso(Date.now() / 1000 - 1) });
    }
    expect(sources.at(-1)).toBe("binance");
    expect(FakeWS.all).toHaveLength(2);
    // сервер видит новую цену, а биржа её не принесла дольше BEHIND_MS — улика: этот же тик сразу в свечу и шапку
    const at = Date.now() / 1000 - 1;
    mux.serverTick({ s: "BTCUSDT", p: "101.1", at: iso(at) });
    expect(at * 1000 - (M + 60) * 1000).toBeGreaterThan(BEHIND_MS);
    expect(sources.at(-1)).toBe("server");
    expect(live.bar).toMatchObject({ close: 101.1, high: 101.1 });
    expect(prices.at(-1)).toBe("101.1");
    // биржа догнала — снова основная
    ws2.trade("101.15", Date.now() / 1000);
    expect(sources.at(-1)).toBe("binance");
    feed.dispose();
  });
});
