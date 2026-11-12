/**
 * Живая цена прямо с биржи (ADR-0010, дополнение «цена с биржи»): браузер держит ОДНО публичное соединение с Binance
 * USDⓈ-M Futures (combined stream рыночных потоков `wss://fstream.binance.com/market/stream?streams=…`) на все
 * показанные инструменты — символ терминала и ячейки мультичарта. На символ — два потока:
 * - `<sym>@kline_1m` — идущая минута o/h/l/c/v (x = false — формирующаяся, x = true — закрытая);
 * - `<sym>@aggTrade` — сделки (Binance сводит их за 100 мс), цена последней сделки — не чаще кадра анимации на символ.
 * Оба потока Binance шлёт только по сделкам: kline — не чаще раза в 250 мс, когда сделки были; нет сделок — нет сообщений
 * (цена не менялась). Сделки дают цену в момент сделки (задержка ≤ 100 мс вместо ≤ 250 мс) и двигают цену на графике
 * плавно, как у TradingView; high/low сделок внутри одного кадра приходят следующей kline.
 *
 * Подписка меняется сообщениями SUBSCRIBE / UNSUBSCRIBE в том же соединении (без переподключения): управляющие
 * сообщения — не чаще раза в CONTROL_GAP_MS (лимит Binance — 10 входящих сообщений в секунду на соединение), и каждое
 * считается в момент отправки — разница между нужными потоками и отправленными: при быстрой смене символов очередь не
 * растёт (не больше одного SUBSCRIBE и одного UNSUBSCRIBE), промежуточные символы взаимно сокращаются. Ping/pong протокола
 * отвечает сам браузер.
 *
 * Живость — у соединения, а не у символа: рукопожатие, ошибки и закрытие, а в тишине (ни данных, ни ответов SILENCE_MS) —
 * проверочный LIST_SUBSCRIPTIONS: ответ — соединение живо, без ответа PROBE_TIMEOUT_MS — мёртво (полуоткрыто). Тишина
 * символа отказом не считается: у тихого фьючерса сделок может не быть десятки секунд.
 *
 * Свежесть символа (биржа — основной источник, fresh(true)): соединение живо и после подписки по символу пришли данные —
 * до этого цена с сервера (снимка при подписке Binance не шлёт). Символ остаётся свежим без сделок, пока живо соединение;
 * исключение — улика сервера (server): его тик новее последних данных биржи по символу больше чем на BEHIND_MS и с другой
 * ценой — рынок идёт, а биржа его не приносит: символ с сервера, пока данные биржи не догонят улику.
 *
 * Отказ (ошибка рукопожатия — в том числе геоблок 451, обрыв, закрытие биржей, мёртвое соединение) — все символы сразу
 * несвежие и новая попытка через 5, 10, 20, 40, 60 с (плюс случайное до RETRY_JITTER_MS); BLOCKED_AFTER попыток подряд
 * без ответа биржи — биржа, похоже, закрыта для пользователя: дальше попытка раз в COOL_MS. Пауза хранится в
 * sessionStorage и переживает и уход со страницы графика, и перезагрузку вкладки. Любое сообщение биржи сбрасывает паузу.
 * Вкладка снова видна, страница из кэша, сеть вернулась (online) — попытка сразу, не дожидаясь паузы (кроме долгой паузы
 * COOL_MS: её прерывает только online); вкладка скрыта — без попыток до возврата, закрытие в скрытой вкладке — не отказ;
 * скрыта дольше BACKGROUND_MS — соединение закрывается само (план 2A.7, «фон — отключение сокета через 30 с»), тоже не
 * отказ: новое — при возврате.
 * Таймеры спали (тишина дольше SLEPT_MS без проверки, проверка просрочена намного) — открытое соединение заменяется сразу,
 * в каком бы порядке ни пришли таймер проверки и visibilitychange (Chrome размораживает страницу скрытой: просроченный
 * таймер срабатывает раньше возврата вкладки).
 * Binance закрывает соединение через 24 ч — за час до этого открывается новое с теми же потоками, старое закрывается,
 * когда новое ответило (без паузы в ценах).
 *
 * Модуль только для браузера: экземпляр на страницу — binanceFeed() (на сервере null). В движок, на сервер и в БД ничего
 * не уходит.
 */
