/**
 * Живая цена прямо с биржи (ADR-0010, дополнение «цена с биржи»): браузер держит ОДНО публичное соединение с Binance
 * USDⓈ-M Futures (combined stream рыночных потоков `wss://fstream.binance.com/market/stream?streams=…`) на все
 * показанные инструменты — символ терминала и ячейки мультичарта. На символ — два потока:
 * - `<sym>@kline_1m` — идущая минута o/h/l/c/v раз в ~250 мс (x = false — формирующаяся, x = true — закрытая);
 * - `<sym>@aggTrade` — сделки (Binance сводит их за 100 мс), цена последней сделки — не чаще кадра анимации на символ.
 *   Kline сама по себе даёт цену раз в 250 мс; сделки дают её в момент сделки (задержка ≤ 100 мс вместо ≤ 250 мс) и
 *   двигают цену на графике плавно, как у TradingView. high/low сделок внутри одного кадра приходят следующей kline.
 *
 * Подписка меняется сообщениями SUBSCRIBE / UNSUBSCRIBE в том же соединении (без переподключения): изменения за
 * BATCH_MS сводятся в одно сообщение на вид, управляющие сообщения — не чаще раза в CONTROL_GAP_MS (лимит Binance — 10
 * входящих сообщений в секунду на соединение). Ping/pong протокола отвечает сам браузер.
 *
 * Свежесть — по символу: данные символа за последние FRESH_MS — биржа основной источник (fresh(true)); иначе — сервер
 * (fresh(false)). Соединение следит за собой: нет данных за FIRST_DATA_MS после открытия — биржа их не даёт;
 * тишина дольше SILENCE_MS — проверочный LIST_SUBSCRIPTIONS, без ответа PROBE_TIMEOUT_MS — соединение мёртво (полуоткрыто);
 * ответы есть, а данных нет дольше NO_DATA_MS — тоже отказ. Ошибка, закрытие (геоблок 451, обрыв), мёртвое или пустое
 * соединение — все символы сразу несвежие и новая попытка через RETRY_MIN_MS…RETRY_MAX_MS (пауза удваивается, первые
 * данные её сбрасывают). Binance закрывает соединение через 24 ч — за час до этого открывается новое с теми же потоками,
 * старое закрывается, когда новое принесло данные (без паузы в ценах).
 *
 * Модуль только для браузера: экземпляр на страницу — binanceFeed() (на сервере null). В движок, на сервер и в БД ничего
 * не уходит.
 */
import type { LiveCandle, LiveTick } from "./useLive";

/**
 * Combined stream рыночных потоков USDⓈ-M Futures (kline, aggTrade, markPrice — категория «market»); потоки — в
 * параметре streams при подключении, дальше — SUBSCRIBE/UNSUBSCRIBE. Старый адрес `wss://fstream.binance.com/stream`
 * с переносом потоков Binance отдаёт только «public» (bookTicker, depth): соединение открывается и отвечает на
 * управляющие сообщения, но kline и сделок не шлёт.
 */
