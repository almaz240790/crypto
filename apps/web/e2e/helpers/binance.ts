import type { BrowserContext, Page, WebSocketRoute } from "@playwright/test";

/**
 * Заглушка прямого потока Binance USDⓈ-M Futures (wss://fstream.binance.com/stream?streams=…) для e2e (ADR-0010,
 * дополнение «цена с биржи»). Настоящая биржа из контейнера и CI недоступна (геоблок 451), а где доступна — давала бы
 * настоящие цены поверх фикстур: поэтому mock() из helpers/chart закрывает её для всех спеков (blockBinance), а спеки
 * прямого потока ставят эту заглушку на страницу (маршрут страницы важнее маршрута контекста).
 *
 * Умеет: поток по подписанным символам — сделки каждые `every` мс и kline 1m каждые 250 мс (o/h/l/c/v идущей минуты из
 * этих сделок, при смене минуты — закрытая минута x = true); ответы на SUBSCRIBE/UNSUBSCRIBE/LIST_SUBSCRIPTIONS (потоки
 * соединения меняются); отказ в соединении (state.refuse — как геоблок); полная тишина (state.silent — ни данных, ни
 * ответов, как полуоткрытый сокет); пауза данных при живых ответах (state.data = false); ручные kline и сделки.
 * Пишет соединения (sockets: адрес и потоки) и все управляющие сообщения (control).
 */

export const BINANCE_RE = /^wss:\/\/fstream\.binance\.com\//;

/** Биржа недоступна (как из контейнера и CI): соединение закрывается сразу. Для всех спеков — через mock(). */
export async function blockBinance(ctx: BrowserContext): Promise<void> {
  await ctx.routeWebSocket(BINANCE_RE, (ws) => void ws.close());
}

type Control = { method: string; params?: string[]; id: number };
type Conn = { ws: WebSocketRoute; url: string; streams: Set<string>; open: boolean };
type Minute = { t: number; o: number; h: number; l: number; c: number; v: number };

export type BinanceMock = {
  /** attempts — все попытки соединения, и отклонённые (refuse). */
  state: { data: boolean; silent: boolean; refuse: boolean; k: number; attempts: number[]; last: Map<string, number> };
  sockets: Conn[];
  control: Control[];
  /** Потоки последнего открытого соединения. */
  streams(): string[];
  /** Открытые соединения. */
  openCount(): number;
  /** kline символа во все соединения, подписанные на него. */
  kline(symbol: string, k: { t: number; o: string; h: string; l: string; c: string; v: string; x?: boolean }, E: number): void;
  trade(symbol: string, p: string, T: number): void;
  dispose(): void;
};

export type BinanceMockOptions = {
  /** Поток сразу (по умолчанию — да). */
  data?: boolean;
  /** Время k-й сделки, unix с (минута kline — по нему). */
  at: (k: number) => number;
  /** Цена k-й сделки символа. */
  price: (k: number, symbol: string) => number;
  /** Сделка каждые, мс (по умолчанию 100). */
  every?: number;
  /** Знаков после точки у цены (по умолчанию 2). */
  digits?: number;
};

export async function binanceSocket(page: Page, o: BinanceMockOptions): Promise<BinanceMock> {
  const sockets: Conn[] = [];
  const control: Control[] = [];
  const state = { data: o.data ?? true, silent: false, refuse: false, k: 0, attempts: [] as number[], last: new Map<string, number>() };
  const minutes = new Map<string, Minute>();
  const digits = o.digits ?? 2;
  const every = o.every ?? 100;
  const live = () => sockets.filter((c) => c.open);
  const send = (sym: string, stream: string, data: unknown) => {
    for (const c of live()) if (c.streams.has(`${sym.toLowerCase()}@${stream}`)) c.ws.send(JSON.stringify({ stream: `${sym.toLowerCase()}@${stream}`, data }));
  };
  const kline = (symbol: string, k: { t: number; o: string; h: string; l: string; c: string; v: string; x?: boolean }, E: number) =>
    send(symbol, "kline_1m", { e: "kline", E: Math.round(E * 1000), s: symbol, k: { t: k.t * 1000, T: k.t * 1000 + 59_999, s: symbol, i: "1m", o: k.o, h: k.h, l: k.l, c: k.c, v: k.v, x: k.x ?? false, n: 1, q: "0", V: "0", Q: "0", B: "0" } });
  const trade = (symbol: string, p: string, T: number) => send(symbol, "aggTrade", { e: "aggTrade", E: Math.round(T * 1000) + 3, s: symbol, a: state.k, p, q: "1", f: 1, l: 1, T: Math.round(T * 1000), m: false });
  const fmt = (x: number) => x.toFixed(digits);
  const asKline = (m: Minute, x = false) => ({ t: m.t, o: fmt(m.o), h: fmt(m.h), l: fmt(m.l), c: fmt(m.c), v: String(m.v), x });

  await page.routeWebSocket(BINANCE_RE, (ws) => {
    const url = ws.url();
    state.attempts.push(Date.now());
    if (state.refuse) {
      void ws.close();
      return;
    }
    const streams = new Set((new URL(url).searchParams.get("streams") ?? "").split("/").filter(Boolean));
    const conn: Conn = { ws, url, streams, open: true };
    sockets.push(conn);
    ws.onClose(() => {
      conn.open = false;
    });
    ws.onMessage((raw) => {
      if (state.silent) return;
      const m = JSON.parse(String(raw)) as Control;
      control.push(m);
      if (m.method === "SUBSCRIBE") for (const s of m.params ?? []) conn.streams.add(s);
      if (m.method === "UNSUBSCRIBE") for (const s of m.params ?? []) conn.streams.delete(s);
      ws.send(JSON.stringify({ result: m.method === "LIST_SUBSCRIPTIONS" ? [...conn.streams] : null, id: m.id }));
    });
  });

  // символы, на которые подписано хоть одно соединение
  const symbols = () => {
    const out = new Set<string>();
    for (const c of live()) for (const s of c.streams) if (s.endsWith("@aggTrade")) out.add(s.slice(0, -"@aggTrade".length).toUpperCase());
    return [...out];
  };
  let ticks = 0;
  const timer = setInterval(() => {
    if (!state.data || state.silent || !live().length) return;
    const k = ++state.k;
    const T = o.at(k);
    const t = Math.floor(T / 60) * 60;
    const klineNow = ++ticks % Math.max(1, Math.round(250 / every)) === 0;
    for (const sym of symbols()) {
      const p = Number(fmt(o.price(k, sym)));
      state.last.set(sym, p);
      let m = minutes.get(sym);
      if (m && m.t !== t) {
        kline(sym, asKline(m, true), t); // минута закрылась
        m = undefined;
      }
      m = m ? { ...m, h: Math.max(m.h, p), l: Math.min(m.l, p), c: p, v: m.v + 1 } : { t, o: p, h: p, l: p, c: p, v: 1 };
      minutes.set(sym, m);
      trade(sym, fmt(p), T);
      if (klineNow) kline(sym, asKline(m), T);
    }
  }, every);
  page.once("close", () => clearInterval(timer));
  return {
    state,
    sockets,
    control,
    streams: () => [...(live().at(-1)?.streams ?? [])].sort(),
    openCount: () => live().length,
    kline,
    trade,
    dispose: () => clearInterval(timer),
  };
}
