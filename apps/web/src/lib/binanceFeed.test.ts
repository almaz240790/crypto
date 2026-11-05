import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BATCH_MS,
  BEHIND_MS,
  BINANCE_WS,
  BinanceFeed,
  BLOCKED_AFTER,
  CONNECT_TIMEOUT_MS,
  CONTROL_GAP_MS,
  COOL_MS,
  LINGER_MS,
  parseAggTrade,
  parseKline,
  PROBE_TIMEOUT_MS,
  RETRY_KEY,
  RETRY_MAX_MS,
  RETRY_MIN_MS,
  retryWait,
  ROTATE_MS,
  SILENCE_MS,
  streamsOf,
  streamUrl,
  type BinanceListener,
} from "./binanceFeed";
import type { LiveCandle, LiveTick } from "./useLive";

/** Прямой поток Binance в браузере (ADR-0010, дополнение): одно соединение, подписки сообщениями, свежесть, паузы. */

/** WebSocket браузера: close() не доставляет onclose сам (полуоткрытое соединение) — только finishClose(). */
class FakeWS {
  static all: FakeWS[] = [];
  /** Отвечать на управляющие сообщения, как Binance (по умолчанию — нет: ответы — вручную). */
  static answer = false;
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  /** Время отправки каждого управляющего сообщения. */
  sentAt: number[] = [];
  constructor(readonly url: string) {
    FakeWS.all.push(this);
  }
  send(m: string) {
    this.sent.push(m);
    this.sentAt.push(Date.now());
    if (!FakeWS.answer) return;
    const c = JSON.parse(m) as { method: string; id: number };
    queueMicrotask(() => {
      if (!this.closed) this.raw({ result: c.method === "LIST_SUBSCRIPTIONS" ? [] : null, id: c.id });
    });
  }
  close() {
    this.closed = true;
    if (this.readyState < 2) this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  raw(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  /** Сообщение combined stream. */
  data(stream: string, d: Record<string, unknown>) {
    this.raw({ stream, data: d });
  }
  kline(s: string, k: Partial<{ t: number; o: string; h: string; l: string; c: string; v: string; x: boolean }> = {}, E = Date.now()) {
    this.data(`${s.toLowerCase()}@kline_1m`, { e: "kline", E, s, k: { t: MIN * 1000, o: "100", h: "101", l: "99", c: "100.5", v: "10", x: false, ...k } });
  }
  trade(s: string, p: string, T = Date.now()) {
    this.data(`${s.toLowerCase()}@aggTrade`, { e: "aggTrade", E: T + 5, s, p, q: "1", T, m: false });
  }
  /** Управляющие сообщения клиента. */
  get control(): { method: string; params?: string[]; id: number }[] {
    return this.sent.map((m) => JSON.parse(m) as { method: string; params?: string[]; id: number });
  }
  /** Ответить на последнее управляющее сообщение. */
  reply() {
    const c = this.control.at(-1);
    if (c) this.raw({ result: c.method === "LIST_SUBSCRIPTIONS" ? [] : null, id: c.id });
  }
  error() {
    this.onerror?.();
  }
  finishClose() {
    this.readyState = 3;
    this.onclose?.();
  }
}

/** Начало минуты фикстуры (unix с). */
const MIN = Date.UTC(2026, 10, 4, 8, 30) / 1000;

type Log = { ticks: LiveTick[]; forming: LiveCandle[]; candles: LiveCandle[]; fresh: boolean[] };
function listener(): BinanceListener & { log: Log } {
  const log: Log = { ticks: [], forming: [], candles: [], fresh: [] };
  return { log, tick: (t) => log.ticks.push(t), forming: (c) => log.forming.push(c), candle: (c) => log.candles.push(c), fresh: (on) => log.fresh.push(on) };
}

let frames: (() => void)[] = [];
const runFrame = () => {
  const f = frames;
  frames = [];
  f.forEach((fn) => fn());
};

function feed(extra: Partial<ConstructorParameters<typeof BinanceFeed>[0]> = {}) {
  return new BinanceFeed({ url: "wss://x/stream", WebSocketImpl: FakeWS as unknown as typeof WebSocket, raf: (fn) => void frames.push(fn), random: () => 0, doc: null, win: null, store: null, ...extra });
}

/** Событийные цели: документ (видимость) и окно (pageshow, online). */
function targets(visible = true) {
  const fns = new Map<string, Set<(e: unknown) => void>>();
  const on = (type: string, fn: (e: unknown) => void) => {
    let set = fns.get(type);
    if (!set) fns.set(type, (set = new Set()));
    set.add(fn);
  };
  const off = (type: string, fn: (e: unknown) => void) => void fns.get(type)?.delete(fn);
  const doc = { visibilityState: visible ? "visible" : "hidden", addEventListener: on, removeEventListener: off };
  const win = { addEventListener: on, removeEventListener: off };
  const fire = (type: string, e: unknown = {}) => fns.get(type)?.forEach((fn) => fn(e));
  return {
    doc: doc as unknown as Document,
    win: win as unknown as Window,
    hide: () => {
      doc.visibilityState = "hidden";
      fire("visibilitychange");
    },
    show: () => {
      doc.visibilityState = "visible";
      fire("visibilitychange");
    },
    online: () => fire("online"),
    pageshow: () => fire("pageshow", { persisted: true }),
    count: () => [...fns.values()].reduce((n, s) => n + s.size, 0),
  };
}

/** sessionStorage вкладки. */
function memoryStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), map: m };
}