export const BINANCE_WS = "wss://fstream.binance.com/market/stream";
/** Данные символа не старше — биржа основной источник цены и свечи. */
export const FRESH_MS = 5000;
/** Новое соединение без данных дольше — биржа не даёт данных: отказ и пауза (первые данные приходят за доли секунды). */
export const FIRST_DATA_MS = 3000;
/** Соединение отвечает, но данных нет дольше — отказ и пауза (символы на экране торгуются каждую секунду). */
export const NO_DATA_MS = 15_000;
/** Открытое соединение молчит дольше — проверка LIST_SUBSCRIPTIONS. */
export const SILENCE_MS = 5000;
/** Проверка без ответа дольше — соединение мёртво (полуоткрыто после сна телефона, сеть сменилась). */
export const PROBE_TIMEOUT_MS = 3000;
/** Рукопожатие дольше — соединение не состоялось. */
export const CONNECT_TIMEOUT_MS = 10_000;
/** Пауза перед новой попыткой: от RETRY_MIN_MS, удваивается до RETRY_MAX_MS; плюс случайное до RETRY_JITTER_MS. */
export const RETRY_MIN_MS = 5000;
export const RETRY_MAX_MS = 60_000;
export const RETRY_JITTER_MS = 1000;
/** Соединение старше — заменить новым (Binance закрывает через 24 ч). */
export const ROTATE_MS = 23 * 3600_000;
/** Новое соединение замены не принесло данных — следующая попытка замены через. */
export const ROTATE_RETRY_MS = 60_000;
/** Управляющие сообщения — не чаще (≤ 6,7 в секунду при лимите 10). */
export const CONTROL_GAP_MS = 150;
/** Изменения подписки за это время — одно SUBSCRIBE и одно UNSUBSCRIBE (смена символа, ячейки мультичарта). */
export const BATCH_MS = 20;
/** Символов не осталось (ушли со страницы графика) — соединение закрывается через. */
export const LINGER_MS = 15_000;

/** Слушатель символа: события бирже в формате сообщений сервера (LiveTick, LiveCandle) и смена свежести. */
export type BinanceListener = {
  /** Цена последней сделки (aggTrade), не чаще кадра анимации. */
  tick?: (t: LiveTick) => void;
  /** Формирующаяся минута (kline x = false); `at` — время события биржи. */
  forming?: (c: LiveCandle) => void;
  /** Закрытая минута (kline x = true). */
  candle?: (c: LiveCandle) => void;
  /** Биржа — основной источник символа (данные не старше FRESH_MS) или нет. Сразу при подписке — текущее. */
  fresh?: (on: boolean) => void;
};

type KlineMsg = { e: "kline"; E: number; s: string; k: { t: number; o: string; h: string; l: string; c: string; v: string; x: boolean } };
type AggTradeMsg = { e: "aggTrade"; E: number; s: string; p: string; T: number };

const iso = (ms: number) => new Date(ms).toISOString();
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v !== "" && Number.isFinite(Number(v));

/** Потоки символа: формирующаяся минута и сделки (имена потоков Binance — строчными). */
export function streamsOf(symbol: string): string[] {
  const s = symbol.toLowerCase();
  return [`${s}@kline_1m`, `${s}@aggTrade`];
}

/** Адрес combined stream с потоками. */
export function streamUrl(base: string, streams: readonly string[]): string {
  return `${base}?streams=${streams.join("/")}`;
}

/** kline 1m → минута в формате сервера; не kline 1m или битые поля — null. */
export function parseKline(d: unknown): { closed: boolean; c: LiveCandle } | null {
  const m = d as KlineMsg;
  const k = m?.k;
  if (m?.e !== "kline" || typeof m.s !== "string" || !k || !isNum(k.t) || ![k.o, k.h, k.l, k.c, k.v].every(isStr)) return null;
  const at = isNum(m.E) ? iso(m.E) : undefined;
  return { closed: k.x === true, c: { s: m.s, tf: "1m", c: { t: Math.floor(k.t / 1000), o: k.o, h: k.h, l: k.l, c: k.c, v: k.v, ...(at ? { at } : {}) } } };
}

/** aggTrade → тик в формате сервера (время — время сделки); битые поля — null. */
export function parseAggTrade(d: unknown): LiveTick | null {
  const m = d as AggTradeMsg;
  if (m?.e !== "aggTrade" || typeof m.s !== "string" || !isStr(m.p) || !isNum(m.T)) return null;
  return { s: m.s, p: m.p, at: iso(m.T) };
}

type Visibility = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
type Events = Pick<Window, "addEventListener" | "removeEventListener">;
type Timer = ReturnType<typeof setTimeout>;

