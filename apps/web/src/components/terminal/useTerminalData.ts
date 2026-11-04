"use client";

import { applyMinute, catchUpLive, firstChange, liveDueAt, minuteNeedsHistory, restThrough, type Candle, type LiveBars, type Timeframe } from "@platform/charts";
import { useCallback, useEffect, useRef, useState } from "react";
import { FIGURE_TFS, getCandles, getDerivatives, getFigures, getLayers, getPatterns, toCandle, type CandlesResponse, type Derivatives, type FiguresResponse, type LayersResponse, type PatternsResponse } from "@/lib/chart";
import { useLive, type LiveCandle } from "@/lib/useLive";

/** Запас к закрытию свечи, после которого она просрочена и история догружается, с (запись и доставка минуты — 1–2 с). */
const LIVE_GRACE_S = 8;
/** Догон по просрочке — не чаще, мс; если сервер сам отстаёт, пауза удваивается до LIVE_BACKOFF_MAX_MS. */
const LIVE_RETRY_MS = 15_000;
const LIVE_BACKOFF_MAX_MS = 300_000;
/** Догоны по событиям (возврат вкладки, переподключение) ближе этого друг к другу — один, мс. */
const CATCH_UP_DEDUP_MS = 2_000;

/** Время сервера из ответа (unix с); без него — часы клиента. */
function serverTime(r: CandlesResponse): number {
  const t = Date.parse(r.server_time) / 1000;
  return Number.isFinite(t) ? t : Date.now() / 1000;
}

/**
 * Последняя минута, учтённая ответом целиком: поле through (последняя закрытая минута в БД — текущая свеча
 * свёрнута только из закрытых), у старого API — оценка по времени сервера.
 */
const pageThrough = (r: CandlesResponse, at: number): number => r.through ?? restThrough(at);

/** Закрытые свечи и текущая из ответа истории (у 1m текущая — недописанная минута с флагом open). */
function splitPage(r: CandlesResponse): { closed: Candle[]; current: Candle | null } {
  const open = r.current ?? r.candles.find((c) => c.open) ?? null;
  return { closed: r.candles.filter((c) => !c.open).map(toCandle), current: open ? toCandle(open) : null };
}

const mergePatterns = (prev: PatternsResponse | null, next: PatternsResponse): PatternsResponse =>
  prev ? { ...next, items: [...prev.items.filter((x) => !next.items.some((y) => y.id === x.id)), ...next.items].sort((a, b) => a.t - b.t), stats: { ...prev.stats, ...next.stats } } : next;

