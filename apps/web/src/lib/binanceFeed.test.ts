import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BATCH_MS,
  BinanceFeed,
  CONNECT_TIMEOUT_MS,
  CONTROL_GAP_MS,
  FIRST_DATA_MS,
  FRESH_MS,
  LINGER_MS,
  NO_DATA_MS,
  parseAggTrade,
  parseKline,
  PROBE_TIMEOUT_MS,
  RETRY_MAX_MS,
  RETRY_MIN_MS,
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
  readyState = 0;
  sent: string[] = [];
  closed = false;
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
  return new BinanceFeed({ url: "wss://x/stream", WebSocketImpl: FakeWS as unknown as typeof WebSocket, raf: (fn) => void frames.push(fn), random: () => 0, doc: null, win: null, ...extra });
}

const last = () => FakeWS.all.at(-1)!;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(MIN * 1000 + 10_000);
  FakeWS.all = [];
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

  it("имена потоков — строчными, адрес combined stream", () => {
    expect(streamsOf("BTCUSDT")).toEqual(["btcusdt@kline_1m", "btcusdt@aggTrade"]);
    expect(streamUrl("wss://fstream.binance.com/stream", ["a@kline_1m", "a@aggTrade"])).toBe("wss://fstream.binance.com/stream?streams=a@kline_1m/a@aggTrade");
  });
});

