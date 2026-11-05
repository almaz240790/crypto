import type { Candle } from "./types";

export const MAX_CANDLES = 5000;
export const PAGE = 500;
/** За сколько свечей до левого края просим следующую порцию. */
export const EDGE = 100;

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

/**
 * Пришла порция старых свечей (все старше первой в буфере). Свежие свечи справа никогда не выгружаются:
 * если буфер полон, из порции берётся только самая новая часть, а дальше влево история не грузится
 * (needsOlder молчит), — иначе живые обновления перестали бы попадать на график.
 */
export function prependOlder(state: BufferState, older: Candle[], hasOlder: boolean): BufferState {
  const first = state.candles[0]?.time ?? Infinity;
  const fresh = sortUnique(older).filter((c) => c.time < first);
  const room = Math.max(0, MAX_CANDLES - state.candles.length);
  const kept = fresh.slice(Math.max(0, fresh.length - room));
  return {
    candles: [...kept, ...state.candles],
    hasOlder: hasOlder || kept.length < fresh.length,
    trimmedRight: state.trimmedRight,
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

/**
 * Уточнение уже закрытой свечи с тем же временем (запоздавшая минута после первого тика следующего
 * интервала, ADR-0010). Нет такой свечи — состояние то же; порядок и длина не меняются.
 */
export function replaceAt(state: BufferState, c: Candle): BufferState {
  const candles = state.candles;
  for (let i = candles.length - 1; i >= 0 && candles[i]!.time >= c.time; i--) {
    if (candles[i]!.time !== c.time) continue;
    const next = candles.slice();
    next[i] = c;
    return { ...state, candles: next };
  }
  return state;
}

/** Пользователь вернулся к правому краю: подменяем правую часть свежей историей. */
export function replaceNewest(state: BufferState, newest: Candle[]): BufferState {
  const merged = sortUnique([...state.candles, ...newest]);
  const over = Math.max(0, merged.length - MAX_CANDLES);
  return { candles: over ? merged.slice(over) : merged, hasOlder: state.hasOlder || over > 0, trimmedRight: 0 };
}

/**
 * Догон правого края (план 2A.7): все свечи с временем ≥ from заменяются свечами bars (свежая порция с сервера
 * и текущая), свечи раньше from остаются — вместе с подгруженной слева историей. Времена не повторяются:
 * из bars берутся только свечи не раньше from, по одной на время (последняя). Лишнее слева выгружается.
 */
export function replaceTail(state: BufferState, from: number, bars: readonly Candle[]): BufferState {
  const kept = state.candles.filter((c) => c.time < from);
  const add = sortUnique(bars.filter((c) => c.time >= from));
  const merged = [...kept, ...add];
  const over = Math.max(0, merged.length - MAX_CANDLES);
  return { candles: over ? merged.slice(over) : merged, hasOlder: state.hasOlder || over > 0, trimmedRight: 0 };
}

/**
 * Индекс первой свечи next, которая отличается от prev (время, цены, объём, флаг открытости); совпал весь общий
 * участок — его длина. Поверхность графика так отличает дописывание (≥ prev.length) от догона хвоста.
 */
export function firstChange(prev: readonly Candle[], next: readonly Candle[]): number {
  const n = Math.min(prev.length, next.length);
  for (let i = 0; i < n; i++) {
    const a = prev[i]!;
    const b = next[i]!;
    if (a !== b && (a.time !== b.time || a.open !== b.open || a.high !== b.high || a.low !== b.low || a.close !== b.close || a.volume !== b.volume || !!a.open_ !== !!b.open_)) return i;
  }
  return n;
}

/** Нужна ли порция слева для видимого диапазона (индексы логической шкалы); в полный буфер не грузим. */
export function needsOlder(state: BufferState, visibleFrom: number): boolean {
  return state.hasOlder && state.candles.length < MAX_CANDLES && visibleFrom < EDGE;
}

/** Нужна ли перезагрузка правого края. */
export function needsNewer(state: BufferState, visibleTo: number): boolean {
  return state.trimmedRight > 0 && visibleTo > state.candles.length - EDGE;
}