export type BinanceFeedOptions = {
  url?: string;
  WebSocketImpl?: typeof WebSocket;
  /** Кадр анимации (requestAnimationFrame; без него — 16 мс). */
  raf?: (fn: () => void) => void;
  random?: () => number;
  doc?: Visibility | null;
  win?: Events | null;
};

export class BinanceFeed {
  private readonly listeners = new Map<string, Set<BinanceListener>>();
  private ws: WebSocket | null = null;
  /** Соединение на замену старому (24 ч): основным становится с первыми данными. */
  private next: WebSocket | null = null;
  private nextAt = 0;
  /** Потоки, которые есть у соединения: из адреса и отправленных SUBSCRIBE/UNSUBSCRIBE. */
  private active = new Set<string>();
  /** null — рукопожатие идёт. */
  private openedAt: number | null = null;
  private dialAt = 0;
  private bornAt = 0;
  private lastMsg = 0;
  /** Последние рыночные данные соединения (любой символ); при SUBSCRIBE — отсчёт заново. */
  private lastDataAt = 0;
  private gotData = false;
  private probeAt: number | null = null;
  private backoff = RETRY_MIN_MS;
  private retry: Timer | null = null;
  private watch: ReturnType<typeof setInterval> | null = null;
  private batch: Timer | null = null;
  private linger: Timer | null = null;
  private readonly control: string[] = [];
  private controlTimer: Timer | null = null;
  private lastControl = -Infinity;
  private id = 0;
  private readonly lastData = new Map<string, number>();
  private readonly fresh = new Map<string, boolean>();
  private readonly trades = new Map<string, LiveTick>();
  private framePending = false;
  private readonly url: string;
  private readonly WS: typeof WebSocket;
  private readonly raf: (fn: () => void) => void;
  private readonly random: () => number;
  private readonly doc: Visibility | null;
  private readonly win: Events | null;

  constructor(opts: BinanceFeedOptions = {}) {
    this.url = opts.url ?? BINANCE_WS;
    this.WS = opts.WebSocketImpl ?? WebSocket;
    this.raf = opts.raf ?? (typeof requestAnimationFrame === "function" ? (fn) => void requestAnimationFrame(fn) : (fn) => void setTimeout(fn, 16));
    this.random = opts.random ?? Math.random;
    this.doc = opts.doc === undefined ? (typeof document === "undefined" ? null : document) : opts.doc;
    this.win = opts.win === undefined ? (typeof window === "undefined" ? null : window) : opts.win;
    this.doc?.addEventListener("visibilitychange", this.onVisibility);
    this.win?.addEventListener("pageshow", this.onPageShow as EventListener);
    this.win?.addEventListener("online", this.onOnline);
  }

  /** Слушать символ; отписка — возвращаемой функцией. Свежесть отдаётся сразу (fresh). */
  subscribe(symbol: string, l: BinanceListener): () => void {
    const sym = symbol.toUpperCase();
    let set = this.listeners.get(sym);
    if (!set) this.listeners.set(sym, (set = new Set()));
    set.add(l);
    this.changed();
    l.fresh?.(this.isFresh(sym));
    let done = false;
    return () => {
      if (done) return;
      done = true;
      set.delete(l);
      if (!set.size && this.listeners.get(sym) === set) this.listeners.delete(sym);
      this.changed();
    };
  }

  /** Биржа — основной источник символа: соединение есть и данные символа не старше FRESH_MS. */
  isFresh(symbol: string): boolean {
    const t = this.lastData.get(symbol.toUpperCase());
    return this.ws !== null && t !== undefined && Date.now() - t < FRESH_MS;
  }

  /** Состояние для отладки и тестов. */
  get connected(): boolean {
    return this.ws !== null && this.openedAt !== null;
  }

  get streams(): string[] {
    return [...this.active];
  }

