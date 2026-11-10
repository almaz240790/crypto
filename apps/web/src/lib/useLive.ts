"use client";

/**
 * WebSocket к /v1/ws (через тот же домен): живые цены по подписанным инструментам и смена статусов
 * сигналов. Тики приходят раз в секунду на символ (ADR-0010, одиночные `tick` или пачкой `ticks`) и
 * копятся: состояние React с ценами меняется не чаще раза в секунду, сколько бы символов ни было.
 * Графику тики, формирующаяся и закрытая минуты отдаются колбэками — мимо React. «Онлайн» — тик
 * пришёл за последние ONLINE_MS.
 *
 * Соединение (LiveSocket) само следит за собой: тишина дольше SILENCE_MS — пинг; нет ответа за
 * PONG_TIMEOUT_MS — сокет полуоткрыт (телефон спал, сеть сменилась): закрываем и подключаемся сразу.
 * Сокет, сменённый новым (переподключение, смена токена), состояние больше не трогает. Догон истории —
 * по колбэку onResync, один механизм на повод (ADR-0003, ADR-0010):
 * - сокет открыт заново (после первого открытия) — onResync("reconnect"), когда новый сокет уже открыт;
 * - вкладка снова видна, страница из кэша (pageshow persisted), сеть вернулась (online) — wake():
 *   сокет открыт и свеж (сообщение за ONLINE_MS) — ничего; открыт, но молчит — переподключение (дальше
 *   reconnect); не открыт — onResync("wake") сразу (история по REST) и переподключение, если сокет не
 *   подключается уже.
 * Пока сокет, сменивший прежний, открывается (resyncPending), другие поводы догона (просрочка) ждут: его открытие —
 * один догон по reconnect, а не два.
 * Без анимаций — просто новые числа.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** Смена статуса сигнала; `scope: "forward"` — тестовый сигнал (ADR-0013), показывается с пометкой. */
export type LiveSignal = { id: string; instrument_id: number; status: string; at: string; scope?: "live" | "forward" };
/** Минутная свеча; у формирующейся `at` — момент снимка на сервере. */
export type LiveBarMsg = { t: number; o: string; h: string; l: string; c: string; v: string; at?: string };
/** Минутная свеча: закрытая (`candle`) или формирующаяся (`forming`). */
export type LiveCandle = { s: string; tf: "1m"; c: LiveBarMsg };
export type LiveTick = { s: string; p: string; at: string };
export type LivePrice = { p: string; at: string };

/** Повод перечитать историю: сокет открыт заново или вкладка снова видна при неоткрытом сокете. */
export type ResyncReason = "reconnect" | "wake";

export type LiveHandlers = {
  onSignal?: (s: LiveSignal) => void;
  onCandle?: (c: LiveCandle) => void;
  onForming?: (c: LiveCandle) => void;
  onTick?: (t: LiveTick) => void;
  /** Цена закрытой минуты (`price`). */
  onPrice?: (s: string, p: LivePrice) => void;
  onResync?: (reason: ResyncReason) => void;
};

export type LiveMsg =
  | { t: "price"; s: string; p: string; at: string }
  | ({ t: "tick" } & LiveTick)
  | { t: "ticks"; at: string; p: Record<string, string> }
  | ({ t: "candle" } & LiveCandle)
  | ({ t: "forming" } & LiveCandle)
  | ({ t: "signal" } & LiveSignal)
  | { t: "subscribed"; n: number }
  | { t: "pong" };

/** «Онлайн» — последний тик не старше этого. */
export const ONLINE_MS = 5000;
/** Состояние React с ценами — не чаще раза в это время. */
export const PRICE_STATE_MS = 1000;
/** Ни одного сообщения дольше — проверочный пинг (сервер отвечает pong). */
export const SILENCE_MS = 5000;
/** Пинг без ответа дольше — сокет мёртв, хоть и «открыт»: переподключение сразу. */
export const PONG_TIMEOUT_MS = 5000;
/** Пауза перед переподключением после закрытия сокета: от и плюс случайное до. */
export const RETRY_MS = 3000;
export const RETRY_JITTER_MS = 2000;
/** Сколько ждать открытия сокета, сменившего прежний, прежде чем догонять другими поводами (сети нет — не ждём). */
export const RECONNECT_WAIT_MS = 10_000;

