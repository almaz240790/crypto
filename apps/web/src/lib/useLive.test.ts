import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_MS, dispatchLive, isNewer, LiveSocket, mergePrices, ONLINE_MS, PONG_TIMEOUT_MS, PriceBatch, PRICE_STATE_MS, RECONNECT_WAIT_MS, RETRY_JITTER_MS, RETRY_MS, SILENCE_MS, type LiveMsg, type LivePrice, type LiveTick } from "./useLive";

/** Цена в шапке (ADR-0010): тики копятся и попадают в состояние React не чаще раза в секунду. */

afterEach(() => {
  vi.useRealTimers();
});

const at = (s: number) => new Date(Date.UTC(2026, 10, 4, 8, 0, s)).toISOString();

describe("цена в шапке", () => {
  it("тики каждые 250 мс: первый сразу, дальше не чаще раза в секунду и только последняя цена", () => {
    vi.useFakeTimers();
    const flushed: Record<string, LivePrice>[] = [];
    const batch = new PriceBatch((b) => flushed.push(b));
    for (let i = 0; i < 8; i++) {
      batch.push("BTCUSDT", { p: String(100 + i), at: at(i) });
      vi.advanceTimersByTime(250);
    }
    // 2 с тиков: сразу, на 1-й и на 2-й секунде (последняя цена к этому моменту) — 3 обновления, не 8
    expect(flushed.map((b) => b.BTCUSDT!.p)).toEqual(["100", "103", "107"]);
    vi.advanceTimersByTime(5 * PRICE_STATE_MS);
    expect(flushed).toHaveLength(3); // новых тиков нет — и обновлений нет
    batch.dispose();
  });

  it("много символов за секунду — одно обновление состояния", () => {
    vi.useFakeTimers();
    const flushed: Record<string, LivePrice>[] = [];
    const batch = new PriceBatch((b) => flushed.push(b));
    batch.push("BTCUSDT", { p: "1", at: at(0) });
    for (const s of ["ETHUSDT", "SOLUSDT", "XRPUSDT"]) batch.push(s, { p: "2", at: at(0) });
    expect(flushed).toHaveLength(1);
    vi.advanceTimersByTime(PRICE_STATE_MS);
    expect(flushed).toHaveLength(2);
    expect(Object.keys(flushed[1]!).sort()).toEqual(["ETHUSDT", "SOLUSDT", "XRPUSDT"]);
    batch.dispose();
    vi.advanceTimersByTime(PRICE_STATE_MS);
    batch.push("BTCUSDT", { p: "3", at: at(5) });
    expect(flushed).toHaveLength(3); // после секунды тишины — снова сразу
  });

  it("закрытая минута (price) старше тика цену не откатывает; без изменений — то же состояние", () => {
    const prev = { BTCUSDT: { p: "101.5", at: at(30) } };
    expect(isNewer(prev.BTCUSDT, { p: "100", at: at(0) })).toBe(false);
    expect(mergePrices(prev, { BTCUSDT: { p: "100", at: at(0) } })).toBe(prev);
    expect(mergePrices(prev, { BTCUSDT: { p: "101.5", at: at(30) } })).toBe(prev);
    const next = mergePrices(prev, { BTCUSDT: { p: "101.7", at: at(31) }, ETHUSDT: { p: "2500", at: at(31) } });
    expect(next).toEqual({ BTCUSDT: { p: "101.7", at: at(31) }, ETHUSDT: { p: "2500", at: at(31) } });
    expect(isNewer(undefined, { p: "1", at: "" })).toBe(true);
  });
});

describe("пачка тиков", () => {
  it("{t:'ticks'} раскладывается по символам: цены и колбэк тика на каждый", () => {
    const flushed: Record<string, LivePrice>[] = [];
    const batch = new PriceBatch((b) => flushed.push(b));
    const ticks: LiveTick[] = [];
    dispatchLive({ t: "ticks", at: at(1), p: { BTCUSDT: "1", ETHUSDT: "2" } }, { onTick: (t) => ticks.push(t) }, batch);
    expect(ticks).toEqual([
      { s: "BTCUSDT", p: "1", at: at(1) },
      { s: "ETHUSDT", p: "2", at: at(1) },
    ]);
    expect(flushed[0]).toEqual({ BTCUSDT: { p: "1", at: at(1) } });
    batch.dispose();
  });
});