  /** Остановить всё (тесты, смена страницы не требует: соединение закроется само через LINGER_MS). */
  dispose(): void {
    this.listeners.clear();
    for (const t of [this.retry, this.batch, this.linger, this.controlTimer]) if (t) clearTimeout(t);
    this.retry = this.batch = this.linger = this.controlTimer = null;
    if (this.watch) clearInterval(this.watch);
    this.watch = null;
    this.doc?.removeEventListener("visibilitychange", this.onVisibility);
    this.win?.removeEventListener("pageshow", this.onPageShow as EventListener);
    this.win?.removeEventListener("online", this.onOnline);
    this.drop(this.next);
    this.next = null;
    this.drop(this.ws);
    this.ws = null;
    this.active.clear();
  }

  /** Вкладка снова видна, страница из кэша, сеть вернулась: соединение открыто, но молчит — новое сразу (без паузы). */
  wake(): void {
    const ws = this.ws;
    if (!ws || this.openedAt === null || !this.wanted().size) return;
    if (Date.now() - this.lastMsg > SILENCE_MS) this.fail(true);
  }

  private wanted(): Set<string> {
    const out = new Set<string>();
    for (const sym of this.listeners.keys()) for (const s of streamsOf(sym)) out.add(s);
    return out;
  }

  /** Набор символов изменился: одно сообщение на все изменения за BATCH_MS. */
  private changed(): void {
    this.ensureWatch();
    if (this.listeners.size && this.linger) {
      clearTimeout(this.linger);
      this.linger = null;
    }
    if (!this.batch) this.batch = setTimeout(() => this.flush(), BATCH_MS);
  }

  private flush(): void {
    this.batch = null;
    const want = this.wanted();
    // символы без слушателей: свежесть и сделки больше не нужны
    for (const sym of new Set([...this.lastData.keys(), ...this.fresh.keys()])) if (!this.listeners.has(sym)) this.forget(sym);
    if (!want.size) {
      if (this.retry) clearTimeout(this.retry);
      this.retry = null;
      if (this.ws && !this.linger) this.linger = setTimeout(() => this.idle(), LINGER_MS);
    }
    if (!this.ws) {
      if (want.size && !this.retry) this.connect();
      return;
    }
    // замену при смене подписки — заново, с новыми потоками
    if (this.next) {
      this.drop(this.next);
      this.next = null;
    }
    if (this.openedAt === null) return; // откроется — сверим потоки
    const del = [...this.active].filter((s) => !want.has(s));
    const add = [...want].filter((s) => !this.active.has(s));
    if (del.length) this.send("UNSUBSCRIBE", del);
    if (add.length) {
      this.send("SUBSCRIBE", add);
      this.lastDataAt = Math.max(this.lastDataAt, Date.now());
    }
    for (const s of del) this.active.delete(s);
    for (const s of add) this.active.add(s);
  }

  private forget(sym: string): void {
    this.lastData.delete(sym);
    this.fresh.delete(sym);
    this.trades.delete(sym);
  }

  /** Символов нет LINGER_MS — соединение закрыть, без новой попытки. */
  private idle(): void {
    this.linger = null;
    if (this.listeners.size) return;
    this.drop(this.next);
    this.next = null;
    this.drop(this.ws);
    this.ws = null;
    this.active.clear();
    this.control.length = 0;
    if (this.watch) clearInterval(this.watch);
    this.watch = null;
  }

  private ensureWatch(): void {
    this.watch ??= setInterval(() => this.check(), 1000);
  }

  private open(streams: readonly string[]): WebSocket {
    return new this.WS(streamUrl(this.url, streams));
  }

