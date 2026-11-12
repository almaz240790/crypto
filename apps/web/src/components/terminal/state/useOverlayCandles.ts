import { useEffect, useState } from "react";
import type { Candle, Timeframe } from "@platform/charts";
import { getCandles, toCandle } from "@/lib/chart";

/**
 * Свечи наложенного инструмента для сравнения (план 2A.3 v2): закрытые свечи цели на том же таймфрейме.
 *
 * Раньше это был разовый снимок последних 500 свечей. Линия сравнения отставала на свечу с каждым закрытием
 * (в легенде — одно и то же закрытие, под перекрестием на новых свечах — «—»), а после подгрузки истории основного
 * инструмента начиналась посреди экрана: в процентной шкале проценты двух инструментов считались от разных свечей.
 * Теперь наложение следует за основным буфером: дополняется хвостом на каждой новой закрытой свече основного
 * инструмента и догружается влево, пока не покроет его первую свечу (или пока у цели есть история).
 */

export type OverlayState = { key: string; candles: Candle[]; hasOlder: boolean };
export type OverlayNeed = { kind: "first" | "tail" } | { kind: "older"; before: number } | null;

/** Свечи двух порций по возрастанию времени без повторов; у совпавшего времени — свеча новой порции. */
export function mergeCandles(base: readonly Candle[], fresh: readonly Candle[]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const c of base) byTime.set(c.time, c);
  for (const c of fresh) byTime.set(c.time, c);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/**
 * Что догрузить наложению, чтобы оно покрывало буфер основного инструмента [mainFirst; mainLast] (времена первой
 * и последней закрытой свечи): первую порцию; хвост — основная свеча закрылась позже последней свечи наложения;
 * историю слева — буфер начинается раньше наложения и у цели есть свечи старше. null — догружать нечего.
 */
export function overlayNeed(state: OverlayState | null, mainFirst: number | null, mainLast: number | null): OverlayNeed {
  if (!state) return { kind: "first" };
  const first = state.candles[0]?.time;
  const last = state.candles[state.candles.length - 1]?.time;
  if (first === undefined || last === undefined) return null;
  if (mainLast !== null && mainLast > last) return { kind: "tail" };
  if (mainFirst !== null && mainFirst < first && state.hasOlder) return { kind: "older", before: first };
  return null;
}

/** Состояние после порции: свечи слиты; «есть ли история старше» меняет только порция истории (и первая). */
export function applyPage(state: OverlayState | null, key: string, need: NonNullable<OverlayNeed>, candles: readonly Candle[], hasOlder: boolean): OverlayState {
  const base = state && state.key === key ? state : null;
  // порция истории без новых свечей при has_older = true — дыра в данных цели: дальше не запрашиваем (не зацикливаемся)
  const olderEmpty = need.kind === "older" && !candles.some((c) => c.time < need.before);
  return {
    key,
    candles: mergeCandles(base?.candles ?? [], candles),
    hasOlder: need.kind === "tail" ? (base?.hasOlder ?? hasOlder) : hasOlder && !olderEmpty,
  };
}

/** Повтор хвоста, пока свеча цели, уже закрытая у основного инструмента, не окончательная (tailPending), мс. */
export const TAIL_RETRY_MS = 2000;
/** Повторов хвоста не больше (≈ 20 с — дольше REST-опроса минут, 15 с); дальше — со следующей закрытой свечой. */
export const TAIL_RETRIES = 10;

/**
 * Хвост пришёл без окончательной свечи, которую основной инструмент уже закрыл (не новее mainLast): сервер отдаёт только
 * что закрытую по времени свечу текущей (open), пока её последняя минута не записана закрытой — до секунды, при
 * REST-опросе до 15 с (ADR-0003, chart-data-live-2). Закрытие основного и запрос хвоста приходятся как раз на это окно:
 * без повтора линия сравнения отставала бы на свечу до следующего закрытия (на 4h — 4 часа).
 */
export function tailPending(candles: readonly { t: number; open?: boolean }[], mainLast: number | null): boolean {
  return mainLast !== null && candles.some((c) => c.open && c.t <= mainLast);
}

/**
 * symbol — наложенный инструмент (null — сравнения нет); mainFirst / mainLast — времена первой и последней закрытой
 * свечи буфера основного инструмента. Возвращает закрытые свечи цели по возрастанию времени или null (нет сравнения,
 * первая порция ещё не пришла, первая порция не загрузилась).
 */
export function useOverlayCandles(symbol: string | null, tf: Timeframe, mainFirst: number | null, mainLast: number | null): Candle[] | null {
  const [state, setState] = useState<OverlayState | null>(null);
  const key = symbol ? `${symbol}:${tf}` : null;
  const current = state && state.key === key ? state : null;
  const need = key ? overlayNeed(current, mainFirst, mainLast) : null;
  const kind = need?.kind ?? null;
  const before = need?.kind === "older" ? need.before : undefined;
  // повторы хвоста — свои у каждой закрытой свечи основного инструмента
  const [retry, setRetry] = useState<{ last: number | null; n: number }>({ last: null, n: 0 });
  const attempt = retry.last === mainLast ? retry.n : 0;
  useEffect(() => {
    if (!symbol || !key || !kind) return;
    let dead = false;
    let again: ReturnType<typeof setTimeout> | undefined;
    const asked: NonNullable<OverlayNeed> = kind === "older" ? { kind, before: before! } : { kind };
    getCandles(symbol, tf, before)
      .then((r) => {
        if (dead) return;
        const candles = r.candles.filter((c) => !c.open).map(toCandle);
        setState((prev) => applyPage(prev, key, asked, candles, r.has_older));
        if (asked.kind === "tail" && attempt < TAIL_RETRIES && tailPending(r.candles, mainLast)) again = setTimeout(() => setRetry({ last: mainLast, n: attempt + 1 }), TAIL_RETRY_MS);
      })
      // сбой порции: наложение остаётся каким было; следующая закрытая свеча основного инструмента повторит запрос
      .catch(() => undefined);
    return () => {
      dead = true;
      clearTimeout(again);
    };
    // mainLast — в зависимостях: хвост запрашивается заново на каждой новой закрытой свече, даже если прошлый
    // запрос ничего не добавил (у цели свеча ещё не записана) или не удался; attempt — повтор недописанного хвоста
  }, [symbol, tf, key, kind, before, mainLast, attempt]);
  return current && current.candles.length ? current.candles : null;
}
