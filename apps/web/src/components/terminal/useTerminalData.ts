"use client";

import { restThrough, type Candle, type LiveStep, type Timeframe } from "@platform/charts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FIGURE_TFS, getCandles, getDerivatives, getFigures, getLayers, getPatterns, toCandle, type CandlesResponse, type Derivatives, type FiguresResponse, type LayersResponse, type PatternsResponse } from "@/lib/chart";
import { CatchUpGate, LiveBar } from "@/lib/liveBar";
import { useLive, type LiveCandle, type LiveTick, type ResyncReason } from "@/lib/useLive";

/**
 * Текущая свеча в состоянии React (индикаторы, отсчёт) — не чаще этого; график получает каждое событие
 * сразу через `live` (ADR-0010), закрытие свечи — в React немедленно.
 */
export const CURRENT_STATE_MS = 5000;
/** Запас к закрытию свечи, после которого она просрочена и история догружается, с (запись и доставка минуты — 1–2 с). */
export const LIVE_GRACE_S = 8;

/** Время сервера из ответа (unix с); нет или не разобрать — undefined (часы клиента не подставляются). */
function serverTime(r: CandlesResponse): number | undefined {
  const t = Date.parse(r.server_time) / 1000;
  return Number.isFinite(t) ? t : undefined;
}

/**
 * Последняя минута, учтённая ответом целиком: поле through (последняя закрытая минута в БД — текущая свеча свёрнута
 * только из закрытых), у старого API — оценка по времени сервера; без времени сервера — неизвестно (null).
 */
const pageThrough = (r: CandlesResponse, at: number | undefined): number | null => r.through ?? (at !== undefined ? restThrough(at) : null);

/** Закрытые свечи и текущая из ответа истории (у 1m текущая — недописанная минута с флагом open). */
function splitPage(r: CandlesResponse): { closed: Candle[]; current: Candle | null } {
  const open = r.current ?? r.candles.find((c) => c.open) ?? null;
  return { closed: r.candles.filter((c) => !c.open).map(toCandle), current: open ? toCandle(open) : null };
}

const mergePatterns = (prev: PatternsResponse | null, next: PatternsResponse): PatternsResponse =>
  prev ? { ...next, items: [...prev.items.filter((x) => !next.items.some((y) => y.id === x.id)), ...next.items].sort((a, b) => a.t - b.t), stats: { ...prev.stats, ...next.stats } } : next;