  private connect(): void {
    const streams = [...this.wanted()];
    if (!streams.length) return;
    const ws = this.open(streams);
    const now = Date.now();
    this.ws = ws;
    this.active = new Set(streams);
    this.openedAt = null;
    this.dialAt = now;
    this.lastMsg = now;
    this.gotData = false;
    this.probeAt = null;
    this.control.length = 0;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      const t = Date.now();
      this.openedAt = t;
      this.bornAt = t;
      this.lastMsg = t;
      this.flush(); // подписка менялась, пока шло рукопожатие
    };
    ws.onmessage = (ev) => this.onMessage(ws, ev.data);
    // геоблок (HTTP 451), обрыв, закрытие биржей — error и/или close: пауза и новая попытка
    ws.onerror = ws.onclose = () => {
      if (this.ws === ws) this.fail(false);
    };
  }

  /** Соединение потеряно: все символы — с сервера сразу; новое — сразу (now) или после паузы. */
  private fail(now: boolean): void {
    this.drop(this.ws);
    this.ws = null;
    this.drop(this.next);
    this.next = null;
    this.active.clear();
    this.control.length = 0;
    this.openedAt = null;
    this.probeAt = null;
    for (const sym of [...this.fresh.keys()]) this.setFresh(sym, false);
    this.lastData.clear();
    this.trades.clear();
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    if (!this.wanted().size) return;
    if (now) {
      this.connect();
      return;
    }
    const wait = this.backoff + this.random() * RETRY_JITTER_MS;
    this.backoff = Math.min(this.backoff * 2, RETRY_MAX_MS);
    this.retry = setTimeout(() => {
      this.retry = null;
      if (!this.ws) this.connect();
    }, wait);
  }

  /** Отцепить сокет: его события больше ничего не меняют. */
  private drop(ws: WebSocket | null): void {
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close();
    } catch {
      // уже закрыт
    }
  }

  private send(method: "SUBSCRIBE" | "UNSUBSCRIBE" | "LIST_SUBSCRIPTIONS", params?: string[]): void {
    this.control.push(JSON.stringify(params ? { method, params, id: ++this.id } : { method, id: ++this.id }));
    this.pump();
  }

  /** Очередь управляющих сообщений: не чаще CONTROL_GAP_MS. */
  private pump(): void {
    if (this.controlTimer || !this.control.length) return;
    const wait = this.lastControl + CONTROL_GAP_MS - Date.now();
    if (wait > 0) {
      this.controlTimer = setTimeout(() => {
        this.controlTimer = null;
        this.pump();
      }, wait);
      return;
    }
    const ws = this.ws;
    const msg = this.control.shift()!;
    if (!ws || this.openedAt === null) {
      this.control.length = 0;
      return;
    }
    this.lastControl = Date.now();
    try {
      ws.send(msg);
    } catch {
      // закрывается — новое соединение возьмёт потоки из адреса
    }
    this.pump();
  }

  private onMessage(ws: WebSocket, raw: unknown): void {
    let m: { stream?: string; data?: { e?: string; s?: string }; id?: number };
    try {
      m = JSON.parse(String(raw)) as typeof m;
    } catch {
      return;
    }
    const data = m && typeof m.stream === "string" && m.data && typeof m.data === "object" ? m.data : null;
    if (ws === this.next) {
      if (!data) return;
      this.promote(ws);
    } else if (ws !== this.ws) return;
    const now = Date.now();
    this.lastMsg = now;
    this.probeAt = null;
    if (!data) return; // ответ на SUBSCRIBE / UNSUBSCRIBE / проверку
    this.lastDataAt = now;
    if (!this.gotData) {
      this.gotData = true;
      this.backoff = RETRY_MIN_MS;
    }
    const sym = data.s;
    if (typeof sym !== "string" || !this.listeners.has(sym)) return;
    this.lastData.set(sym, now);
    this.setFresh(sym, true);
    if (data.e === "kline") {
      const k = parseKline(data);
      if (!k) return;
      for (const l of this.listeners.get(sym) ?? []) (k.closed ? l.candle : l.forming)?.(k.c);
    } else if (data.e === "aggTrade") {
      const t = parseAggTrade(data);
      if (!t) return;
      const prev = this.trades.get(sym);
      if (prev && Date.parse(prev.at) > Date.parse(t.at)) return;
      this.trades.set(sym, t);
      if (!this.framePending) {
        this.framePending = true;
        this.raf(() => this.frame());
      }
    }
  }

  /** Кадр анимации: последняя сделка каждого символа — тиком. */
  private frame(): void {
    this.framePending = false;
    const batch = [...this.trades.values()];
    this.trades.clear();
    for (const t of batch) for (const l of this.listeners.get(t.s) ?? []) l.tick?.(t);
  }

  /** Замена принесла данные: она — основное соединение, старое закрыто. */
  private promote(ws: WebSocket): void {
    const old = this.ws;
    const now = Date.now();
    this.ws = ws;
    this.next = null;
    this.openedAt = now;
    this.bornAt = now;
    this.gotData = true;
    this.control.length = 0;
    ws.onclose = ws.onerror = () => {
      if (this.ws === ws) this.fail(false);
    };
    this.drop(old);
  }

  /** Замена соединения до 24 ч: новое с теми же потоками; основным станет с первыми данными. */
  private rotate(): void {
    const streams = [...this.active];
    const n = this.open(streams);
    this.next = n;
    this.nextAt = Date.now();
    n.onmessage = (ev) => this.onMessage(n, ev.data);
    n.onerror = n.onclose = () => {
      if (this.next !== n) return;
      this.drop(n);
      this.next = null;
      this.bornAt = Date.now() - ROTATE_MS + ROTATE_RETRY_MS;
    };
  }

  private setFresh(sym: string, on: boolean): void {
    if ((this.fresh.get(sym) ?? false) === on) return;
    this.fresh.set(sym, on);
    for (const l of this.listeners.get(sym) ?? []) l.fresh?.(on);
  }

  /** Раз в секунду: свежесть символов, рукопожатие, тишина и проверка, замена до 24 ч. */
  private check(): void {
    const now = Date.now();
    for (const [sym, on] of this.fresh) if (on && now - (this.lastData.get(sym) ?? -Infinity) >= FRESH_MS) this.setFresh(sym, false);
    const ws = this.ws;
    if (!ws) return;
    if (this.openedAt === null) {
      if (now - this.dialAt > CONNECT_TIMEOUT_MS) this.fail(false);
      return;
    }
    if (!this.active.size) return;
    // открылось, но данных нет: биржа их не даёт (геоблок без отказа в соединении) — пауза и новая попытка
    if (!this.gotData) {
      if (now - this.openedAt > FIRST_DATA_MS) this.fail(false);
      return;
    }
    if (now - this.lastDataAt > NO_DATA_MS) {
      this.fail(false);
      return;
    }
    if (this.probeAt !== null) {
      if (now - this.probeAt > PROBE_TIMEOUT_MS) this.fail(false);
      return;
    }
    if (now - this.lastMsg > SILENCE_MS) {
      this.probeAt = now;
      this.send("LIST_SUBSCRIPTIONS");
      return;
    }
    if (this.next) {
      if (now - this.nextAt > CONNECT_TIMEOUT_MS) {
        this.drop(this.next);
        this.next = null;
        this.bornAt = now - ROTATE_MS + ROTATE_RETRY_MS;
      }
    } else if (now - this.bornAt > ROTATE_MS && !this.batch) this.rotate();
  }

  private readonly onVisibility = (): void => {
    if (this.doc?.visibilityState === "visible") this.wake();
  };

  private readonly onPageShow = (e: PageTransitionEvent): void => {
    if (e.persisted) this.wake();
  };

  private readonly onOnline = (): void => this.wake();
}

let shared: BinanceFeed | null = null;

/** Соединение с биржей на страницу (общее для терминала и ячеек мультичарта); на сервере — null. */
export function binanceFeed(): BinanceFeed | null {
  if (typeof window === "undefined" || typeof WebSocket === "undefined") return null;
  return (shared ??= new BinanceFeed());
}
