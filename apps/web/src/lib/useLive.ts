"use client";

/**
 * WebSocket к /v1/ws (через тот же домен): живые цены по подписанным инструментам и
 * смена статусов сигналов. Переподключение с задержкой, без анимаций — просто новые числа.
 */
import { useEffect, useRef, useState } from "react";

export type LiveSignal = { id: string; instrument_id: number; status: string; at: string };

type Msg =
  | { t: "price"; s: string; p: string; at: string }
  | { t: "signal"; id: string; instrument_id: number; status: string; at: string }
  | { t: "subscribed"; n: number }
  | { t: "pong" };

export function useLive(symbols: string[], token: string | null, onSignal?: (s: LiveSignal) => void) {
  const [prices, setPrices] = useState<Record<string, { p: string; at: string }>>({});
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const symsRef = useRef<string[]>(symbols);
  const onSignalRef = useRef(onSignal);
  useEffect(() => {
    onSignalRef.current = onSignal;
  }, [onSignal]);
  const key = symbols.slice().sort().join(",");

  useEffect(() => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;

    function connect() {
      if (closed) return;
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const url = `${proto}://${window.location.host}/v1/ws${token ? `?token=${encodeURIComponent(token)}` : ""}`;
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
      };
      ws.onclose = () => {
        setConnected(false);
        if (ping) clearInterval(ping);
        if (!closed) timer = setTimeout(connect, 3000 + Math.random() * 2000);
      };
      ws.onerror = () => ws.close();
    }
    connect();
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