/** Цена b не старше a: закрытая минута (`price`) приходит позже тиков и не должна откатывать цену. */
export function isNewer(a: LivePrice | undefined, b: LivePrice): boolean {
  if (!a) return true;
  const ta = Date.parse(a.at);
  const tb = Date.parse(b.at);
  return !(Number.isFinite(ta) && Number.isFinite(tb) && tb < ta);
}

/** Слияние накопленных цен в состояние: только более свежие; то же состояние, если ничего не изменилось. */
export function mergePrices(prev: Record<string, LivePrice>, batch: Record<string, LivePrice>): Record<string, LivePrice> {
  let next: Record<string, LivePrice> | null = null;
  for (const [s, v] of Object.entries(batch)) {
    const cur = prev[s];
    if (!isNewer(cur, v) || (cur && cur.p === v.p && cur.at === v.at)) continue;
    next ??= { ...prev };
    next[s] = v;
  }
  return next ?? prev;
}

/**
 * Пачка цен для React: первая цена уходит сразу, следующие копятся (по символу — последняя) и уходят
 * одним вызовом не раньше чем через `every` мс после предыдущего.
 */
export class PriceBatch {
  private pending: Record<string, LivePrice> = {};
  private last = -Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly flush: (batch: Record<string, LivePrice>) => void,
    private readonly every = PRICE_STATE_MS,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  push(symbol: string, price: LivePrice): void {
    if (!isNewer(this.pending[symbol], price)) return;
    this.pending[symbol] = price;
    if (this.timer) return;
    const wait = this.last + this.every - this.clock();
    if (wait <= 0) this.emit();
    else this.timer = setTimeout(() => this.emit(), wait);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = {};
  }

  private emit(): void {
    this.timer = null;
    this.last = this.clock();
    const batch = this.pending;
    this.pending = {};
    if (Object.keys(batch).length) this.flush(batch);
  }
}

/**
 * Сообщение сервера — в цены (пачкой для React; null — цены держит сам получатель, терминал) и колбэки; пачка тиков
 * раскладывается по символам.
 */
export function dispatchLive(m: LiveMsg, h: LiveHandlers, prices: PriceBatch | null): void {
  if (m.t === "tick") {
    prices?.push(m.s, { p: m.p, at: m.at });
    h.onTick?.(m);
  } else if (m.t === "ticks") {
    for (const [s, p] of Object.entries(m.p ?? {})) {
      prices?.push(s, { p, at: m.at });
      h.onTick?.({ s, p, at: m.at });
    }
  } else if (m.t === "price") {
    prices?.push(m.s, { p: m.p, at: m.at });
    h.onPrice?.(m.s, { p: m.p, at: m.at });
  } else if (m.t === "signal") h.onSignal?.(m);
  else if (m.t === "candle") h.onCandle?.(m);
  else if (m.t === "forming") h.onForming?.(m);
}

export type LiveSubscription = { sub: string[]; batch: boolean; forming: boolean };

type Visibility = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
type Events = Pick<Window, "addEventListener" | "removeEventListener">;

export type LiveSocketOptions = {
  /** Адрес сокета (с токеном). */
  url: () => Promise<string>;
  /** Текущая подписка — отправляется при каждом открытии и по resubscribe(). */
  subscription: () => LiveSubscription;
  onMessage: (m: LiveMsg) => void;
  onConnected: (v: boolean) => void;
  onOnline: (v: boolean) => void;
  /** Открыто заново после первого открытия (данные между могли пропасть): новый сокет уже открыт. */
  onReconnect: () => void;
  /** Вкладка снова видна (pageshow, online), а сокет не открыт: историю — сразу, по REST. */
  onWake?: () => void;
  WebSocketImpl?: typeof WebSocket;
  doc?: Visibility | null;
  /** pageshow и online (по умолчанию window). */
  win?: Events | null;
};

