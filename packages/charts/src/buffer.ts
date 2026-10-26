import type { Candle } from "./types";

export const MAX_CANDLES = 5000;
export const PAGE = 500;
export const EDGE = 100;
/** За сколько свечей до левого края просим следующую порцию. */

export type BufferState = {
  candles: Candle[];
  /** Слева ещё есть история на сервере. */
  hasOlder: boolean;
  /** Справа выгружены свежие свечи (ушли далеко влево) — при возврате вправо их надо перезагрузить. */
  trimmedRight: number;
};

/**
 * Окно свечей в памяти (план 2A.7): не больше MAX_CANDLES, подгрузка порциями по PAGE влево,
 * выгрузка старых при движении вправо. Чистые функции над состоянием — без побочных эффектов.
 */
export function createBuffer(candles: Candle[] = [], hasOlder = true): BufferState {
  return { candles: sortUnique(candles), hasOlder, trimmedRight: 0 };
}

function sortUnique(candles: Candle[]): Candle[] {
  const map = new Map<number, Candle>();
  for (const c of candles) map.set(c.time, c);
  return [...map.values()].sort((a, b) => a.time - b.time);
}

/** Пришла порция старых свечей (все старше первой в буфере). Лишнее справа выгружается. */
export function prependOlder(state: BufferState, older: Candle[], hasOlder: boolean): BufferState {
  const first = state.candles[0]?.time ?? Infinity;
  const merged = [...sortUnique(older).filter((c) => c.time < first), ...state.candles];
  const over = Math.max(0, merged.length - MAX_CANDLES);
  return {
    candles: over ? merged.slice(0, merged.length - over) : merged,
    hasOlder,
    trimmedRight: state.trimmedRight + over,
  };
}

/** Новая или обновлённая (текущая) свеча справа. Лишнее слева выгружается. */
export function pushLatest(state: BufferState, c: Candle): BufferState {
  if (state.trimmedRight > 0) return state; // правый край неактуален — ждём перезагрузки
  const candles = state.candles.slice();
  const last = candles[candles.length - 1];
  if (last && last.time === c.time) candles[candles.length - 1] = c;
  else if (!last || c.time > last.time) candles.push(c);
  else return state; // свеча из середины — игнорируем, история не переписывается
  const over = Math.max(0, candles.length - MAX_CANDLES);
  return { ...state, candles: over ? candles.slice(over) : candles, hasOlder: state.hasOlder || over > 0 };
}

/** Пользователь вернулся к правому краю: подменяем правую часть свежей историей. */
export function replaceNewest(state: BufferState, newest: Candle[]): BufferState {
  const merged = sortUnique([...state.candles, ...newest]);
  const over = Math.max(0, merged.length - MAX_CANDLES);
  return { candles: over ? merged.slice(over) : merged, hasOlder: state.hasOlder || over > 0, trimmedRight: 0 };
}

/** Нужна ли порция слева для видимого диапазона (индексы логической шкалы). */
export function needsOlder(state: BufferState, visibleFrom: number): boolean {
  return state.hasOlder && visibleFrom < EDGE;
}

/** Нужна ли перезагрузка правого края. */
export function needsNewer(state: BufferState, visibleTo: number): boolean {
  return state.trimmedRight > 0 && visibleTo > state.candles.length - EDGE;
}