const last = () => FakeWS.all.at(-1)!;

/** Ждать новое соединение (шаг 100 мс), не дольше limit; вернуть, сколько ждали. */
async function waitDial(limit: number): Promise<number> {
  const n = FakeWS.all.length;
  const from = Date.now();
  while (FakeWS.all.length === n && Date.now() - from < limit) await vi.advanceTimersByTimeAsync(100);
  return Date.now() - from;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(MIN * 1000 + 10_000);
  FakeWS.all = [];
  FakeWS.answer = false;
  frames = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe("разбор сообщений Binance", () => {
  it("kline 1m: минута в формате сервера (время — начало минуты в с, at — время события); x — закрытая", () => {
    const E = MIN * 1000 + 12_345;
    const k = parseKline({ e: "kline", E, s: "BTCUSDT", k: { t: MIN * 1000, T: MIN * 1000 + 59_999, s: "BTCUSDT", i: "1m", o: "1", h: "2", l: "0.5", c: "1.5", v: "7", x: false } });
    expect(k).toEqual({ closed: false, c: { s: "BTCUSDT", tf: "1m", c: { t: MIN, o: "1", h: "2", l: "0.5", c: "1.5", v: "7", at: new Date(E).toISOString() } } });
    expect(parseKline({ e: "kline", E, s: "BTCUSDT", k: { t: MIN * 1000, o: "1", h: "2", l: "0.5", c: "1.5", v: "7", x: true } })!.closed).toBe(true);
    expect(parseKline({ e: "kline", s: "BTCUSDT", k: { t: MIN * 1000, o: "1", h: "2", l: "0.5", c: "x", v: "7" } })).toBeNull();
    expect(parseKline({ e: "aggTrade" })).toBeNull();
    expect(parseKline(null)).toBeNull();
  });

  it("aggTrade: тик с ценой и временем сделки; битые поля — null", () => {
    const T = MIN * 1000 + 1500;
    expect(parseAggTrade({ e: "aggTrade", E: T + 3, s: "ETHUSDT", p: "2500.01", q: "3", T, m: true })).toEqual({ s: "ETHUSDT", p: "2500.01", at: new Date(T).toISOString() });
    expect(parseAggTrade({ e: "aggTrade", s: "ETHUSDT", p: "", T })).toBeNull();
    expect(parseAggTrade({ e: "aggTrade", s: "ETHUSDT", p: "1" })).toBeNull();
    expect(parseAggTrade(undefined)).toBeNull();
  });

  it("адрес — рыночные потоки (/market): старый /stream kline и сделок больше не шлёт; имена потоков — строчными", () => {
    expect(BINANCE_WS).toBe("wss://fstream.binance.com/market/stream");
    expect(streamsOf("BTCUSDT")).toEqual(["btcusdt@kline_1m", "btcusdt@aggTrade"]);
    expect(streamUrl(BINANCE_WS, ["a@kline_1m", "a@aggTrade"])).toBe("wss://fstream.binance.com/market/stream?streams=a@kline_1m/a@aggTrade");
    const f = new BinanceFeed({ WebSocketImpl: FakeWS as unknown as typeof WebSocket, doc: null, win: null, store: null });
    f.subscribe("BTCUSDT", listener());
    vi.advanceTimersByTime(BATCH_MS);
    expect(last().url).toBe("wss://fstream.binance.com/market/stream?streams=btcusdt@kline_1m/btcusdt@aggTrade");
    f.dispose();
  });
});

describe("подписка: одно соединение, SUBSCRIBE/UNSUBSCRIBE по разнице на момент отправки", () => {
  it("символы терминала и ячеек — одно соединение с потоками в адресе, без управляющих сообщений", async () => {
    const f = feed();
    f.subscribe("BTCUSDT", listener());
    f.subscribe("ETHUSDT", listener());
    f.subscribe("BTCUSDT", listener()); // вторая ячейка с тем же символом
    expect(FakeWS.all).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    expect(FakeWS.all).toHaveLength(1);
    expect(last().url).toBe("wss://x/stream?streams=btcusdt@kline_1m/btcusdt@aggTrade/ethusdt@kline_1m/ethusdt@aggTrade");
    last().open();
    last().kline("BTCUSDT");
    await vi.advanceTimersByTimeAsync(1000);
    expect(last().sent).toEqual([]);
    f.dispose();
  });

  it("смена символа: SUBSCRIBE нового (сразу), затем UNSUBSCRIBE прежнего в том же соединении; смена таймфрейма — ничего", async () => {
    const f = feed();
    let off = f.subscribe("BTCUSDT", listener());
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    const ws = last();
    ws.open();
    ws.kline("BTCUSDT");
    // таймфрейм: отписка и подписка того же символа в одном такте
    off();
    off = f.subscribe("BTCUSDT", listener());
    await vi.advanceTimersByTimeAsync(500);
    expect(ws.sent).toEqual([]);
    // символ
    off();
    f.subscribe("SOLUSDT", listener());
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    expect(ws.control.map(({ method, params }) => ({ method, params }))).toEqual([{ method: "SUBSCRIBE", params: ["solusdt@kline_1m", "solusdt@aggTrade"] }]);
    await vi.advanceTimersByTimeAsync(CONTROL_GAP_MS);
    expect(ws.control.map(({ method, params }) => ({ method, params }))).toEqual([
      { method: "SUBSCRIBE", params: ["solusdt@kline_1m", "solusdt@aggTrade"] },
      { method: "UNSUBSCRIBE", params: ["btcusdt@kline_1m", "btcusdt@aggTrade"] },
    ]);
    expect(new Set(ws.control.map((c) => c.id)).size).toBe(2);
    expect(f.streams.sort()).toEqual(["solusdt@aggTrade", "solusdt@kline_1m"]);
    expect(FakeWS.all).toHaveLength(1);
    f.dispose();
  });

  it("подписка, пока идёт рукопожатие: после открытия — сверка потоков одним SUBSCRIBE", async () => {
    const f = feed();
    f.subscribe("BTCUSDT", listener());
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    f.subscribe("ETHUSDT", listener());
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    expect(FakeWS.all).toHaveLength(1);
    last().open();
    await vi.advanceTimersByTimeAsync(10);
    expect(last().control.map((c) => [c.method, c.params])).toEqual([["SUBSCRIBE", ["ethusdt@kline_1m", "ethusdt@aggTrade"]]]);
    f.dispose();
  });

  it("быстрый перебор символов (каждые 170 мс): каждое сообщение — по текущему символу, ни одного SUBSCRIBE ушедшего; последний — за BATCH_MS + CONTROL_GAP_MS", async () => {
    FakeWS.answer = true;
    const f = feed();
    let off = f.subscribe("BTCUSDT", listener());
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    const ws = last();
    ws.open();
    ws.kline("BTCUSDT");
    const syms = ["ETH", "SOL", "ADA", "XRP", "DOGE", "LINK", "AVAX", "DOT", "LTC", "BNB"].map((s) => `${s}USDT`);
    const current: { at: number; sym: string }[] = [];
    for (const sym of syms) {
      off();
      off = f.subscribe(sym, listener());
      current.push({ at: Date.now(), sym });
      await vi.advanceTimersByTimeAsync(170);
    }
    const lastSwitch = current.at(-1)!.at;
    await vi.advanceTimersByTimeAsync(2000);
    const at = (t: number) => current.filter((c) => c.at <= t).at(-1)!.sym.toLowerCase();
    const subs = ws.control.map((c, i) => ({ ...c, t: ws.sentAt[i]! })).filter((c) => c.method === "SUBSCRIBE");
    expect(subs.length).toBeGreaterThan(0);
    for (const s of subs) expect(s.params).toEqual(streamsOf(at(s.t)));
    const final = subs.at(-1)!;
    expect(final.params).toEqual(streamsOf("BNBUSDT"));
    expect(final.t - lastSwitch).toBeLessThanOrEqual(BATCH_MS + CONTROL_GAP_MS);
    expect(f.streams.sort()).toEqual(["bnbusdt@aggTrade", "bnbusdt@kline_1m"]);
    f.dispose();
  });

  it("клавиша зажата в ячейке мультичарта (30 смен в секунду): очередь не растёт — сообщений не больше одного на CONTROL_GAP_MS, итог — последний символ сразу", async () => {
    FakeWS.answer = true;
    const f = feed();
    f.subscribe("BTCUSDT", listener()); // терминал
    let off = f.subscribe("ETHUSDT", listener()); // ячейка
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    const ws = last();
    ws.open();
    ws.kline("BTCUSDT");
    const from = Date.now();
    for (let i = 0; i < 33; i++) {
      off();
      off = f.subscribe(`C${i}USDT`, listener());
      await vi.advanceTimersByTimeAsync(33);
    }
    const released = Date.now();
    await vi.advanceTimersByTimeAsync(BATCH_MS + CONTROL_GAP_MS);
    // последний символ подписан не позже BATCH_MS + CONTROL_GAP_MS после отпускания
    const subC32 = ws.control.findIndex((c) => c.method === "SUBSCRIBE" && c.params?.includes("c32usdt@kline_1m"));
    expect(subC32).toBeGreaterThanOrEqual(0);
    expect(ws.sentAt[subC32]! - released).toBeLessThanOrEqual(BATCH_MS + CONTROL_GAP_MS);
    await vi.advanceTimersByTimeAsync(2000);
    expect(ws.sent.length).toBeLessThanOrEqual(Math.ceil((released - from) / CONTROL_GAP_MS) + 3);
    for (let i = 1; i < ws.sentAt.length; i++) expect(ws.sentAt[i]! - ws.sentAt[i - 1]!).toBeGreaterThanOrEqual(CONTROL_GAP_MS);
    expect(f.streams.sort()).toEqual(["btcusdt@aggTrade", "btcusdt@kline_1m", "c32usdt@aggTrade", "c32usdt@kline_1m"]);
    f.dispose();
  });

  it("управляющие сообщения — не чаще CONTROL_GAP_MS (лимит Binance — 10 в секунду)", async () => {
    const f = feed();
    const first = f.subscribe("BTCUSDT", listener());
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    const ws = last();
    ws.open();
    ws.kline("BTCUSDT");
    // пользователь быстро перебирает символы: 20 смен за секунду
    let off = first;
    for (let i = 0; i < 20; i++) {
      off();
      off = f.subscribe(`C${i}USDT`, listener());
      await vi.advanceTimersByTimeAsync(50);
    }
    for (let i = 0; i < 5; i++) {
      ws.kline("C19USDT");
      await vi.advanceTimersByTimeAsync(1000);
    }
    const at = ws.sentAt;
    expect(at.length).toBeGreaterThan(4);
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(CONTROL_GAP_MS);
    for (const t of at) expect(at.filter((x) => x >= t && x < t + 1000).length).toBeLessThanOrEqual(10);
    // итог — только последний символ
    expect(f.streams.sort()).toEqual(["c19usdt@aggTrade", "c19usdt@kline_1m"]);
    f.dispose();
  });

  it("символов не осталось — UNSUBSCRIBE и закрытие через LINGER_MS; вернулись раньше — то же соединение", async () => {
    const f = feed();
    let off = f.subscribe("BTCUSDT", listener());
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    const ws = last();
    ws.open();
    ws.kline("BTCUSDT");
    off();
    await vi.advanceTimersByTimeAsync(LINGER_MS - 1000);
    expect(ws.control.map((c) => c.method)).toEqual(["UNSUBSCRIBE"]);
    off = f.subscribe("BTCUSDT", listener());
    // поток снова идёт — соединение живо
    for (let i = 0; i < LINGER_MS / 1000; i++) {
      ws.kline("BTCUSDT");
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(ws.closed).toBe(false);
    expect(ws.control.map((c) => c.method)).toEqual(["UNSUBSCRIBE", "SUBSCRIBE"]);
    off();
    await vi.advanceTimersByTimeAsync(LINGER_MS + 100);
    expect(ws.closed).toBe(true);
    expect(FakeWS.all).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    f.dispose();
  });

  it("ушли со страницы графика, пока соединения нет (пауза после отказа), — таймеров не остаётся; подписка и отписка за BATCH_MS — тоже", async () => {
    const f = feed();
    const off = f.subscribe("BTCUSDT", listener());
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    last().error();
    expect(f.connected).toBe(false);
    expect(vi.getTimerCount()).toBeGreaterThan(0); // проверка раз в секунду и пауза
    off();
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS);
    expect(FakeWS.all).toHaveLength(1);
    // до первого соединения: пришли и ушли в одном такте
    const off2 = f.subscribe("ETHUSDT", listener());
    off2();
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    expect(vi.getTimerCount()).toBe(0);
    expect(FakeWS.all).toHaveLength(1);
    f.dispose();
  });
});

describe("события: kline и сделки", () => {
  it("kline x = false — формирующаяся минута, x = true — закрытая; чужие и отписанные символы — мимо", async () => {
    const f = feed();
    const a = listener();
    const b = listener();
    f.subscribe("BTCUSDT", a);
    f.subscribe("BTCUSDT", b);
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    const ws = last();
    ws.open();
    ws.kline("BTCUSDT", { c: "100.7", v: "12" });
    ws.kline("BTCUSDT", { c: "100.9", v: "15", x: true });
    ws.kline("XRPUSDT", { c: "1" });
    for (const l of [a, b]) {
      expect(l.log.forming.map((c) => [c.c.t, c.c.c, c.c.v])).toEqual([[MIN, "100.7", "12"]]);
      expect(l.log.candles.map((c) => [c.c.t, c.c.c, c.c.v])).toEqual([[MIN, "100.9", "15"]]);
    }
    f.dispose();
  });

  it("сделки — последняя цена за кадр анимации на символ; сделка старше уже взятой цену не откатывает", async () => {
    const f = feed();
    const btc = listener();
    const eth = listener();
    f.subscribe("BTCUSDT", btc);
    f.subscribe("ETHUSDT", eth);
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    const ws = last();
    ws.open();
    const T = Date.now();
    ws.trade("BTCUSDT", "100.1", T);
    ws.trade("BTCUSDT", "100.3", T + 30);
    ws.trade("BTCUSDT", "100.2", T + 10); // пришла позже, но сделка раньше
    ws.trade("ETHUSDT", "2500", T + 5);
    expect(frames).toHaveLength(1); // один кадр на все
    expect(btc.log.ticks).toEqual([]);
    runFrame();
    expect(btc.log.ticks).toEqual([{ s: "BTCUSDT", p: "100.3", at: new Date(T + 30).toISOString() }]);
    expect(eth.log.ticks.map((t) => t.p)).toEqual(["2500"]);
    ws.trade("BTCUSDT", "100.4", T + 40);
    runFrame();
    expect(btc.log.ticks.map((t) => t.p)).toEqual(["100.3", "100.4"]);
    f.dispose();
  });
});

describe("свежесть: соединение живо и данные символа были", () => {
  it("до первых данных символа — сервер (снимка при подписке нет); первые данные — биржа; тихий символ остаётся на бирже, пока соединение отвечает", async () => {
    FakeWS.answer = true;
    const f = feed();
    const btc = listener();
    const dydx = listener();
    f.subscribe("BTCUSDT", btc);
    f.subscribe("DYDXUSDT", dydx);
    expect(btc.log.fresh).toEqual([false]);
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    const ws = last();
    ws.open();
    ws.kline("BTCUSDT");
    expect(btc.log.fresh).toEqual([false, true]);
    expect(f.isFresh("BTCUSDT")).toBe(true);
    expect(f.isFresh("DYDXUSDT")).toBe(false);
    // ни у кого нет сделок минуту: соединение отвечает на проверки — ни отказа, ни переподключения, ни смены источника
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ws.control.filter((c) => c.method === "LIST_SUBSCRIPTIONS").length).toBeGreaterThanOrEqual(10);
    expect(ws.closed).toBe(false);
    expect(FakeWS.all).toHaveLength(1);
    expect(btc.log.fresh).toEqual([false, true]);
    expect(f.isFresh("BTCUSDT")).toBe(true);
    // первая сделка тихого символа через 60 с после подключения — биржа и для него
    ws.trade("DYDXUSDT", "0.61");
    expect(dydx.log.fresh).toEqual([false, true]);
    // подписчик, пришедший к свежему символу, узнаёт сразу
    const late = listener();
    f.subscribe("BTCUSDT", late);
    expect(late.log.fresh).toEqual([true]);
    f.dispose();
  });

  it("новое соединение без данных (тихий рынок при подключении) не рвётся: первая сделка через 40 с — биржа", async () => {
    FakeWS.answer = true;
    const f = feed();
    const l = listener();
    f.subscribe("GRTUSDT", l);
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    const ws = last();
    ws.open();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(FakeWS.all).toHaveLength(1);
    expect(ws.closed).toBe(false);
    expect(l.log.fresh).toEqual([false]);
    ws.kline("GRTUSDT", { c: "0.08" });
    expect(l.log.fresh).toEqual([false, true]);
    expect(l.log.forming).toHaveLength(1);
    f.dispose();
  });

  it("соединение молчит SILENCE_MS — проверка LIST_SUBSCRIPTIONS; ответ — живо; без ответа PROBE_TIMEOUT_MS — мёртво: сразу с сервера, новое после паузы", async () => {
    const f = feed();
    const l = listener();
    f.subscribe("BTCUSDT", l);
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    const ws = last();
    ws.open();
    ws.kline("BTCUSDT");
    await vi.advanceTimersByTimeAsync(SILENCE_MS + 1000);
    expect(ws.control.map((c) => c.method)).toEqual(["LIST_SUBSCRIPTIONS"]);
    expect(l.log.fresh).toEqual([false, true]); // тишина символа — не отказ
    // ответ — соединение живо (символ просто молчит)
    ws.reply();
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 1000);
    expect(FakeWS.all).toHaveLength(1);
    expect(l.log.fresh).toEqual([false, true]);
    // снова тишина, проверка без ответа (полуоткрытый сокет) — закрыт, символ с сервера, новое — через паузу
    await vi.advanceTimersByTimeAsync(SILENCE_MS);
    expect(ws.control.map((c) => c.method)).toEqual(["LIST_SUBSCRIPTIONS", "LIST_SUBSCRIPTIONS"]);
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 1000);
    expect(ws.closed).toBe(true);
    expect(l.log.fresh).toEqual([false, true, false]);
    await vi.advanceTimersByTimeAsync(RETRY_MIN_MS);
    expect(FakeWS.all).toHaveLength(2);
    // поздние сообщения старого сокета ничего не трогают
    ws.kline("BTCUSDT");
    expect(l.log.forming).toHaveLength(1);
    f.dispose();
  });

  it("улика сервера: его тик с новой ценой новее данных биржи больше BEHIND_MS — сразу сервер; та же цена или тик старше — ничего; биржа догнала — снова биржа", async () => {
    FakeWS.answer = true;
    const f = feed();
    const l = listener();
    f.subscribe("BTCUSDT", l);
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    const ws = last();
    ws.open();
    const t0 = Date.now();
    ws.trade("BTCUSDT", "100.5", t0);
    const tick = (p: string, dt: number) => f.server({ s: "BTCUSDT", p, at: new Date(t0 + dt).toISOString() });
    // сервер отстаёт: тик старше или ровесник данных биржи с другой ценой — обычное дело
    tick("100.4", -1500);
    tick("100.2", BEHIND_MS);
    // тихий рынок: та же цена через 30 с — биржа права
    await vi.advanceTimersByTimeAsync(30_000);
    tick("100.50", 30_000);
    expect(l.log.fresh).toEqual([false, true]);
    // новая цена на сервере, а у биржи её нет — биржа отстала
    tick("100.7", 30_000);
    expect(l.log.fresh).toEqual([false, true, false]);
    expect(f.isFresh("BTCUSDT")).toBe(false);
    // запоздавшие данные биржи старше улики — ещё не догнала
    ws.trade("BTCUSDT", "100.6", t0 + 20_000);
    expect(f.isFresh("BTCUSDT")).toBe(false);
    // догнала: событие биржи на уровне улики сервера
    ws.trade("BTCUSDT", "100.7", t0 + 29_500);
    expect(l.log.fresh).toEqual([false, true, false, true]);
    expect(FakeWS.all).toHaveLength(1);
    f.dispose();
  });

  it("биржа недоступна (геоблок 451 — ошибка рукопожатия): с сервера, попытки через 5, 10, 20, 40, 60 с, затем раз в COOL_MS; ответ биржи сбрасывает паузу", async () => {
    const f = feed();
    const l = listener();
    f.subscribe("BTCUSDT", l);
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    const waits: number[] = [];
    for (let i = 0; i < BLOCKED_AFTER + 1; i++) {
      const ws = last();
      ws.error();
      ws.finishClose();
      waits.push(Math.round((await waitDial(COOL_MS + 5000)) / 1000) * 1000);
    }
    expect(waits).toEqual([RETRY_MIN_MS, 10_000, 20_000, 40_000, RETRY_MAX_MS, COOL_MS, COOL_MS]);
    expect([1, 2, 3, 4, 5, 6, 7].map(retryWait)).toEqual(waits);
    expect(l.log.fresh).toEqual([false]); // ни разу не была основной
    // заработала: ответ — пауза снова минимальная
    last().open();
    last().kline("BTCUSDT");
    expect(l.log.fresh).toEqual([false, true]);
    last().finishClose();
    expect(l.log.fresh).toEqual([false, true, false]); // сразу с сервера
    expect(f.isFresh("BTCUSDT")).toBe(false);
    const n = FakeWS.all.length;
    await vi.advanceTimersByTimeAsync(RETRY_MIN_MS - 100);
    expect(FakeWS.all).toHaveLength(n);
    await vi.advanceTimersByTimeAsync(200);
    expect(FakeWS.all).toHaveLength(n + 1);
    expect(last().url).toContain("btcusdt@kline_1m");
    f.dispose();
  });

  it("рукопожатие дольше CONNECT_TIMEOUT_MS — отказ и новая попытка после паузы", async () => {
    const f = feed();
    f.subscribe("BTCUSDT", listener());
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS + 1000);
    expect(FakeWS.all[0]!.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(RETRY_MIN_MS);
    expect(FakeWS.all).toHaveLength(2);
    f.dispose();
  });

  it("24 ч: за час до закрытия биржей — новое соединение с теми же потоками; основным становится, когда ответило; без паузы в свежести", async () => {
    const f = feed();
    const l = listener();
    f.subscribe("BTCUSDT", l);
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    const old = last();
    old.open();
    // поток идёт 23 ч (часы — скачком, данные — каждую секунду проверки)
    vi.setSystemTime(Date.now() + ROTATE_MS - 2000);
    old.kline("BTCUSDT");
    await vi.advanceTimersByTimeAsync(1000);
    old.kline("BTCUSDT");
    expect(FakeWS.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    old.kline("BTCUSDT");
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWS.all).toHaveLength(2);
    const next = last();
    expect(next.url).toBe(old.url);
    // открылось — проверка; пока не ответило, данные старого идут
    next.open();
    expect(next.control.map((c) => c.method)).toEqual(["LIST_SUBSCRIPTIONS"]);
    old.kline("BTCUSDT", { c: "101" });
    expect(old.closed).toBe(false);
    expect(l.log.forming.at(-1)!.c.c).toBe("101");
    next.reply();
    expect(old.closed).toBe(true);
    next.kline("BTCUSDT", { c: "102" });
    expect(l.log.forming.at(-1)!.c.c).toBe("102");
    old.kline("BTCUSDT", { c: "1" }); // старое уже отцеплено
    expect(l.log.forming.at(-1)!.c.c).toBe("102");
    expect(l.log.fresh).toEqual([false, true]);
    // подписка дальше идёт через новое соединение
    f.subscribe("ETHUSDT", listener());
    await vi.advanceTimersByTimeAsync(500);
    expect(next.control.map((c) => c.method)).toEqual(["LIST_SUBSCRIPTIONS", "SUBSCRIBE"]);
    // новое закрылось — обычная пауза и попытка
    next.finishClose();
    expect(l.log.fresh.at(-1)).toBe(false);
    await vi.advanceTimersByTimeAsync(RETRY_MIN_MS);
    expect(FakeWS.all).toHaveLength(3);
    f.dispose();
  });

  it("24 ч: замена не открылась — старое работает, следующая попытка через минуту", async () => {
    const f = feed();
    f.subscribe("BTCUSDT", listener());
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    const old = last();
    old.open();
    vi.setSystemTime(Date.now() + ROTATE_MS);
    old.kline("BTCUSDT");
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWS.all).toHaveLength(2);
    last().error();
    for (let i = 0; i < 30; i++) {
      old.kline("BTCUSDT");
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(FakeWS.all).toHaveLength(2);
    for (let i = 0; i < 40; i++) {
      old.kline("BTCUSDT");
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(FakeWS.all).toHaveLength(3);
    expect(old.closed).toBe(false);
    f.dispose();
  });
});

