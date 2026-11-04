"use client";

import type { Candle, LiveStep, Timeframe } from "@platform/charts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FIGURE_TFS, getCandles, getDerivatives, getFigures, getLayers, getPatterns, toCandle, type Derivatives, type FiguresResponse, type LayersResponse, type PatternsResponse } from "@/lib/chart";
import { LiveBar } from "@/lib/liveBar";
import { useLive, type LiveCandle, type LiveTick } from "@/lib/useLive";

/**
 * Текущая свеча в состоянии React (индикаторы, отсчёт) — не чаще этого; график получает каждое событие
 * сразу через `live` (ADR-0010), закрытие свечи — в React немедленно.
 */
export const CURRENT_STATE_MS = 5000;

/**
 * Свечи инструмента/таймфрейма: первая порция, подгрузка влево, живая текущая свеча по WebSocket
 * (тики раз в секунду, формирующаяся и закрытые минуты — через автомат LiveBar).
 */
export function useTerminalData(symbol: string, tf: Timeframe, token: string | null) {
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [hasOlder, setHasOlder] = useState(true);
  const [current, setCurrent] = useState<Candle | null>(null);
  const [layers, setLayers] = useState<LayersResponse | null>(null);
  const [derivatives, setDerivatives] = useState<Derivatives | null>(null);
  const [patterns, setPatterns] = useState<PatternsResponse | null>(null);
  const [figures, setFigures] = useState<FiguresResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState<string | null>(null);
  const loadingOlder = useRef(false);
  // живая свеча — своя на инструмент и таймфрейм; до загрузки свечей события её не трогают
  const live = useMemo(() => new LiveBar(symbol, tf), [symbol, tf]);
  const currentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let dead = false;
    queueMicrotask(() => {
      if (dead) return;
      setCandles(null);
      setCurrent(null);
      setLayers(null);
      setDerivatives(null);
      setPatterns(null);
      setFigures(null);
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
        live.start(cur);
        setCurrent(cur);
        getPatterns(symbol, tf, closed[0]?.time)
          .then((pr) => !dead && setPatterns(pr))
          .catch(() => {});
        if (FIGURE_TFS.includes(tf))
          getFigures(symbol, tf, closed[0]?.time)
            .then((fr) => !dead && setFigures(fr))
            .catch(() => {});
      })
      .catch((e: Error) => !dead && setError(e.message));
    getLayers(symbol, tf)
      .then((r) => !dead && setLayers(r))
      .catch(() => {});
    getDerivatives(symbol, tf)
      .then((r) => !dead && setDerivatives(r))
      .catch(() => {});
    return () => {
      dead = true;
      if (currentTimer.current) clearTimeout(currentTimer.current);
      currentTimer.current = null;
    };
  }, [symbol, tf, live]);

  const loadOlder = useCallback(
    async (before: number) => {
      if (loadingOlder.current || !hasOlder) return null;
      loadingOlder.current = true;
      try {
        const r = await getCandles(symbol, tf, before);
        setHasOlder(r.has_older);
        const older = r.candles.filter((c) => !c.open).map(toCandle);
        if (older.length)
          getPatterns(symbol, tf, older[0]!.time, before)
            .then((pr) => setPatterns((prev) => (prev ? { ...prev, items: [...pr.items.filter((x) => !prev.items.some((y) => y.id === x.id)), ...prev.items], stats: { ...pr.stats, ...prev.stats } } : pr)))
            .catch(() => {});
        return { candles: older, hasOlder: r.has_older };
      } finally {
        loadingOlder.current = false;
      }
    },
    [symbol, tf, hasOlder],
  );

  // график уже обновлён подписчиком live; здесь — история и текущая свеча для React
  const onStep = useCallback(
    (step: LiveStep | null) => {
      if (!step) return;
      const closed = step.closed;
      const amended = step.amended;
      if (closed.length || amended)
        setCandles((prev) => {
          if (!prev) return prev;
          let next = prev;
          // уточнение последней закрытой свечи (запоздавшая минута) — замена на месте
          if (amended && next.length && next[next.length - 1]!.time === amended.time) next = [...next.slice(0, -1), amended];
          return closed.length ? [...next, ...closed] : next;
        });
      if (closed.length) {
        if (currentTimer.current) clearTimeout(currentTimer.current);
        currentTimer.current = null;
        setCurrent(step.bar);
      } else if (!currentTimer.current)
        currentTimer.current = setTimeout(() => {
          currentTimer.current = null;
          setCurrent(live.bar);
        }, CURRENT_STATE_MS);
    },
    [live],
  );

  const onTick = useCallback((m: LiveTick) => onStep(live.tick(m)), [live, onStep]);
  const onForming = useCallback((m: LiveCandle) => onStep(live.forming(m)), [live, onStep]);
  const onCandle = useCallback((m: LiveCandle) => onStep(live.candle(m)), [live, onStep]);

  const { prices, connected, online } = useLive([symbol], token, { onTick, onForming, onCandle });
  return { candles, current, hasOlder, layers, derivatives, patterns, figures, error, tick, loadOlder, price: prices[symbol]?.p ?? null, connected, online, live };
}