/** Соединение /v1/ws с переподключением и сторожем полуоткрытого сокета (без React). */
export class LiveSocket {
  private ws: WebSocket | null = null;
  private stopped = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private watch: ReturnType<typeof setInterval> | undefined;
  private lastMsg = -Infinity;
  private lastTick = -Infinity;
  private pingAt: number | null = null;
  private opened = 0;
  /** Начало подключения (unix мс): адрес, рукопожатие; null — не подключаемся. */
  private dialAt: number | null = null;
  /** Последнее отданное «онлайн» (null — ещё не отдавали: первая проверка скажет как есть). */
  private online: boolean | null = null;
  private readonly WS: typeof WebSocket;
  private readonly doc: Visibility | null;
  private readonly win: Events | null;

  constructor(private readonly opts: LiveSocketOptions) {
    this.WS = opts.WebSocketImpl ?? WebSocket;
    this.doc = opts.doc === undefined ? (typeof document === "undefined" ? null : document) : opts.doc;
    this.win = opts.win === undefined ? (typeof window === "undefined" ? null : window) : opts.win;
  }

  start(): void {
    // «онлайн» гаснет сам, если тики перестали приходить (сокет при этом может быть открыт)
    this.watch = setInterval(() => this.check(), 1000);
    this.doc?.addEventListener("visibilitychange", this.onVisibility);
    this.win?.addEventListener("pageshow", this.onPageShow as EventListener);
    this.win?.addEventListener("online", this.onOnline);
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.watch) clearInterval(this.watch);
    this.doc?.removeEventListener("visibilitychange", this.onVisibility);
    this.win?.removeEventListener("pageshow", this.onPageShow as EventListener);
    this.win?.removeEventListener("online", this.onOnline);
    this.detach();
  }

  /**
   * Вкладка снова видна, страница из кэша, сеть вернулась: сокет открыт и свеж — ничего; открыт, но молчит дольше
   * ONLINE_MS (телефон спал, iOS держит «открытым» мёртвый сокет) — новый сокет сразу (его открытие — onReconnect);
   * не открыт — история сразу (onWake) и новый сокет, если он не подключается уже.
   */
  wake(): void {
    if (this.stopped) return;
    const ws = this.ws;
    if (ws && ws.readyState === 1) {
      if (Date.now() - this.lastMsg > ONLINE_MS) this.reconnectNow();
      return;
    }
    this.opts.onWake?.();
    if (!ws || ws.readyState !== 0) this.reconnectNow();
  }

  /**
   * Открывается сокет, сменивший прежний (переподключение после обрыва, полуоткрытого сокета, возврата вкладки): его
   * открытие вызовет onReconnect — один догон. Не дольше RECONNECT_WAIT_MS: сети нет — пусть догоняют другие поводы.
   */
  get resyncPending(): boolean {
    if (this.stopped || this.opened === 0 || this.dialAt === null) return false;
    return Date.now() - this.dialAt < RECONNECT_WAIT_MS;
  }

  /** Подписка сменилась — отправить, если сокет открыт. */
  resubscribe(): void {
    const ws = this.ws;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(this.opts.subscription()));
  }

  private markOnline(v: boolean): void {
    if (v === this.online) return;
    this.online = v;
    this.opts.onOnline(v);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.dialAt ??= Date.now();
    const url = await this.opts.url();
    if (this.stopped || this.ws) return;
    const ws = new this.WS(url);
    this.ws = ws;
    this.lastMsg = Date.now();
    this.pingAt = null;
    // сокет, сменённый новым, ничего не трогает: его поздний onclose не гасит «онлайн» нового
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.dialAt = null;
      this.lastMsg = Date.now();
      this.opened++;
      this.opts.onConnected(true);
      ws.send(JSON.stringify(this.opts.subscription()));
      if (this.opened > 1) this.opts.onReconnect();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.lastMsg = Date.now();
      this.pingAt = null;
      let m: LiveMsg;
      try {
        m = JSON.parse(ev.data as string) as LiveMsg;
      } catch {
        return;
      }
      if (m.t === "tick" || m.t === "ticks") {
        this.lastTick = Date.now();
        this.markOnline(true);
      }
      this.opts.onMessage(m);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.dialAt = null;
      this.lost();
      if (!this.stopped) this.retry = setTimeout(() => void this.connect(), RETRY_MS + Math.random() * RETRY_JITTER_MS);
    };
    ws.onerror = () => ws.close();
  }

  private lost(): void {
    this.lastTick = -Infinity;
    this.markOnline(false);
    this.opts.onConnected(false);
  }

  /** Отцепить текущий сокет: его события больше ничего не меняют, закрытие — без ожидания. */
  private detach(): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close();
    } catch {
      // уже закрыт
    }
  }

  /** Сокет мёртв или устарел: новый — сразу, не дожидаясь onclose старого. */
  private reconnectNow(): void {
    if (this.stopped) return;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    const had = this.ws !== null;
    this.detach();
    if (had) this.lost();
    void this.connect();
  }

  private check(): void {
    const now = Date.now();
    this.markOnline(now - this.lastTick < ONLINE_MS);
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return;
    if (this.pingAt !== null) {
      if (now - this.pingAt > PONG_TIMEOUT_MS) this.reconnectNow();
    } else if (now - this.lastMsg > SILENCE_MS) {
      this.pingAt = now;
      ws.send('{"ping":1}');
    }
  }

  private readonly onVisibility = (): void => {
    if (this.doc?.visibilityState === "visible") this.wake();
  };

  private readonly onPageShow = (e: PageTransitionEvent): void => {
    if (e.persisted) this.wake();
  };

  private readonly onOnline = (): void => this.wake();
}