import { BACKGROUND_MS, type LiveCandle, type LiveTick } from "./useLive";

/**
 * Combined stream рыночных потоков USDⓈ-M Futures (kline, aggTrade, markPrice — категория «market»). Старый адрес
 * `wss://fstream.binance.com/stream` с переносом потоков Binance отдаёт только «public» (bookTicker, depth): соединение
 * открывается и отвечает на управляющие сообщения, но kline и сделок не шлёт.
 */
export const BINANCE_WS = "wss://fstream.binance.com/market/stream";
/** Тик сервера новее последних данных биржи по символу больше чем на это и с другой ценой — биржа отстала. */
export const BEHIND_MS = 3000;
/** Отставшая биржа снова основная, когда её событие не старше улики сервера больше чем на это (шаг опроса сервера). */
export const CATCH_UP_MS = 1000;
/** Соединение молчит дольше (ни данных, ни ответов) — проверка LIST_SUBSCRIPTIONS. */
export const SILENCE_MS = 2000;
/** Проверка без ответа дольше — соединение мёртво (полуоткрыто после сна телефона, сеть сменилась). */
export const PROBE_TIMEOUT_MS = 3000;
/** Рукопожатие дольше — соединение не состоялось. */
export const CONNECT_TIMEOUT_MS = 10_000;
/** Пауза перед новой попыткой: от RETRY_MIN_MS, удваивается до RETRY_MAX_MS; плюс случайное до RETRY_JITTER_MS. */
export const RETRY_MIN_MS = 5000;
export const RETRY_MAX_MS = 60_000;
export const RETRY_JITTER_MS = 1000;
/** Неудачных попыток подряд без единого ответа биржи — дальше пауза COOL_MS (геоблок: ошибка в консоли не чаще). */
export const BLOCKED_AFTER = 6;
export const COOL_MS = 10 * 60_000;
/** Отказ доставлен за столько до возврата вкладки — сон телефона, а не отказ биржи: пауза не растёт. */
export const WAKE_GRACE_MS = 1000;
/** Соединение старше — заменить новым (Binance закрывает через 24 ч). */
export const ROTATE_MS = 23 * 3600_000;
/** Новое соединение замены не ответило — следующая попытка замены через. */
export const ROTATE_RETRY_MS = 60_000;
/** Управляющие сообщения — не чаще (≤ 6,7 в секунду при лимите 10). */
export const CONTROL_GAP_MS = 150;
/** Изменения подписки за это время — одним проходом (смена символа, ячейки мультичарта). */
export const BATCH_MS = 20;
/** Символов не осталось (ушли со страницы графика) — соединение закрывается через. */
export const LINGER_MS = 15_000;
/** Проверка соединения (рукопожатие, тишина, замена) — раз в. */
export const WATCH_MS = 1000;
/**
 * Соединение молчит дольше, а проверки не было (или она просрочена намного) — таймеры спали (сон телефона, ноутбука,
 * заморозка вкладки): живое за это время ответило бы на проверку, поэтому новое — сразу, без проверки и без паузы.
 */
export const SLEPT_MS = SILENCE_MS + PROBE_TIMEOUT_MS + WATCH_MS;
/** Ключ sessionStorage: отказы подряд и время следующей попытки. */
export const RETRY_KEY = "binanceFeed.retry";

/** Слушатель символа: события бирже в формате сообщений сервера (LiveTick, LiveCandle) и смена свежести. */
export type BinanceListener = {
  /** Цена последней сделки (aggTrade), не чаще кадра анимации. */
  tick?: (t: LiveTick) => void;
  /** Формирующаяся минута (kline x = false); `at` — время события биржи. */
  forming?: (c: LiveCandle) => void;
  /** Закрытая минута (kline x = true). */
  candle?: (c: LiveCandle) => void;
  /** Биржа — основной источник символа или нет. Сразу при подписке — текущее. */
  fresh?: (on: boolean) => void;
};

type KlineMsg = { e: "kline"; E: number; s: string; k: { t: number; o: string; h: string; l: string; c: string; v: string; x: boolean } };
type AggTradeMsg = { e: "aggTrade"; E: number; s: string; p: string; T: number };
type Control = { method: "SUBSCRIBE" | "UNSUBSCRIBE" | "LIST_SUBSCRIPTIONS"; params?: string[] };

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

