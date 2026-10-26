"use client";

import { foldMinute, type Candle, type Timeframe } from "@platform/charts";
import { useCallback, useEffect, useRef, useState } from "react";
import { getCandles, getLayers, toCandle, type LayersResponse } from "@/lib/chart";
import { useLive, type LiveCandle } from "@/lib/useLive";

/** Свечи инструмента/таймфрейма: первая порция, подгрузка влево, текущая свеча из минутных по WebSocket. */
export function useTerminalData(symbol: string, tf: Timeframe, token: string | null) {
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [hasOlder, setHasOlder] = useState(true);
  const [current, setCurrent] = useState<Candle | null>(null);
  const [layers, setLayers] = useState<LayersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState<string | null>(null);
  const loadingOlder = useRef(false);
  const currentRef = useRef<Candle | null>(null);

  useEffect(() => {
    let dead = false;
    currentRef.current = null;
    queueMicrotask(() => {
      if (dead) return;
      setCandles(null);
      setCurrent(null);
      setLayers(null);
      setError(null);
    });
    getCandles(symbol, tf)
      .then((r) => {
        if (dead) return;
        const closed = r.candles.filter((c) => !c.open).map(toCandle);
        const open = r.current ?? r.candles.find((c) => c.open) ?? null;
        setCandles(closed);
        setHasOlder(r.has_older);
        setTick(r.tick_size);
        const cur = open ? toCandle(open) : null;
        currentRef.current = cur;
        setCurrent(cur);
      })
      .catch((e: Error) => !dead && setError(e.message));
    getLayers(symbol, tf)
      .then((r) => !dead && setLayers(r))
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [symbol, tf]);

  const loadOlder = useCallback(
    async (before: number) => {
      if (loadingOlder.current || !hasOlder) return null;
      loadingOlder.current = true;
      try {
        const r = await getCandles(symbol, tf, before);
        setHasOlder(r.has_older);
        return { candles: r.candles.filter((c) => !c.open).map(toCandle), hasOlder: r.has_older };
      } finally {
        loadingOlder.current = false;
      }
    },
    [symbol, tf, hasOlder],
  );

  const onCandle = useCallback(
    (m: LiveCandle) => {
      if (m.s !== symbol) return;
      const m1 = toCandle({ ...m.c, open: false });
      const next = foldMinute(currentRef.current, m1, tf);
      if (currentRef.current && next.time !== currentRef.current.time) {
        // предыдущая свеча tf закрылась — переносим её в историю
        const closed = { ...currentRef.current, open_: false };
        setCandles((prev) => (prev ? [...prev, closed] : prev));
      }
      currentRef.current = next;
      setCurrent(next);
    },
    [symbol, tf],
  );

  const { prices, connected } = useLive([symbol], token, undefined, onCandle);
  return { candles, current, hasOlder, layers, error, tick, loadOlder, price: prices[symbol]?.p ?? null, connected };
}
