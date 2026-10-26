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
    void connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      if (ping) clearInterval(ping);
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