/** Пауза перед попыткой после `fails` отказов подряд (без случайной добавки). */
export function retryWait(fails: number): number {
  if (fails >= BLOCKED_AFTER) return COOL_MS;
  return Math.min(RETRY_MIN_MS * 2 ** Math.max(0, fails - 1), RETRY_MAX_MS);
}

type Visibility = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
type Events = Pick<Window, "addEventListener" | "removeEventListener">;
type Store = Pick<Storage, "getItem" | "setItem">;
type Timer = ReturnType<typeof setTimeout>;

export type BinanceFeedOptions = {
  url?: string;
  WebSocketImpl?: typeof WebSocket;
  /** Кадр анимации (requestAnimationFrame; без него — 16 мс). */
  raf?: (fn: () => void) => void;
  random?: () => number;
  doc?: Visibility | null;
  win?: Events | null;
  /** Где пауза переживает перезагрузку (sessionStorage; null — нигде). */
  store?: Store | null;
};

function sessionStore(): Store | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null; // хранилище запрещено (приватный режим, политика сайта)
  }
}

export class BinanceFeed {
  private readonly listeners = new Map<string, Set<BinanceListener>>();
  private ws: WebSocket | null = null;
  /** Соединение на замену старому (24 ч): основным становится с первым ответом. */
  private next: WebSocket | null = null;
  private nextStreams: string[] = [];
  private nextAt = 0;
  /** Потоки, которые есть у соединения: из адреса и отправленных SUBSCRIBE/UNSUBSCRIBE. */
  private active = new Set<string>();
  /** null — рукопожатие идёт. */
  private openedAt: number | null = null;
  private dialAt = 0;
  private bornAt = 0;
  /** Последнее сообщение соединения (данные или ответ). */
  private lastMsg = 0;
  /** Соединение ответило хоть раз: биржа доступна. */
  private gotMsg = false;
  /** Проверка LIST_SUBSCRIPTIONS ждёт отправки (очередь управляющих сообщений). */
  private probeWanted = false;
  /** Проверка отправлена, ответа ещё нет. */
  private probeAt: number | null = null;
  /** Отказов подряд без единого ответа биржи; время последнего и следующей попытки — для паузы. */
  private fails = 0;
  private failedAt = -Infinity;
  private retryAt = 0;
  private retry: Timer | null = null;
  private watch: ReturnType<typeof setInterval> | null = null;
  private batch: Timer | null = null;
  private linger: Timer | null = null;
  /** Таймер фона: вкладка скрыта BACKGROUND_MS — соединение закрыть (sleep). */
  private background: Timer | null = null;
  private controlTimer: Timer | null = null;
  private lastControl = -Infinity;
  private id = 0;
  /** Последняя цена биржи по символу и время её события (мс) на этом соединении; есть — символ получил данные. */
  private readonly lastPrice = new Map<string, { p: number; at: number }>();
  /** Улика сервера: биржа отстала по символу; время тика сервера (мс). */
  private readonly behind = new Map<string, number>();
  private readonly fresh = new Map<string, boolean>();
  private readonly trades = new Map<string, LiveTick>();
  private framePending = false;
  private readonly url: string;
  private readonly WS: typeof WebSocket;
  private readonly raf: (fn: () => void) => void;
  private readonly random: () => number;
  private readonly doc: Visibility | null;
  private readonly win: Events | null;
  private readonly store: Store | null;