describe("цены у получателя (терминал, ADR-0010 — дополнение «цена с биржи»)", () => {
  it("без пачки React: тики — в onTick, цена закрытой минуты — в onPrice; выбор источника и шапку решает терминал", () => {
    const ticks: LiveTick[] = [];
    const closes: [string, string][] = [];
    const h = { onTick: (t: LiveTick) => ticks.push(t), onPrice: (s: string, p: LivePrice) => closes.push([s, p.p]) };
    dispatchLive({ t: "tick", s: "BTCUSDT", p: "1", at: at(1) }, h, null);
    dispatchLive({ t: "ticks", at: at(2), p: { BTCUSDT: "2" } }, h, null);
    dispatchLive({ t: "price", s: "BTCUSDT", p: "3", at: at(3) }, h, null);
    expect(ticks.map((t) => t.p)).toEqual(["1", "2"]);
    expect(closes).toEqual([["BTCUSDT", "3"]]);
  });
});

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
  msg(m: LiveMsg | Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  finishClose() {
    this.readyState = 3;
    this.onclose?.();
  }
}

type FakeDoc = { visibilityState: DocumentVisibilityState; fire(): void; addEventListener(t: string, f: () => void): void; removeEventListener(t: string, f: () => void): void };
function fakeDoc(): FakeDoc {
  const fns = new Set<() => void>();
  return {
    visibilityState: "visible",
    fire: () => fns.forEach((f) => f()),
    addEventListener: (_t, f) => fns.add(f),
    removeEventListener: (_t, f) => fns.delete(f),
  };
}

type FakeWin = { fire(type: string, e?: object): void; addEventListener(t: string, f: (e: object) => void): void; removeEventListener(t: string, f: (e: object) => void): void };
function fakeWin(): FakeWin {
  const fns = new Map<string, Set<(e: object) => void>>();
  return {
    fire: (type, e = {}) => fns.get(type)?.forEach((f) => f(e)),
    addEventListener: (t, f) => {
      if (!fns.has(t)) fns.set(t, new Set());
      fns.get(t)!.add(f);
    },
    removeEventListener: (t, f) => fns.get(t)?.delete(f),
  };
}

