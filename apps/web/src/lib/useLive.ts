"use client";

/**
 * WebSocket к /v1/ws (через тот же домен): живые цены по подписанным инструментам и смена статусов
 * сигналов. Тики приходят раз в секунду на символ (ADR-0010) и копятся: состояние React с ценами
 * меняется не чаще раза в секунду, сколько бы символов ни было. Графику тики, формирующаяся и закрытая
 * минуты отдаются колбэками — мимо React. «Онлайн» — тик пришёл за последние ONLINE_MS.
 * Переподключение с задержкой, без анимаций — просто новые числа.
 */
import { useEffect, useRef, useState } from "react";

export type LiveSignal = { id: string; instrument_id: number; status: string; at: string };
export type LiveBarMsg = { t: number; o: string; h: string; l: string; c: string; v: string };
/** Минутная свеча: закрытая (`candle`) или формирующаяся (`forming`). */
export type LiveCandle = { s: string; tf: "1m"; c: LiveBarMsg };
export type LiveTick = { s: string; p: string; at: string };
export type LivePrice = { p: string; at: string };

export type LiveHandlers = {
  onSignal?: (s: LiveSignal) => void;
  onCandle?: (c: LiveCandle) => void;
  onForming?: (c: LiveCandle) => void;
  onTick?: (t: LiveTick) => void;
};

type Msg =
  | { t: "price"; s: string; p: string; at: string }
  | ({ t: "tick" } & LiveTick)
  | ({ t: "candle" } & LiveCandle)
  | ({ t: "forming" } & LiveCandle)
  | { t: "signal"; id: string; instrument_id: number; status: string; at: string }
  | { t: "subscribed"; n: number }
  | { t: "pong" };

/** «Онлайн» — последний тик не старше этого. */
export const ONLINE_MS = 5000;
/** Состояние React с ценами — не чаще раза в это время. */
export const PRICE_STATE_MS = 1000;

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

export function useLive(symbols: string[], token: string | null, handlers: LiveHandlers = {}) {
  const [prices, setPrices] = useState<Record<string, LivePrice>>({});
  const [connected, setConnected] = useState(false);
  const [online, setOnline] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const symsRef = useRef<string[]>(symbols);
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });
  const key = symbols.slice().sort().join(",");

  useEffect(() => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;
    let lastTick = -Infinity;
    let isOnline = false;
    const markOnline = (v: boolean) => {
      if (v === isOnline) return;
      isOnline = v;
      setOnline(v);
    };
    // «онлайн» гаснет сам, если тики перестали приходить (сокет при этом может быть открыт)
    const watch = setInterval(() => markOnline(Date.now() - lastTick < ONLINE_MS), 1000);
    const batch = new PriceBatch((b) => setPrices((prev) => mergePrices(prev, b)));

    let base: string | null = null;

    async function wsBase(): Promise<string> {
      if (base) return base;
      try {
        const r = await fetch("/config");
        base = ((await r.json()) as { ws: string }).ws;
      } catch {
        const proto = window.location.protocol === "https:" ? "wss" : "ws";
        base = `${proto}://${window.location.host}/v1/ws`;
      }
      return base;
    }

    async function connect() {
      if (closed) return;
      const url = `${await wsBase()}${token ? `?token=${encodeURIComponent(token)}` : ""}`;
      if (closed) return;
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onopen = () => {
        setConnected(true);
        ws.send(JSON.stringify({ sub: symsRef.current }));
        ping = setInterval(() => ws.readyState === 1 && ws.send('{"ping":1}'), 25_000);
      };
      ws.onmessage = (ev) => {
        let m: Msg;
        try {
          m = JSON.parse(ev.data as string) as Msg;
        } catch {
          return;
        }
        const h = handlersRef.current;
        if (m.t === "tick") {
          lastTick = Date.now();
          markOnline(true);
          batch.push(m.s, { p: m.p, at: m.at });
          h.onTick?.(m);
        } else if (m.t === "price") batch.push(m.s, { p: m.p, at: m.at });
        else if (m.t === "signal") h.onSignal?.(m);
        else if (m.t === "candle") h.onCandle?.(m);
        else if (m.t === "forming") h.onForming?.(m);
      };
      ws.onclose = () => {
        setConnected(false);
        lastTick = -Infinity;
        markOnline(false);
        if (ping) clearInterval(ping);
        if (!closed) timer = setTimeout(() => void connect(), 3000 + Math.random() * 2000);
      };
      ws.onerror = () => ws.close();
    }
    void connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      if (ping) clearInterval(ping);
      clearInterval(watch);
      batch.dispose();
      wsRef.current?.close();
    };
  }, [token]);

  useEffect(() => {
    symsRef.current = key ? key.split(",") : [];
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ sub: symsRef.current }));
  }, [key]);

  return { prices, connected, online };
}