/** Адрес сокета: из /config (тот же домен), иначе — /v1/ws текущего хоста. */
async function wsBase(): Promise<string> {
  try {
    const r = await fetch("/config");
    return ((await r.json()) as { ws: string }).ws;
  } catch {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${window.location.host}/v1/ws`;
  }
}

/**
 * opts.prices = false — цены в состояние React не копятся (терминал держит цену шапки сам — HeaderPrice, источник —
 * биржа или сервер, liveSource.ts): тики только в колбэки, и сервер не перерисовывает терминал раз в секунду.
 */
export function useLive(symbols: string[], token: string | null, handlers: LiveHandlers = {}, opts: { prices?: boolean } = {}) {
  const [prices, setPrices] = useState<Record<string, LivePrice>>({});
  const [connected, setConnected] = useState(false);
  const [online, setOnline] = useState(false);
  const sockRef = useRef<LiveSocket | null>(null);
  const symsRef = useRef<string[]>(symbols);
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });
  const key = symbols.slice().sort().join(",");
  const keepPrices = opts.prices !== false;

  useEffect(() => {
    const batch = keepPrices ? new PriceBatch((b) => setPrices((prev) => mergePrices(prev, b))) : null;
    let base: Promise<string> | null = null;
    const sock = new LiveSocket({
      url: async () => {
        base ??= wsBase();
        return `${await base}${token ? `?token=${encodeURIComponent(token)}` : ""}`;
      },
      // пачка тиков — один кадр в секунду на все символы; формирующиеся минуты — только графику
      subscription: () => ({ sub: symsRef.current, batch: true, forming: Boolean(handlersRef.current.onForming) }),
      onMessage: (m) => dispatchLive(m, handlersRef.current, batch),
      onConnected: setConnected,
      onOnline: setOnline,
      onReconnect: () => handlersRef.current.onResync?.("reconnect"),
      onWake: () => handlersRef.current.onResync?.("wake"),
    });
    sockRef.current = sock;
    sock.start();
    return () => {
      sock.stop();
      batch?.dispose();
      if (sockRef.current === sock) sockRef.current = null;
    };
  }, [token, keepPrices]);

  useEffect(() => {
    symsRef.current = key ? key.split(",") : [];
    sockRef.current?.resubscribe();
  }, [key]);

  // новый сокет открывается — его открытие и есть догон (просрочка ждёт, LIVE-3)
  const resyncPending = useCallback(() => sockRef.current?.resyncPending ?? false, []);
  return { prices, connected, online, resyncPending };
}