  constructor(opts: BinanceFeedOptions = {}) {
    this.url = opts.url ?? BINANCE_WS;
    this.WS = opts.WebSocketImpl ?? WebSocket;
    this.raf = opts.raf ?? (typeof requestAnimationFrame === "function" ? (fn) => void requestAnimationFrame(fn) : (fn) => void setTimeout(fn, 16));
    this.random = opts.random ?? Math.random;
    this.doc = opts.doc === undefined ? (typeof document === "undefined" ? null : document) : opts.doc;
    this.win = opts.win === undefined ? (typeof window === "undefined" ? null : window) : opts.win;
    this.store = opts.store === undefined ? sessionStore() : opts.store;
    this.load();
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

  /** Биржа — основной источник символа: соединение открыто, данные символа были, улики отставания нет. */
  isFresh(symbol: string): boolean {
    const sym = symbol.toUpperCase();
    return this.ws !== null && this.openedAt !== null && this.lastPrice.has(sym) && !this.behind.has(sym);
  }

  /**
   * Тик сервера по символу (приходит и пока биржа свежа): цена другая и новее последних данных биржи больше чем на
   * BEHIND_MS — сделки были, а биржа их не принесла: символ с сервера сразу, пока данные биржи не догонят тик. Тихий
   * рынок (та же цена) уликой не считается; сервер отстаёт на 1–2 с, поэтому его обычные тики старше данных биржи.
   */
  server(t: LiveTick): void {
    const sym = t.s.toUpperCase();
    if (!this.isFresh(sym)) return;
    const last = this.lastPrice.get(sym)!;
    const at = Date.parse(t.at);
    const p = Number(t.p);
    if (!Number.isFinite(at) || !Number.isFinite(p) || at - last.at <= BEHIND_MS || p === last.p) return;
    this.behind.set(sym, at);
    this.setFresh(sym, false);
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
    for (const t of [this.retry, this.batch, this.linger, this.background]) if (t) clearTimeout(t);
    this.retry = this.batch = this.linger = this.background = null;
    this.stopWatch();
    this.doc?.removeEventListener("visibilitychange", this.onVisibility);
    this.win?.removeEventListener("pageshow", this.onPageShow as EventListener);
    this.win?.removeEventListener("online", this.onOnline);
    this.drop(this.next);
    this.next = null;
    this.drop(this.ws);
    this.ws = null;
    this.active.clear();
  }

  /**
   * Вкладка снова видна, страница из кэша, сеть вернулась (online):
   * - соединения нет (пауза после отказа или вкладка была скрыта) — попытка сразу; долгую паузу COOL_MS (биржа закрыта
   *   для пользователя) прерывает только online. Отказ за WAKE_GRACE_MS до этого (телефон закрыл сокет во сне) — не отказ;
   * - соединение открыто, но молчит дольше SLEPT_MS (таймеры спали) — новое сразу, даже если проверку уже отправил
   *   таймер, сработавший при пробуждении раньше visibilitychange; молчит дольше SILENCE_MS — проверка (если её нет);
   * - рукопожатие идёт дольше CONNECT_TIMEOUT_MS (началось перед сном) — новое сразу.
   */
  wake(online = false): void {
    if (!this.wanted().size || this.hidden()) return;
    const now = Date.now();
    if (this.ws) {
      if (this.openedAt === null) {
        if (now - this.dialAt > CONNECT_TIMEOUT_MS) this.fail(true);
        return;
      }
      const quiet = now - this.lastMsg;
      if (quiet > SLEPT_MS) this.fail(true);
      else if (quiet > SILENCE_MS && this.probeAt === null) this.probe();
      return;
    }
    if (this.fails >= BLOCKED_AFTER && !online) {
      if (!this.retry) this.schedule();
      return;
    }
    if (this.fails > 0 && now - this.failedAt < WAKE_GRACE_MS) {
      this.fails--;
      this.save();
    }
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.connect();
  }

  private wanted(): Set<string> {
    const out = new Set<string>();
    for (const sym of this.listeners.keys()) for (const s of streamsOf(sym)) out.add(s);
    return out;
  }

  private hidden(): boolean {
    return this.doc?.visibilityState === "hidden";
  }

  /** Набор символов изменился: один проход на все изменения за BATCH_MS. */
  private changed(): void {
    if (this.listeners.size) {
      this.ensureWatch();
      if (this.linger) {
        clearTimeout(this.linger);
        this.linger = null;
      }
    }
    if (!this.batch) this.batch = setTimeout(() => this.flush(), BATCH_MS);
  }

  private flush(): void {
    this.batch = null;
    const want = this.wanted();
    // символы без слушателей: свежесть, цены и сделки больше не нужны
    for (const sym of new Set([...this.lastPrice.keys(), ...this.fresh.keys(), ...this.behind.keys()])) if (!this.listeners.has(sym)) this.forget(sym);
    if (!want.size) {
      // пауза после отказа не сбрасывается: вернулись на график раньше retryAt — попытка в retryAt, а не сразу
      if (this.retry) clearTimeout(this.retry);
      this.retry = null;
      if (!this.ws) {
        this.stopWatch();
        return;
      }
      if (!this.linger) this.linger = setTimeout(() => this.idle(), LINGER_MS);
    }
    if (!this.ws) {
      if (!this.retry) this.schedule();
      return;
    }
    // замену при смене подписки — заново, с новыми потоками
    if (this.next) {
      this.drop(this.next);
      this.next = null;
    }
    this.pump(); // откроется — сверим потоки (onopen)
  }

  private forget(sym: string): void {
    this.lastPrice.delete(sym);
    this.behind.delete(sym);
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
    this.stopWatch();
  }

  private ensureWatch(): void {
    this.watch ??= setInterval(() => this.check(), WATCH_MS);
  }

  /** Ни соединения, ни символов: таймеров не остаётся. */
  private stopWatch(): void {
    if (this.watch) clearInterval(this.watch);
    this.watch = null;
    if (this.controlTimer) clearTimeout(this.controlTimer);
    this.controlTimer = null;
    this.probeWanted = false;
  }

  /** Соединения нет, символы есть: попытка сейчас или в retryAt (пауза после отказа); вкладка скрыта — при возврате. */
  private schedule(): void {
    if (this.retry || this.ws || !this.wanted().size || this.hidden()) return;
    const wait = this.retryAt - Date.now();
    if (wait <= 0) {
      this.connect();
      return;
    }
    this.retry = setTimeout(() => {
      this.retry = null;
      this.schedule();
    }, wait);
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
    this.gotMsg = false;
    this.probeAt = null;
    this.probeWanted = false;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      const t = Date.now();
      this.openedAt = t;
      this.bornAt = t;
      this.lastMsg = t;
      this.pump(); // подписка менялась, пока шло рукопожатие
    };
    ws.onmessage = (ev) => this.onMessage(ws, ev.data);
    // геоблок (HTTP 451), обрыв, закрытие биржей — error и/или close: пауза и новая попытка
    ws.onerror = ws.onclose = () => {
      if (this.ws === ws) this.fail(false);
    };
  }