function socket(log: string[], doc: FakeDoc | null = null, win: FakeWin | null = null) {
  const sock = new LiveSocket({
    url: async () => "ws://x/v1/ws",
    subscription: () => ({ sub: ["BTCUSDT"], batch: true, forming: true }),
    onMessage: (m) => log.push(`msg:${m.t}`),
    onConnected: (v) => log.push(`connected:${v}`),
    onOnline: (v) => log.push(`online:${v}`),
    onReconnect: () => log.push("reconnect"),
    onWake: () => log.push("wake"),
    WebSocketImpl: FakeWS as unknown as typeof WebSocket,
    doc: doc as unknown as Document,
    win: win as unknown as Window,
  });
  return sock;
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const tick = (ws: FakeWS, p = "1") => ws.msg({ t: "tick", s: "BTCUSDT", p, at: new Date().toISOString() });

describe("соединение /v1/ws (LiveSocket)", () => {
  afterEach(() => {
    FakeWS.all = [];
  });

  it("открытие: подписка с пачкой и минутами; «онлайн» по тику, без тиков — гаснет при открытом сокете", async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const sock = socket(log);
    sock.start();
    await flush();
    const a = FakeWS.all[0]!;
    a.open();
    expect(JSON.parse(a.sent[0]!)).toEqual({ sub: ["BTCUSDT"], batch: true, forming: true });
    tick(a);
    expect(log).toEqual(["connected:true", "online:true", "msg:tick"]);
    a.msg({ t: "pong" });
    await vi.advanceTimersByTimeAsync(ONLINE_MS + 1000);
    expect(log.at(-1)).toBe("online:false");
    expect(log).not.toContain("connected:false");
    sock.stop();
  });

  it("полуоткрытый сокет (телефон спал): тишина — пинг, без pong — новый сокет сразу, без onclose старого (W2)", async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const sock = socket(log);
    sock.start();
    await flush();
    const a = FakeWS.all[0]!;
    a.open();
    tick(a);
    await vi.advanceTimersByTimeAsync(SILENCE_MS + 1000);
    expect(a.sent.at(-1)).toBe('{"ping":1}');
    expect(FakeWS.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(PONG_TIMEOUT_MS + 1000);
    expect(FakeWS.all).toHaveLength(2);
    expect(a.closed).toBe(true);
    expect(a.onclose).toBeNull(); // старый сокет отцеплен: его поздний onclose ничего не тронет
    const b = FakeWS.all[1]!;
    b.open();
    tick(b);
    expect(log.slice(-4)).toEqual(["connected:true", "reconnect", "online:true", "msg:tick"]);
    a.finishClose();
    expect(log.at(-1)).toBe("msg:tick");
    sock.stop();
  });

  it("сервер отвечает на пинг — сокет живой, хоть тиков и нет: не переподключаемся", async () => {
    vi.useFakeTimers();
    const sock = socket([]);
    sock.start();
    await flush();
    const a = FakeWS.all[0]!;
    a.open();
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(SILENCE_MS + 1000);
      if (a.sent.at(-1) === '{"ping":1}') a.msg({ t: "pong" });
    }
    expect(FakeWS.all).toHaveLength(1);
    expect(a.sent.filter((m) => m === '{"ping":1}').length).toBeGreaterThan(2);
    sock.stop();
  });

  it("вкладка снова видна, а данных давно не было (таймеры телефона спали): переподключение сразу", async () => {
    vi.useFakeTimers();
    const doc = fakeDoc();
    const log: string[] = [];
    const sock = socket(log, doc);
    sock.start();
    await flush();
    const a = FakeWS.all[0]!;
    a.open();
    tick(a);
    doc.visibilityState = "hidden";
    vi.setSystemTime(Date.now() + 3 * 60_000); // интервалы не шли — как на заблокированном телефоне
    doc.visibilityState = "visible";
    doc.fire();
    await flush();
    expect(FakeWS.all).toHaveLength(2);
    FakeWS.all[1]!.open();
    expect(log).toContain("reconnect");
    // видна и данные свежие — ничего не делаем
    tick(FakeWS.all[1]!);
    doc.fire();
    await flush();
    expect(FakeWS.all).toHaveLength(2);
    sock.stop();
  });

  it("пока открывается сокет, сменивший прежний, — resyncPending (просрочка ждёт); не дольше RECONNECT_WAIT_MS, первое открытие — не в счёт", async () => {
    vi.useFakeTimers();
    const doc = fakeDoc();
    const sock = socket([], doc);
    sock.start();
    await flush();
    expect(sock.resyncPending).toBe(false); // первое открытие — onReconnect не будет
    const a = FakeWS.all[0]!;
    a.open();
    tick(a);
    vi.setSystemTime(Date.now() + 3 * 60_000);
    doc.fire();
    expect(sock.resyncPending).toBe(true);
    await flush();
    expect(sock.resyncPending).toBe(true);
    FakeWS.all[1]!.open();
    expect(sock.resyncPending).toBe(false);
    // рукопожатие висит (сети нет) — ждём не дольше RECONNECT_WAIT_MS
    vi.setSystemTime(Date.now() + 3 * 60_000);
    doc.fire();
    await flush();
    expect(sock.resyncPending).toBe(true);
    vi.setSystemTime(Date.now() + RECONNECT_WAIT_MS);
    expect(sock.resyncPending).toBe(false);
    // отказ в соединении — не ждём
    vi.setSystemTime(Date.now() - RECONNECT_WAIT_MS);
    expect(sock.resyncPending).toBe(true);
    FakeWS.all[2]!.finishClose();
    expect(sock.resyncPending).toBe(false);
    sock.stop();
  });

  it("смена токена: старое соединение остановлено, его поздний onclose не гасит «онлайн» нового (W4)", async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const first = socket(log);
    first.start();
    await flush();
    const a = FakeWS.all[0]!;
    a.open();
    tick(a);
    first.stop(); // эффект useLive перезапущен с новым токеном
    const second = socket(log);
    second.start();
    await flush();
    const b = FakeWS.all[1]!;
    b.open();
    tick(b);
    const mark = log.length;
    a.finishClose(); // медленное закрытие старого сокета в мобильной сети
    await vi.advanceTimersByTimeAsync(2000);
    expect(log.slice(mark).filter((e) => e.startsWith("online") || e.startsWith("connected"))).toEqual([]);
    expect(FakeWS.all).toHaveLength(2); // и не переподключался
    second.stop();
  });

  it("сокет закрыт сервером: переподключение через RETRY_MS…+JITTER, счётчик переподключений", async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const sock = socket(log);
    sock.start();
    await flush();
    FakeWS.all[0]!.open();
    FakeWS.all[0]!.finishClose();
    expect(log.slice(-1)).toEqual(["connected:false"]);
    await vi.advanceTimersByTimeAsync(RETRY_MS + RETRY_JITTER_MS + 10);
    expect(FakeWS.all).toHaveLength(2);
    FakeWS.all[1]!.open();
    expect(log.filter((e) => e === "reconnect")).toHaveLength(1);
    sock.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWS.all).toHaveLength(2);
  });

  it("пробуждение (вкладка видна, pageshow из кэша, online): сокет свеж — ничего; открыт, но молчит — новый сокет, затем один reconnect", async () => {
    vi.useFakeTimers();
    const doc = fakeDoc();
    const win = fakeWin();
    const log: string[] = [];
    const sock = socket(log, doc, win);
    sock.start();
    await flush();
    const a = FakeWS.all[0]!;
    a.open();
    tick(a);
    // свежий сокет: ни запроса истории, ни нового сокета
    doc.fire();
    win.fire("online");
    win.fire("pageshow", { persisted: true });
    await flush();
    expect(FakeWS.all).toHaveLength(1);
    expect(log).not.toContain("wake");
    // открыт, но молчит дольше ONLINE_MS (таймеры телефона спали): новый сокет; история — по его открытию
    vi.setSystemTime(Date.now() + ONLINE_MS + 1000);
    win.fire("pageshow", { persisted: false }); // не из кэша — не пробуждение
    await flush();
    expect(FakeWS.all).toHaveLength(1);
    win.fire("pageshow", { persisted: true });
    await flush();
    expect(FakeWS.all).toHaveLength(2);
    expect(log).not.toContain("wake");
    FakeWS.all[1]!.open();
    expect(log.filter((e) => e === "reconnect")).toHaveLength(1);
    sock.stop();
  });

  it("фон дольше BACKGROUND_MS — сокет закрывается без переподключения (план 2A.7); возврат — новый сокет и один догон по его открытию", async () => {
    vi.useFakeTimers();
    const doc = fakeDoc();
    const win = fakeWin();
    const log: string[] = [];
    const sock = socket(log, doc, win);
    sock.start();
    await flush();
    const a = FakeWS.all[0]!;
    a.open();
    tick(a);
    /** Время идёт, сервер шлёт тики раз в секунду. */
    const live = async (ms: number) => {
      for (let t = 0; t < ms; t += 1000) {
        if (!a.closed) tick(a);
        await vi.advanceTimersByTimeAsync(1000);
      }
    };
    const hide = (st: DocumentVisibilityState) => {
      doc.visibilityState = st;
      doc.fire();
    };
    // скрыта меньше BACKGROUND_MS — тот же сокет; таймер фона заново с каждым уходом в фон
    hide("hidden");
    await live(BACKGROUND_MS - 5000);
    hide("visible");
    hide("hidden");
    await live(BACKGROUND_MS - 2000);
    expect(a.closed).toBe(false);
    await live(3000);
    expect(a.closed).toBe(true);
    expect(log.slice(-2)).toEqual(["online:false", "connected:false"]);
    expect(sock.resyncPending).toBe(false);
    // в фоне не переподключаемся: ни по таймеру, ни по online
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    win.fire("online");
    await flush();
    expect(FakeWS.all).toHaveLength(1);
    // возврат: новый сокет сразу; история — один раз, по его открытию (как после полуоткрытого сокета)
    hide("visible");
    await flush();
    expect(FakeWS.all).toHaveLength(2);
    expect(sock.resyncPending).toBe(true);
    FakeWS.all[1]!.open();
    expect(log.filter((e) => e === "reconnect")).toHaveLength(1);
    expect(log).not.toContain("wake");
    sock.stop();
  });

  it("фон, а сокет ещё ни разу не открывался: возврат — история сразу (onWake), открытие нового — не повтор", async () => {
    vi.useFakeTimers();
    const doc = fakeDoc();
    const log: string[] = [];
    const sock = socket(log, doc);
    sock.start();
    await flush();
    doc.visibilityState = "hidden";
    doc.fire();
    await vi.advanceTimersByTimeAsync(BACKGROUND_MS + 1000);
    expect(FakeWS.all[0]!.closed).toBe(true);
    doc.visibilityState = "visible";
    doc.fire();
    await flush();
    expect(log).toContain("wake");
    expect(FakeWS.all).toHaveLength(2);
    FakeWS.all[1]!.open();
    expect(log).not.toContain("reconnect");
    sock.stop();
  });

  it("пробуждение при неоткрытом сокете: история сразу (onWake) и новый сокет; сокет уже подключается — только история", async () => {
    vi.useFakeTimers();
    const doc = fakeDoc();
    const win = fakeWin();
    const log: string[] = [];
    const sock = socket(log, doc, win);
    sock.start();
    await flush();
    const a = FakeWS.all[0]!;
    a.open();
    a.finishClose(); // сервер закрыл; переподключение — по таймеру через RETRY_MS…
    expect(log.at(-1)).toBe("connected:false");
    win.fire("online"); // сеть вернулась — не ждём таймер
    await flush();
    expect(log.filter((e) => e === "wake")).toHaveLength(1);
    expect(FakeWS.all).toHaveLength(2);
    // новый сокет ещё подключается: вкладка видна — история, но не третий сокет
    doc.fire();
    await flush();
    expect(log.filter((e) => e === "wake")).toHaveLength(2);
    expect(FakeWS.all).toHaveLength(2);
    FakeWS.all[1]!.open();
    expect(log.filter((e) => e === "reconnect")).toHaveLength(1);
    // таймер прежнего переподключения отменён: лишнего сокета нет
    await vi.advanceTimersByTimeAsync(RETRY_MS + RETRY_JITTER_MS + 10);
    expect(FakeWS.all).toHaveLength(2);
    sock.stop();
    // после остановки события ничего не делают
    win.fire("online");
    await flush();
    expect(FakeWS.all).toHaveLength(2);
  });
});