describe("пауза: возврат вкладки, сеть, уход со страницы, перезагрузка", () => {
  it("вкладка снова видна после сна: открытый, но молчащий дольше живого сокет — новый сразу; молчит недолго — проверка", async () => {
    const ev = targets();
    const f = feed({ doc: ev.doc, win: ev.win });
    const l = listener();
    f.subscribe("BTCUSDT", l);
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    const ws = last();
    ws.open();
    ws.kline("BTCUSDT");
    ev.show(); // свеж — ничего
    expect(FakeWS.all).toHaveLength(1);
    expect(ws.sent).toEqual([]);
    // таймеры телефона спали: часы ушли вперёд без проверок
    vi.setSystemTime(Date.now() + 60_000);
    ev.show();
    expect(ws.closed).toBe(true);
    expect(FakeWS.all).toHaveLength(2);
    expect(l.log.fresh.at(-1)).toBe(false);
    // новое ответило; тишина SILENCE_MS (без проверки таймером) — вкладка видна: проверка, а не новое соединение
    const ws2 = last();
    ws2.open();
    ws2.kline("BTCUSDT");
    vi.setSystemTime(Date.now() + SILENCE_MS + 500);
    ev.pageshow();
    expect(FakeWS.all).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(ws2.control.map((c) => c.method)).toEqual(["LIST_SUBSCRIPTIONS"]);
    f.dispose();
    expect(ev.count()).toBe(0);
  });

  it("сокет закрылся во сне (iOS доставляет close до visibilitychange) — при возврате новое сразу, пауза не растёт", async () => {
    const ev = targets();
    const f = feed({ doc: ev.doc, win: ev.win });
    const l = listener();
    f.subscribe("BTCUSDT", l);
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    for (let i = 0; i < 3; i++) {
      const ws = last();
      ws.open();
      ws.kline("BTCUSDT");
      await vi.advanceTimersByTimeAsync(120_000 / 60); // поток шёл
      const n = FakeWS.all.length;
      ws.finishClose(); // разблокировка: сначала close…
      expect(l.log.fresh.at(-1)).toBe(false);
      ev.show(); // …потом visibilitychange
      expect(FakeWS.all).toHaveLength(n + 1);
    }
    // тот же порядок, но новое не открылось: пауза — первая (5 с), а не удвоенная
    last().error();
    const n = FakeWS.all.length;
    await vi.advanceTimersByTimeAsync(RETRY_MIN_MS - 200);
    expect(FakeWS.all).toHaveLength(n);
    await vi.advanceTimersByTimeAsync(400);
    expect(FakeWS.all).toHaveLength(n + 1);
    f.dispose();
  });

  it("закрытие в скрытой вкладке — не отказ: попыток нет, пока вкладка скрыта; при возврате — сразу", async () => {
    const ev = targets();
    const f = feed({ doc: ev.doc, win: ev.win });
    f.subscribe("BTCUSDT", listener());
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    const ws = last();
    ws.open();
    ws.kline("BTCUSDT");
    ev.hide();
    ws.finishClose();
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * 3);
    expect(FakeWS.all).toHaveLength(1);
    ev.show();
    expect(FakeWS.all).toHaveLength(2);
    // закрытие в скрытой вкладке паузу не нарастило: отказ после возврата — первый (5 с)
    last().error();
    expect(Math.round((await waitDial(RETRY_MAX_MS)) / 1000) * 1000).toBe(RETRY_MIN_MS);
    f.dispose();
  });

  it("сеть вернулась (online) во время паузы — попытка сразу, не дожидаясь 20 с", async () => {
    const ev = targets();
    const f = feed({ doc: ev.doc, win: ev.win });
    const l = listener();
    f.subscribe("BTCUSDT", l);
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    // туннель: три попытки подряд не удались — следующая через 20 с
    for (let i = 0; i < 3; i++) {
      last().error();
      if (i < 2) await waitDial(RETRY_MAX_MS);
    }
    const n = FakeWS.all.length;
    await vi.advanceTimersByTimeAsync(1000);
    ev.online();
    expect(FakeWS.all).toHaveLength(n + 1);
    last().open();
    last().kline("BTCUSDT");
    expect(l.log.fresh.at(-1)).toBe(true);
    f.dispose();
  });

  it("долгая пауза (геоблок): возврат вкладки её не прерывает, сеть вернулась (online) — одна попытка", async () => {
    const ev = targets();
    const f = feed({ doc: ev.doc, win: ev.win });
    f.subscribe("BTCUSDT", listener());
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    for (let i = 0; i < BLOCKED_AFTER; i++) {
      last().error();
      if (i < BLOCKED_AFTER - 1) await waitDial(RETRY_MAX_MS + 2000);
    }
    const n = FakeWS.all.length;
    ev.hide();
    ev.show();
    ev.pageshow();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(FakeWS.all).toHaveLength(n);
    ev.online();
    expect(FakeWS.all).toHaveLength(n + 1);
    // и она не удалась — снова долгая пауза
    last().error();
    expect(await waitDial(COOL_MS + 2000)).toBeGreaterThanOrEqual(COOL_MS);
    f.dispose();
  });

  it("ушли со страницы графика и вернулись во время паузы — попытка не раньше конца паузы (ошибка в консоли не чаще)", async () => {
    const f = feed();
    let off = f.subscribe("BTCUSDT", listener());
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    last().error(); // 1-я: следующая через 5 с
    await waitDial(RETRY_MAX_MS);
    last().error(); // 2-я: следующая через 10 с
    await waitDial(RETRY_MAX_MS);
    last().error(); // 3-я: следующая через 20 с
    const failedAt = Date.now();
    const n = FakeWS.all.length;
    // три раза «Скринер → назад к графику» за 6 с
    for (let i = 0; i < 3; i++) {
      off();
      await vi.advanceTimersByTimeAsync(1000);
      off = f.subscribe("BTCUSDT", listener());
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(FakeWS.all).toHaveLength(n);
    const waited = await waitDial(RETRY_MAX_MS);
    expect(Date.now() - failedAt).toBeGreaterThanOrEqual(20_000);
    expect(Date.now() - failedAt).toBeLessThan(20_000 + 200);
    expect(waited).toBeGreaterThan(0);
    f.dispose();
  });

  it("пауза переживает перезагрузку вкладки (sessionStorage): новая страница не стучится сразу; ответ биржи паузу стирает", async () => {
    const store = memoryStore();
    const a = feed({ store });
    a.subscribe("BTCUSDT", listener());
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    for (let i = 0; i < 3; i++) {
      last().error();
      if (i < 2) await waitDial(RETRY_MAX_MS);
    }
    a.dispose();
    expect(JSON.parse(store.map.get(RETRY_KEY)!)).toMatchObject({ fails: 3 });
    await vi.advanceTimersByTimeAsync(3000);
    const n = FakeWS.all.length;
    // перезагрузка: новая страница, та же вкладка
    const b = feed({ store });
    b.subscribe("BTCUSDT", listener());
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    expect(FakeWS.all).toHaveLength(n);
    await vi.advanceTimersByTimeAsync(20_000 - 3000);
    expect(FakeWS.all).toHaveLength(n + 1);
    last().open();
    last().reply();
    last().raw({ result: [], id: 1 });
    expect(JSON.parse(store.map.get(RETRY_KEY)!)).toEqual({ fails: 0, retryAt: 0 });
    b.dispose();
    // хранилище запрещено — работает без него
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    const c = feed({ store: broken });
    c.subscribe("BTCUSDT", listener());
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    expect(FakeWS.all).toHaveLength(n + 2);
    last().error();
    expect(await waitDial(RETRY_MAX_MS)).toBeGreaterThanOrEqual(RETRY_MIN_MS);
    c.dispose();
  });
});