  /**
   * Соединение потеряно: все символы — с сервера сразу; новое — сразу (now: вкладка вернулась к мёртвому сокету) или
   * после паузы. Соединение отвечало — первый отказ (пауза минимальная); не отвечало — ещё один отказ подряд. Вкладка
   * скрыта — отказ не считается и попытки нет: она будет при возврате (wake).
   */
  private fail(now: boolean): void {
    const answered = this.gotMsg;
    this.drop(this.ws);
    this.ws = null;
    this.drop(this.next);
    this.next = null;
    this.active.clear();
    this.openedAt = null;
    this.probeAt = null;
    this.probeWanted = false;
    for (const sym of [...this.fresh.keys()]) this.setFresh(sym, false);
    this.lastPrice.clear();
    this.behind.clear();
    this.trades.clear();
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    if (!this.wanted().size) {
      if (this.linger) clearTimeout(this.linger);
      this.linger = null;
      this.stopWatch();
      return;
    }
    if (now) {
      this.connect();
      return;
    }
    if (answered) {
      this.fails = 0;
      this.retryAt = 0;
    }
    if (!this.hidden()) {
      this.fails++;
      this.failedAt = Date.now();
      this.retryAt = this.failedAt + retryWait(this.fails) + this.random() * RETRY_JITTER_MS;
    }
    this.save();
    this.schedule();
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

  /** Проверка соединения: LIST_SUBSCRIPTIONS в очередь управляющих сообщений. */
  private probe(): void {
    this.probeWanted = true;
    this.pump();
  }

  /**
   * Следующее управляющее сообщение — считается в момент отправки: SUBSCRIBE недостающих потоков (новый символ раньше),
   * затем UNSUBSCRIBE лишних, затем проверка. commit — отметить как отправленное.
   */
  private nextControl(commit: boolean): Control | null {
    const want = this.wanted();
    const add = [...want].filter((s) => !this.active.has(s));
    if (add.length) {
      if (commit) for (const s of add) this.active.add(s);
      return { method: "SUBSCRIBE", params: add };
    }
    const del = [...this.active].filter((s) => !want.has(s));
    if (del.length) {
      if (commit) for (const s of del) this.active.delete(s);
      return { method: "UNSUBSCRIBE", params: del };
    }
    if (!this.probeWanted) return null;
    if (commit) {
      this.probeWanted = false;
      this.probeAt = Date.now();
    }
    return { method: "LIST_SUBSCRIPTIONS" };
  }

  /** Управляющие сообщения: не чаще CONTROL_GAP_MS, каждое — по состоянию на момент отправки. */
  private pump(): void {
    const ws = this.ws;
    if (this.controlTimer || !ws || this.openedAt === null || !this.nextControl(false)) return;
    const wait = this.lastControl + CONTROL_GAP_MS - Date.now();
    if (wait > 0) {
      this.controlTimer = setTimeout(() => {
        this.controlTimer = null;
        this.pump();
      }, wait);
      return;
    }
    const msg = this.nextControl(true)!;
    this.lastControl = Date.now();
    try {
      ws.send(JSON.stringify({ ...msg, id: ++this.id }));
    } catch {
      // закрывается — новое соединение возьмёт потоки из адреса
    }
    this.pump();
  }

  private onMessage(ws: WebSocket, raw: unknown): void {
    let m: { stream?: string; data?: { e?: string; s?: string; E?: unknown }; id?: number };
    try {
      m = JSON.parse(String(raw)) as typeof m;
    } catch {
      return;
    }
    if (ws === this.next) this.promote(ws);
    else if (ws !== this.ws) return;
    const now = Date.now();
    this.lastMsg = now;
    this.probeAt = null;
    if (!this.gotMsg) {
      this.gotMsg = true;
      if (this.fails || this.retryAt) {
        this.fails = 0;
        this.retryAt = 0;
        this.save();
      }
    }
    const data = m && typeof m.stream === "string" && m.data && typeof m.data === "object" ? m.data : null;
    if (!data) return; // ответ на SUBSCRIBE / UNSUBSCRIBE / проверку
    const sym = data.s;
    if (typeof sym !== "string" || !this.listeners.has(sym)) return;
    const E = isNum(data.E) ? data.E : now;
    if (data.e === "kline") {
      const k = parseKline(data);
      if (!k) return;
      this.saw(sym, k.c.c.c, E);
      for (const l of this.listeners.get(sym) ?? []) (k.closed ? l.candle : l.forming)?.(k.c);
    } else if (data.e === "aggTrade") {
      const t = parseAggTrade(data);
      if (!t) return;
      this.saw(sym, t.p, E);
      const prev = this.trades.get(sym);
      if (prev && Date.parse(prev.at) > Date.parse(t.at)) return;
      this.trades.set(sym, t);
      if (!this.framePending) {
        this.framePending = true;
        this.raf(() => this.frame());
      }
    }
  }

  /** Данные биржи по символу (событие E, мс): последняя цена, отставание догнано, символ свеж. */
  private saw(sym: string, p: string, E: number): void {
    const last = this.lastPrice.get(sym);
    if (!last || E >= last.at) this.lastPrice.set(sym, { p: Number(p), at: E });
    const behind = this.behind.get(sym);
    if (behind !== undefined && E >= behind - CATCH_UP_MS) this.behind.delete(sym);
    this.setFresh(sym, this.isFresh(sym));
  }

  /** Кадр анимации: последняя сделка каждого символа — тиком. */
  private frame(): void {
    this.framePending = false;
    const batch = [...this.trades.values()];
    this.trades.clear();
    for (const t of batch) for (const l of this.listeners.get(t.s) ?? []) l.tick?.(t);
  }

  /** Замена ответила: она — основное соединение (потоки — из её адреса), старое закрыто. */
  private promote(ws: WebSocket): void {
    const old = this.ws;
    const now = Date.now();
    this.ws = ws;
    this.next = null;
    this.active = new Set(this.nextStreams);
    this.openedAt = now;
    this.bornAt = now;
    this.lastMsg = now;
    this.gotMsg = true;
    this.probeAt = null;
    ws.onclose = ws.onerror = () => {
      if (this.ws === ws) this.fail(false);
    };
    this.drop(old);
    this.pump();
  }

  /** Замена соединения до 24 ч: новое с теми же потоками; основным станет с первым ответом (проверка при открытии). */
  private rotate(): void {
    const streams = [...this.wanted()];
    const n = this.open(streams);
    this.next = n;
    this.nextStreams = streams;
    this.nextAt = Date.now();
    n.onopen = () => {
      if (this.next !== n) return;
      try {
        n.send(JSON.stringify({ method: "LIST_SUBSCRIPTIONS", id: ++this.id }));
      } catch {
        // закрылось — onclose
      }
    };
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

  /**
   * Раз в WATCH_MS: рукопожатие, тишина и проверка, замена до 24 ч. Таймеры спали (вкладка видна: ноутбук проснулся без
   * visibilitychange) — тишина дольше SLEPT_MS без проверки или проверка, просроченная больше чем на 2 WATCH_MS, — новое
   * соединение сразу, без проверки и паузы; во скрытой вкладке — как обычно (проверка; замена — при возврате, wake).
   */
  private check(): void {
    const ws = this.ws;
    if (!ws) return;
    const now = Date.now();
    if (this.openedAt === null) {
      if (now - this.dialAt > CONNECT_TIMEOUT_MS) this.fail(false);
      return;
    }
    if (!this.wanted().size) return; // символов нет — соединение закроется через LINGER_MS
    if (this.probeAt !== null) {
      const age = now - this.probeAt;
      if (age > PROBE_TIMEOUT_MS) this.fail(age > PROBE_TIMEOUT_MS + 2 * WATCH_MS && !this.hidden());
      return;
    }
    const quiet = now - this.lastMsg;
    if (quiet > SILENCE_MS) {
      if (quiet > SLEPT_MS && !this.hidden()) this.fail(true);
      else this.probe();
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

  /** Пауза после отказов — из sessionStorage (перезагрузка вкладки не начинает попытки заново). */
  private load(): void {
    try {
      const v = JSON.parse(this.store?.getItem(RETRY_KEY) ?? "null") as { fails?: unknown; retryAt?: unknown } | null;
      if (!v || !isNum(v.fails) || !isNum(v.retryAt)) return;
      this.fails = Math.max(0, Math.floor(v.fails));
      // часы перевели: пауза не дольше самой длинной
      this.retryAt = Math.min(v.retryAt, Date.now() + COOL_MS + RETRY_JITTER_MS);
    } catch {
      // нет хранилища или мусор — с нуля
    }
  }

  private save(): void {
    try {
      this.store?.setItem(RETRY_KEY, JSON.stringify({ fails: this.fails, retryAt: Math.round(this.retryAt) }));
    } catch {
      // хранилище запрещено или полно — пауза только в памяти
    }
  }

  /**
   * Вкладка скрыта BACKGROUND_MS (план 2A.7): соединение закрывается — как закрытие в скрытой вкладке (fail), отказом не
   * считается и попыток до возврата нет; символы — с сервера (его сокет закрывается так же — LiveSocket), догон истории
   * при возврате — по открытию сокета сервера.
   */
  private sleep(): void {
    this.background = null;
    if (this.hidden() && (this.ws || this.next)) this.fail(false);
  }

  private readonly onVisibility = (): void => {
    if (this.hidden()) {
      this.background ??= setTimeout(() => this.sleep(), BACKGROUND_MS);
      return;
    }
    if (this.background) clearTimeout(this.background);
    this.background = null;
    if (this.doc?.visibilityState === "visible") this.wake();
  };

  private readonly onPageShow = (e: PageTransitionEvent): void => {
    if (e.persisted) this.wake();
  };

  private readonly onOnline = (): void => this.wake(true);
}

let shared: BinanceFeed | null = null;

/** Соединение с биржей на страницу (общее для терминала и ячеек мультичарта); на сервере — null. */
export function binanceFeed(): BinanceFeed | null {
  if (typeof window === "undefined" || typeof WebSocket === "undefined") return null;
  return (shared ??= new BinanceFeed());
}