/**
 * Свечи инструмента/таймфрейма: первая порция, подгрузка влево и живая свеча (план 2A.3, 2A.7; ADR-0003, ADR-0010).
 * Единственный источник правды — LiveBar: тики раз в секунду, формирующаяся и закрытые минуты сворачиваются его
 * автоматом и сразу уходят графику; история React — его закрытые свечи. Догон правого края — одна очередь
 * (CatchUpGate) на все поводы: сокет открыт заново, вкладка видна при неоткрытом сокете (useLive), пропуск в
 * событиях (gap автомата), просрочка (новой свечи нет дольше закрытия + LIVE_GRACE_S — продовый баг: после фона на
 * iPhone график стоял на свече получасовой давности при «онлайн»). Новая закрытая свеча после догона — слои,
 * производные, паттерны и фигуры заново.
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
  /** Время сервера последней порции истории, unix с (0 — неизвестно): цена из WebSocket не новее её — в шапке цена свечи. */
  const [restAt, setRestAt] = useState(0);
  const loadingOlder = useRef(false);
  // живая свеча — своя на инструмент и таймфрейм; события до загрузки свечей копятся в ней
  const live = useMemo(() => new LiveBar(symbol, tf), [symbol, tf]);
  /** Поколение загрузки: ответ для прошлого инструмента или таймфрейма отбрасывается. */
  const genRef = useRef(0);
  /** since первой порции — для паттернов и фигур при догоне. */
  const sinceRef = useRef<number | undefined>(undefined);
  const currentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Слои, производные, паттерны и фигуры — под новую последнюю закрытую свечу. */
  const refreshDerived = useCallback(
    (gen: number, replace: boolean) => {
      const alive = () => gen === genRef.current;
      getLayers(symbol, tf)
        .then((r) => alive() && setLayers(r))
        .catch(() => {});
      getDerivatives(symbol, tf)
        .then((r) => alive() && setDerivatives(r))
        .catch(() => {});
      getPatterns(symbol, tf, sinceRef.current)
        .then((pr) => alive() && setPatterns((prev) => (replace ? pr : mergePatterns(prev, pr))))
        .catch(() => {});
      if (FIGURE_TFS.includes(tf))
        getFigures(symbol, tf, sinceRef.current)
          .then((fr) => alive() && setFigures(fr))
          .catch(() => {});
    },
    [symbol, tf],
  );

  useEffect(() => {
    let dead = false;
    const gen = ++genRef.current;
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
        if (dead || gen !== genRef.current) return;
        const { closed, current: cur } = splitPage(r);
        const at = serverTime(r);
        // тики, пришедшие раньше свечей, уже в свече и истории; минуты не новее through ответ уже учёл
        const history = live.start(cur, closed, pageThrough(r, at));
        setCandles(history);
        setHasOlder(r.has_older);
        setTick(r.tick_size);
        setRestAt(at ?? 0);
        sinceRef.current = closed[0]?.time;
        setCurrent(live.bar);
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

  /**
   * Догон: свежая порция истории вливается в LiveBar (catchUp: хвост заменяется окончательными свечами, пропущенные
   * дописываются, тики и минуты потока новее ответа остаются); график получает хвост или замену через подписку live.
   * Возвращает, просрочена ли свеча и после ответа — сервер сам отстаёт (пауза просрочки удваивается).
   */
  const catchUp = useCallback(async () => {
    const gen = genRef.current;
    if (!live.started) return false;
    const r = await getCandles(symbol, tf);
    if (gen !== genRef.current) return false;
    const { closed, current: cur } = splitPage(r);
    const at = serverTime(r);
    const lastBefore = live.closed.at(-1)?.time;
    const ev = live.catchUp(closed, cur, pageThrough(r, at), at, r.has_older);
    setRestAt(at ?? 0);
    if (ev) {
      setCandles(live.closed);
      setCurrent(live.bar);
      if (ev.reset) {
        setHasOlder(r.has_older);
        sinceRef.current = closed[0]?.time;
      }
    }
    if (live.closed.at(-1)?.time !== lastBefore) refreshDerived(gen, !!ev?.reset);
    const due = live.dueAt(LIVE_GRACE_S);
    return due !== null && due * 1000 <= Date.now();
  }, [live, symbol, tf, refreshDerived]);
  // очередь догона — своя у каждой живой свечи (инструмент, таймфрейм)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- новая очередь вместе с live
  const gate = useMemo(() => new CatchUpGate(), [live]);

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
      // закрытые и уточнённая закрытая (запоздавшая минута, свеча истории) — в истории LiveBar
      if (step.closed.length || step.amended) setCandles(live.closed);
      if (step.closed.length) {
        if (currentTimer.current) clearTimeout(currentTimer.current);
        currentTimer.current = null;
        setCurrent(step.bar);
      } else if (!currentTimer.current)
        currentTimer.current = setTimeout(() => {
          currentTimer.current = null;
          setCurrent(live.bar);
        }, CURRENT_STATE_MS);
      // пропущенные свечи или минуты (сон, обрыв) — свежая история с сервера
      if (step.gap) gate.request("gap", catchUp);
    },
    [live, gate, catchUp],
  );

  const onTick = useCallback((m: LiveTick) => onStep(live.tick(m)), [live, onStep]);
  const onForming = useCallback((m: LiveCandle) => onStep(live.forming(m)), [live, onStep]);
  const onCandle = useCallback((m: LiveCandle) => onStep(live.candle(m)), [live, onStep]);
  // сокет открыт заново или вкладка видна при неоткрытом сокете (решает LiveSocket.wake) — догон
  const onResync = useCallback((reason: ResyncReason) => gate.request(reason, catchUp), [gate, catchUp]);

  const { prices, connected, online } = useLive([symbol], token, { onTick, onForming, onCandle, onResync });

  // просрочка: новой свечи нет дольше закрытия текущей (или следующей минуты на 1m) — догон, пока вкладка видна
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const due = live.dueAt(LIVE_GRACE_S);
      if (due !== null && Date.now() / 1000 > due) gate.request("overdue", catchUp);
    }, 1000);
    return () => clearInterval(timer);
  }, [live, gate, catchUp]);

  // цена из WebSocket — если она новее последней порции истории; иначе шапка берёт закрытие последней свечи
  const lp = prices[symbol];
  const liveAt = lp ? Date.parse(lp.at) / 1000 : Number.NaN;
  const price = lp && !(liveAt <= restAt) ? lp.p : null;
  return { candles, current, hasOlder, layers, derivatives, patterns, figures, error, tick, loadOlder, price, connected, online, live };
}
