"use client";

/**
 * WebSocket к /v1/ws (через тот же домен): живые цены по подписанным инструментам и
 * смена статусов сигналов. Переподключение с задержкой, без анимаций — просто новые числа.
 */
import { useEffect, useRef, useState } from "react";

export type LiveSignal = { id: string; instrument_id: number; status: string; at: string };
export type LiveCandle = { s: string; tf: "1m"; c: { t: number; o: string; h: string; l: string; c: string; v: string } };

type Msg =
  | { t: "price"; s: string; p: string; at: string }
  | ({ t: "candle" } & LiveCandle)
  | { t: "signal"; id: string; instrument_id: number; status: string; at: string }
  | { t: "subscribed"; n: number }
  | { t: "pong" };

/** Сокет молчит дольше (ping раз в 25 с) — при возврате вкладки проверяем его ping-ом, мс. */
const STALE_MS = 30_000;
/** Ответа на проверочный ping нет столько — сокет мёртв, переподключаемся сразу, мс. */
const PROBE_MS = 5_000;

export function useLive(symbols: string[], token: string | null, onSignal?: (s: LiveSignal) => void, onCandle?: (c: LiveCandle) => void) {
  const [prices, setPrices] = useState<Record<string, { p: string; at: string }>>({});
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const symsRef = useRef<string[]>(symbols);
  const onSignalRef = useRef(onSignal);
  const onCandleRef = useRef(onCandle);
  useEffect(() => {
    onSignalRef.current = onSignal;
    onCandleRef.current = onCandle;
  }, [onSignal, onCandle]);
  const key = symbols.slice().sort().join(",");

  useEffect(() => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;
    let probe: ReturnType<typeof setTimeout> | undefined;
    let lastMsg = Date.now();

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
        lastMsg = Date.now();
        setConnected(true);
        ws.send(JSON.stringify({ sub: symsRef.current }));
        ping = setInterval(() => ws.readyState === 1 && ws.send('{"ping":1}'), 25_000);
      };
      ws.onmessage = (ev) => {
        lastMsg = Date.now();
        let m: Msg;
        try {
          m = JSON.parse(ev.data as string) as Msg;
        } catch {
          return;
        }
        if (m.t === "price") setPrices((prev) => ({ ...prev, [m.s]: { p: m.p, at: m.at } }));
        else if (m.t === "signal") onSignalRef.current?.(m);
        else if (m.t === "candle") onCandleRef.current?.(m);
      };
      ws.onclose = () => {
        setConnected(false);
        if (ping) clearInterval(ping);
        if (!closed) timer = setTimeout(() => void connect(), 3000 + Math.random() * 2000);
      };
      ws.onerror = () => ws.close();
    }
    /** Старый сокет — без обработчиков и закрыт, новый — сразу, без задержки переподключения. */
    function reconnectNow() {
      const old = wsRef.current;
      if (old) {
        old.onopen = old.onmessage = old.onclose = old.onerror = null;
        old.close();
      }
      if (ping) clearInterval(ping);
      if (timer) clearTimeout(timer);
      clearTimeout(probe);
      setConnected(false);
      void connect();
    }
    /**
     * Вкладка снова видна. iOS после фона держит сокет «открытым», хотя соединения уже нет: ни сообщений,
     * ни onclose, а в шапке — «онлайн». Закрытый сокет — переподключение сразу; молчащий дольше STALE_MS —
     * проверочный ping, без ответа за PROBE_MS — переподключение.
     */
    function onVisible() {
      if (closed || document.visibilityState !== "visible") return;
      const ws = wsRef.current;
      if (!ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) return reconnectNow();
      if (ws.readyState !== WebSocket.OPEN || Date.now() - lastMsg < STALE_MS) return;
      const sent = Date.now();
      ws.send('{"ping":1}');
      clearTimeout(probe);
      probe = setTimeout(() => {
        if (!closed && lastMsg < sent) reconnectNow();
      }, PROBE_MS);
    }
    document.addEventListener("visibilitychange", onVisible);
    void connect();
    return () => {
      closed = true;
      document.removeEventListener("visibilitychange", onVisible);
      if (timer) clearTimeout(timer);
      if (ping) clearInterval(ping);
      clearTimeout(probe);
      wsRef.current?.close();
    };
  }, [token]);

  useEffect(() => {
    symsRef.current = key ? key.split(",") : [];
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ sub: symsRef.current }));
  }, [key]);

  return { prices, connected };
}
