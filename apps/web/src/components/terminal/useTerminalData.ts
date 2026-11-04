"use client";

import type { Candle, LiveStep, Timeframe } from "@platform/charts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FIGURE_TFS, getCandles, getDerivatives, getFigures, getLayers, getPatterns, toCandle, type CandlesResponse, type Derivatives, type FiguresResponse, type LayersResponse, type PatternsResponse } from "@/lib/chart";
import { binanceFeed } from "@/lib/binanceFeed";
import { CatchUpGate, LiveBar, type CatchUpResult } from "@/lib/liveBar";
import { HeaderPrice, LiveMux, type PriceSource } from "@/lib/liveSource";
import { useLive, type ResyncReason } from "@/lib/useLive";

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

/** Закрытые свечи и текущая из ответа истории (у 1m текущая — недописанная минута с флагом open). */
function splitPage(r: CandlesResponse): { closed: Candle[]; current: Candle | null } {
  const open = r.current ?? r.candles.find((c) => c.open) ?? null;
  return { closed: r.candles.filter((c) => !c.open).map(toCandle), current: open ? toCandle(open) : null };
}

const mergePatterns = (prev: PatternsResponse | null, next: PatternsResponse): PatternsResponse =>
  prev ? { ...next, items: [...prev.items.filter((x) => !next.items.some((y) => y.id === x.id)), ...next.items].sort((a, b) => a.t - b.t), stats: { ...prev.stats, ...next.stats } } : next;

/**
 * Свечи инструмента/таймфрейма: первая порция, подгрузка влево и живая свеча (план 2A.3, 2A.7; ADR-0003, ADR-0010).
 * Единственный источник правды — LiveBar: сделки и минуты с биржи напрямую (BinanceFeed) или, пока биржа недоступна
 * или молчит, тики раз в секунду и минуты сервера (выбор — LiveMux) сворачиваются его автоматом и сразу уходят графику;
 * история React — его закрытые свечи, цена шапки — HeaderPrice (шапка подписана сама). Догон правого края — одна очередь
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
  /** Биржа — основной источник цены символа (данные за последние 5 с). */
  const [binanceOn, setBinanceOn] = useState(false);
  const loadingOlder = useRef(false);
  // живая свеча — своя на инструмент и таймфрейм; события до загрузки свечей копятся в ней
  const live = useMemo(() => new LiveBar(symbol, tf), [symbol, tf]);
  // цена шапки — своя у каждой живой свечи; время сервера последней порции истории (restAt) — цена не новее его в шапке
  // не показывается
  // eslint-disable-next-line react-hooks/exhaustive-deps -- новая цена вместе с live
  const prices = useMemo(() => new HeaderPrice(), [live]);
  useEffect(() => () => prices.dispose(), [prices]);
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

  /**
   * Догон: свежая порция истории вливается в LiveBar (catchUp: хвост заменяется окончательными свечами, пропущенные
   * дописываются, тики и минуты потока новее ответа остаются); график получает хвост или замену через подписку live.
   * Возвращает, просрочена ли свеча и после ответа — сервер сам отстаёт (пауза просрочки удваивается).
   */
  const catchUp = useCallback(async (): Promise<CatchUpResult> => {
    const gen = genRef.current;
    if (!live.started) return {};
    const r = await getCandles(symbol, tf);
    if (gen !== genRef.current) return {};
    const { closed, current: cur } = splitPage(r);
    const at = serverTime(r);
    const lastBefore = live.closed.at(-1)?.time;
    const ev = live.catchUp(closed, cur, r.through, at, r.has_older);
    prices.setRestAt(at ?? 0);
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
    // ответ старее потока с дырами — ещё один догон (CatchUpGate: ровно один повтор)
    return { late: due !== null && due * 1000 <= Date.now(), again: live.takeResync() };
  }, [live, symbol, tf, refreshDerived, prices]);
  // очередь догона — своя у каждой живой свечи (инструмент, таймфрейм)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- новая очередь вместе с live
  const gate = useMemo(() => new CatchUpGate(), [live]);

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
        const history = live.start(cur, closed, r.through, at);
        setCandles(history);
        setHasOlder(r.has_older);
        setTick(r.tick_size);
        prices.setRestAt(at ?? 0);
        sinceRef.current = closed[0]?.time;
        setCurrent(live.bar);
        getPatterns(symbol, tf, closed[0]?.time)
          .then((pr) => !dead && setPatterns(pr))
          .catch(() => {});
        if (FIGURE_TFS.includes(tf))
          getFigures(symbol, tf, closed[0]?.time)
            .then((fr) => !dead && setFigures(fr))
            .catch(() => {});
        // пропуск в событиях до загрузки, переподключение или возврат вкладки до неё — догон сразу
        if (live.takeResync()) gate.request("gap", catchUp);
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
  }, [symbol, tf, live, gate, catchUp, prices]);

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

  // источник событий символа: биржа, пока свежа, иначе сервер — в тот же LiveBar (ADR-0010, дополнение)
  const mux = useMemo(() => new LiveMux(symbol, live, () => binanceFeed()?.isFresh(symbol) ?? false), [symbol, live]);
  useEffect(() => {
    mux.attach({ step: onStep, price: (p) => prices.push(p), source: (s) => setBinanceOn(s === "binance") });
    return () => mux.attach(null);
  }, [mux, onStep, prices]);
  // одно соединение с биржей на страницу: символ терминала и ячеек мультичарта; смена символа — SUBSCRIBE/UNSUBSCRIBE
  useEffect(() => binanceFeed()?.subscribe(symbol, mux.binance), [symbol, mux]);
  // сокет открыт заново или вкладка видна при неоткрытом сокете (решает LiveSocket.wake) — догон; до загрузки свечей —
  // сразу после неё (ответ мог быть прочитан до обрыва)
  const onResync = useCallback(
    (reason: ResyncReason) => {
      if (live.started) gate.request(reason, catchUp);
      else live.resyncLater();
    },
    [live, gate, catchUp],
  );

  // сокет сервера — всегда: сигналы, статусы и запасной источник цены; цены в состояние React не копит (шапка — prices)
  const { connected, online: serverOnline, resyncPending } = useLive([symbol], token, { onTick: mux.serverTick, onForming: mux.serverForming, onCandle: mux.serverCandle, onPrice: mux.serverPrice, onResync }, { prices: false });

  // просрочка: новой свечи нет дольше закрытия текущей (или следующей минуты на 1m) — догон, пока вкладка видна; пока
  // открывается сокет, сменивший прежний (возврат с полуоткрытым сокетом), — ждём: его открытие и есть догон
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible" || resyncPending()) return;
      const due = live.dueAt(LIVE_GRACE_S);
      if (due !== null && Date.now() / 1000 > due) gate.request("overdue", catchUp);
    }, 1000);
    return () => clearInterval(timer);
  }, [live, gate, catchUp, resyncPending]);

  // «онлайн» — цена живая из любого источника; подсказка говорит, из какого
  const online = serverOnline || binanceOn;
  const source: PriceSource = binanceOn ? "binance" : "server";
  return { candles, current, hasOlder, layers, derivatives, patterns, figures, error, tick, loadOlder, prices, connected, online, source, live };
}