describe("подписка: одно соединение, SUBSCRIBE/UNSUBSCRIBE пачкой", () => {
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
    await vi.advanceTimersByTimeAsync(1000);
    expect(last().sent).toEqual([]);
    f.dispose();
  });

  it("смена символа: одно UNSUBSCRIBE и одно SUBSCRIBE в том же соединении; смена таймфрейма (тот же символ) — ничего", async () => {
    const f = feed();
    let off = f.subscribe("BTCUSDT", listener());
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    const ws = last();
    ws.open();
    // таймфрейм: отписка и подписка того же символа в одном такте
    off();
    off = f.subscribe("BTCUSDT", listener());
    await vi.advanceTimersByTimeAsync(500);
    expect(ws.sent).toEqual([]);
    // символ
    off();
    f.subscribe("SOLUSDT", listener());
    await vi.advanceTimersByTimeAsync(500);
    expect(ws.control.map(({ method, params }) => ({ method, params }))).toEqual([
      { method: "UNSUBSCRIBE", params: ["btcusdt@kline_1m", "btcusdt@aggTrade"] },
      { method: "SUBSCRIBE", params: ["solusdt@kline_1m", "solusdt@aggTrade"] },
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

  it("управляющие сообщения — не чаще CONTROL_GAP_MS (лимит Binance — 10 в секунду)", async () => {
    const f = feed();
    const first = f.subscribe("BTCUSDT", listener());
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    const ws = last();
    ws.open();
    ws.kline("BTCUSDT");
    const at: number[] = [];
    const send = ws.send.bind(ws);
    ws.send = (m: string) => {
      at.push(Date.now());
      send(m);
    };
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

describe("свежесть, отказ, тишина, паузы", () => {
  it("свежесть по символу: при подписке — как есть, первые данные — сразу, тишина символа FRESH_MS — с сервера, данные снова — с биржи", async () => {
    const f = feed();
    const btc = listener();
    const eth = listener();
    f.subscribe("BTCUSDT", btc);
    f.subscribe("ETHUSDT", eth);
    expect(btc.log.fresh).toEqual([false]);
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    const ws = last();
    ws.open();
    ws.kline("BTCUSDT");
    expect(btc.log.fresh).toEqual([false, true]);
    expect(f.isFresh("BTCUSDT")).toBe(true);
    expect(f.isFresh("ETHUSDT")).toBe(false);
    // ETH идёт, BTC молчит: соединение живо, BTC — с сервера через FRESH_MS
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      ws.trade("ETHUSDT", "2500");
    }
    expect(btc.log.fresh).toEqual([false, true, false]);
    expect(eth.log.fresh).toEqual([false, true]);
    expect(f.isFresh("BTCUSDT")).toBe(false);
    ws.kline("BTCUSDT");
    expect(btc.log.fresh.at(-1)).toBe(true);
    // подписчик, пришедший к свежему символу, узнаёт сразу
    const late = listener();
    f.subscribe("BTCUSDT", late);
    expect(late.log.fresh).toEqual([true]);
    expect(FakeWS.all).toHaveLength(1);
    f.dispose();
  });

  it("биржа недоступна (геоблок 451 — ошибка рукопожатия): с сервера, новые попытки через 5, 10, 20, 40, 60, 60 с; данные сбрасывают паузу", async () => {
    const f = feed();
    const l = listener();
    f.subscribe("BTCUSDT", l);
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      const ws = last();
      ws.error();
      ws.finishClose();
      const n = FakeWS.all.length;
      const from = Date.now();
      while (FakeWS.all.length === n) await vi.advanceTimersByTimeAsync(500);
      waits.push(Math.round((Date.now() - from) / 1000) * 1000);
    }
    expect(waits).toEqual([RETRY_MIN_MS, 10_000, 20_000, 40_000, RETRY_MAX_MS, RETRY_MAX_MS]);
    expect(l.log.fresh).toEqual([false]); // ни разу не была основной
    // заработала: данные — пауза снова минимальная
    last().open();
    last().kline("BTCUSDT");
    expect(l.log.fresh).toEqual([false, true]);
    last().finishClose();
    expect(l.log.fresh).toEqual([false, true, false]); // сразу с сервера, не через FRESH_MS
    expect(f.isFresh("BTCUSDT")).toBe(false);
    const n = FakeWS.all.length;
    await vi.advanceTimersByTimeAsync(RETRY_MIN_MS - 100);
    expect(FakeWS.all).toHaveLength(n);
    await vi.advanceTimersByTimeAsync(200);
    expect(FakeWS.all).toHaveLength(n + 1);
    expect(last().url).toContain("btcusdt@kline_1m");
    f.dispose();
  });

  it("соединение замолчало: проверка LIST_SUBSCRIPTIONS; ответ — соединение живо, символ с сервера; без ответа — новое после паузы", async () => {
    const f = feed();
    const l = listener();
    f.subscribe("BTCUSDT", l);
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    const ws = last();
    ws.open();
    ws.kline("BTCUSDT");
    await vi.advanceTimersByTimeAsync(SILENCE_MS + 1000);
    expect(ws.control.map((c) => c.method)).toEqual(["LIST_SUBSCRIPTIONS"]);
    expect(l.log.fresh).toEqual([false, true, false]);
    // ответ — соединение живо (символ просто молчит)
    ws.raw({ result: streamsOf("BTCUSDT"), id: ws.control[0]!.id });
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 1000);
    expect(FakeWS.all).toHaveLength(1);
    // снова тишина, проверка без ответа (полуоткрытый сокет) — закрыт, новое — через паузу
    await vi.advanceTimersByTimeAsync(SILENCE_MS);
    expect(ws.control.map((c) => c.method)).toEqual(["LIST_SUBSCRIPTIONS", "LIST_SUBSCRIPTIONS"]);
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 1000);
    expect(ws.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(RETRY_MIN_MS);
    expect(FakeWS.all).toHaveLength(2);
    // поздние сообщения старого сокета ничего не трогают
    ws.kline("BTCUSDT");
    expect(l.log.forming).toHaveLength(1);
    f.dispose();
  });

  it("рукопожатие дольше CONNECT_TIMEOUT_MS — новая попытка; открылось, но данных нет FIRST_DATA_MS (биржа отвечает, а рынка не шлёт) — отказ и пауза", async () => {
    const f = feed();
    const l = listener();
    f.subscribe("BTCUSDT", l);
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    // рукопожатие висит
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS + 1000);
    expect(FakeWS.all[0]!.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(RETRY_MIN_MS);
    expect(FakeWS.all).toHaveLength(2);
    // открылось, на управляющие отвечает, данных нет — так ведёт себя Binance из контейнера
    const ws = last();
    ws.open();
    ws.raw({ result: [], id: 1 });
    await vi.advanceTimersByTimeAsync(FIRST_DATA_MS + 1000);
    expect(ws.closed).toBe(true);
    expect(l.log.fresh).toEqual([false]);
    // пауза удвоилась: 10 с
    await vi.advanceTimersByTimeAsync(9000);
    expect(FakeWS.all).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1500);
    expect(FakeWS.all).toHaveLength(3);
    f.dispose();
  });

  it("данные были, потом только ответы на проверки дольше NO_DATA_MS — отказ и новое соединение после паузы", async () => {
    const f = feed();
    const l = listener();
    f.subscribe("BTCUSDT", l);
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    const ws = last();
    ws.open();
    ws.kline("BTCUSDT");
    // соединение отвечает на каждую проверку, но рыночных данных больше нет
    const answered = new Set<number>();
    for (let t = 0; t < NO_DATA_MS && !ws.closed; t += 1000) {
      await vi.advanceTimersByTimeAsync(1000);
      const probe = ws.control.at(-1);
      if (probe && !answered.has(probe.id)) {
        answered.add(probe.id);
        ws.raw({ result: streamsOf("BTCUSDT"), id: probe.id });
      }
    }
    expect(answered.size).toBeGreaterThanOrEqual(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(ws.closed).toBe(true);
    expect(l.log.fresh).toEqual([false, true, false]);
    await vi.advanceTimersByTimeAsync(RETRY_MIN_MS);
    expect(FakeWS.all).toHaveLength(2);
    f.dispose();
  });

  it("вкладка снова видна после сна: открытый, но молчащий сокет — новый сразу (без паузы)", async () => {
    const fns = new Set<() => void>();
    const doc = { visibilityState: "visible", addEventListener: (_: string, fn: () => void) => fns.add(fn), removeEventListener: (_: string, fn: () => void) => fns.delete(fn) };
    const f = feed({ doc: doc as unknown as Document });
    const l = listener();
    f.subscribe("BTCUSDT", l);
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    const ws = last();
    ws.open();
    ws.kline("BTCUSDT");
    fns.forEach((fn) => fn()); // свеж — ничего
    expect(FakeWS.all).toHaveLength(1);
    // таймеры телефона спали: часы ушли вперёд без проверок
    vi.setSystemTime(Date.now() + 60_000);
    fns.forEach((fn) => fn());
    expect(ws.closed).toBe(true);
    expect(FakeWS.all).toHaveLength(2);
    expect(l.log.fresh.at(-1)).toBe(false);
    f.dispose();
  });

  it("24 ч: за час до закрытия биржей — новое соединение с теми же потоками, старое закрыто, когда новое принесло данные; без паузы в свежести", async () => {
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
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeWS.all).toHaveLength(2);
    const next = last();
    expect(next.url).toBe(old.url);
    // пока новое без данных — данные старого идут
    next.open();
    next.raw({ result: null, id: 1 });
    old.kline("BTCUSDT", { c: "101" });
    expect(old.closed).toBe(false);
    expect(l.log.forming.at(-1)!.c.c).toBe("101");
    next.kline("BTCUSDT", { c: "102" });
    expect(old.closed).toBe(true);
    expect(l.log.forming.at(-1)!.c.c).toBe("102");
    old.kline("BTCUSDT", { c: "1" }); // старое уже отцеплено
    expect(l.log.forming.at(-1)!.c.c).toBe("102");
    expect(l.log.fresh).toEqual([false, true]);
    // подписка дальше идёт через новое соединение
    f.subscribe("ETHUSDT", listener());
    await vi.advanceTimersByTimeAsync(500);
    expect(next.control.map((c) => c.method)).toEqual(["SUBSCRIBE"]);
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

  it("свежесть гаснет без данных символа, даже если проверка таймером ещё не прошла (isFresh — по часам)", async () => {
    const f = feed();
    f.subscribe("BTCUSDT", listener());
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    last().open();
    last().kline("BTCUSDT");
    vi.setSystemTime(Date.now() + FRESH_MS);
    expect(f.isFresh("BTCUSDT")).toBe(false);
    f.dispose();
  });
});