/**
 * Свечи инструмента/таймфрейма: первая порция, подгрузка влево, текущая свеча из минутных по WebSocket и догон
 * правого края (продовый баг: после фона на iPhone график стоял на свече получасовой давности при «онлайн»):
 * свежая порция истории сливается с концом, когда вкладка снова видна, когда переподключился WebSocket и когда
 * текущая свеча просрочена (liveDueAt) — новой свечи нет дольше её закрытия плюс LIVE_GRACE_S.
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
  /** Время сервера последней порции истории, unix с: цена из WebSocket не новее её — в шапке цена свечи. */
  const [restAt, setRestAt] = useState(0);
  const loadingOlder = useRef(false);
  /** Свечи из живого потока — источник правды для candles/current (минуты и догон считаются от него). */
  const liveRef = useRef<LiveBars | null>(null);
  /** Поколение загрузки: ответ для прошлого инструмента или таймфрейма отбрасывается. */
  const genRef = useRef(0);
  /** since первой порции — для паттернов и фигур при догоне. */
  const sinceRef = useRef<number | undefined>(undefined);
  const catchUpRef = useRef({ busy: false, at: 0, backoff: LIVE_RETRY_MS });

  const commit = useCallback((next: LiveBars) => {
    const prev = liveRef.current;
    liveRef.current = next;
    if (!prev || prev.closed !== next.closed) setCandles(next.closed as Candle[]);
    if (!prev || prev.current !== next.current) setCurrent(next.current);
  }, []);

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
    liveRef.current = null;
    catchUpRef.current = { busy: false, at: 0, backoff: LIVE_RETRY_MS };
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
        const st = serverTime(r);
        setHasOlder(r.has_older);
        setTick(r.tick_size);
        setRestAt(st);
        sinceRef.current = closed[0]?.time;
        commit({ closed, current: cur, through: pageThrough(r, st) });
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
    };
  }, [symbol, tf, commit]);

  /**
   * Догон: свежая порция истории (последние свечи) сливается с концом — хвост заменяется окончательными свечами,
   * пропущенные дописываются, времена не повторяются (mergeLive). Порция не стыкуется с историей (разрыв длиннее
   * порции) — история заменяется порцией, свечи потока новее неё остаются (catchUpLive). Новая закрытая свеча —
   * слои, производные, паттерны и фигуры заново.
   */
  const catchUp = useCallback(
    async (overdue = false) => {
      const st = catchUpRef.current;
      if (!liveRef.current || st.busy) return;
      if (!overdue && Date.now() - st.at < CATCH_UP_DEDUP_MS) return;
      const gen = genRef.current;
      st.busy = true;
      st.at = Date.now();
      try {
        const r = await getCandles(symbol, tf);
        const base = liveRef.current;
        if (gen !== genRef.current || !base) return;
        const { closed, current: cur } = splitPage(r);
        const at = serverTime(r);
        const { bars: next, replaced } = catchUpLive(base, closed, cur, pageThrough(r, at), tf);
        if (replaced) {
          setHasOlder(r.has_older);
          sinceRef.current = closed[0]?.time;
        }
        // ничего нового (вкладка вернулась, а свечи те же) — без перерисовки; иначе новая ссылка на закрытые
        // свечи: поверхность сверит хвост и уберёт устаревшую текущую
        const unchanged = next.closed.length === base.closed.length && firstChange(base.closed, next.closed) === base.closed.length && (next.current === base.current || (next.current !== null && base.current !== null && firstChange([base.current], [next.current]) === 1));
        if (!unchanged) commit({ ...next, closed: next.closed === base.closed ? next.closed.slice() : next.closed });
        else liveRef.current = { ...base, through: next.through };
        setRestAt(at);
        if (next.closed[next.closed.length - 1]?.time !== base.closed[base.closed.length - 1]?.time) refreshDerived(gen, replaced);
        // сервер и сам ещё без новой свечи — следующая попытка позже, вплоть до LIVE_BACKOFF_MAX_MS
        const due = liveDueAt(next, tf, LIVE_GRACE_S);
        st.backoff = due !== null && due * 1000 <= Date.now() ? Math.min(st.backoff * 2, LIVE_BACKOFF_MAX_MS) : LIVE_RETRY_MS;
      } catch {
        // сеть недоступна — следующая попытка по таймеру просрочки или событию
      } finally {
        st.busy = false;
      }
    },
    [symbol, tf, commit, refreshDerived],
  );

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

  const onCandle = useCallback(
    (m: LiveCandle) => {
      if (m.s !== symbol) return;
      const s = liveRef.current;
      // до первой порции минута не нужна: история её уже содержит
      if (!s) return;
      const m1 = toCandle({ ...m.c, open: false });
      const next = applyMinute(s, m1, tf);
      if (next) commit(next);
      // пропуск минут (приложение спало, догон не удался) или минута уже закрытой свечи, которой нет в истории
      if (minuteNeedsHistory(s, m1, tf)) void catchUp(true);
    },
    [symbol, tf, commit, catchUp],
  );

  const { prices, connected } = useLive([symbol], token, undefined, onCandle);

  // вкладка снова видна (iPhone: приложение из фона), страница из кэша, сеть вернулась — догон
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void catchUp();
    };
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) void catchUp();
    };
    const onOnline = () => void catchUp();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onShow);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onShow);
      window.removeEventListener("online", onOnline);
    };
  }, [catchUp]);

  // WebSocket переподключился: минуты, пока его не было, не придут — догон
  const connRef = useRef({ was: false, ever: false });
  useEffect(() => {
    const c = connRef.current;
    if (connected && !c.was && c.ever) void catchUp();
    c.was = connected;
    if (connected) c.ever = true;
  }, [connected, catchUp]);

  // просрочка: новой свечи нет дольше закрытия текущей (или следующей минуты на 1m) — догон, пока вкладка видна
  useEffect(() => {
    const timer = setInterval(() => {
      const s = liveRef.current;
      const st = catchUpRef.current;
      if (!s || st.busy || document.visibilityState !== "visible") return;
      const due = liveDueAt(s, tf, LIVE_GRACE_S);
      if (due === null || Date.now() / 1000 <= due || Date.now() - st.at < st.backoff) return;
      void catchUp(true);
    }, 1000);
    return () => clearInterval(timer);
  }, [tf, catchUp]);

  // цена из WebSocket — если она новее последней порции истории; иначе шапка берёт закрытие последней свечи
  const live = prices[symbol];
  const liveAt = live ? Date.parse(live.at) / 1000 : NaN;
  const price = live && !(liveAt <= restAt) ? live.p : null;
  return { candles, current, hasOlder, layers, derivatives, patterns, figures, error, tick, loadOlder, price, connected };
}
