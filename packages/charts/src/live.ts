import type { Candle, Timeframe } from "./types";
import { TF_SECONDS } from "./types";

/** Начало интервала tf для unix-времени (неделя — с понедельника 00:00 UTC, как у Binance). */
export function bucketStart(tf: Timeframe, time: number): number {
  if (tf === "1w") {
    const d = new Date(time * 1000);
    const dow = (d.getUTCDay() + 6) % 7; // понедельник = 0
    return Math.floor(time / 86400) * 86400 - dow * 86400;
  }
  const size = TF_SECONDS[tf];
  return Math.floor(time / size) * size;
}

/**
 * Свёртка закрытой минутной свечи (сообщение WebSocket `candle`) в текущую свечу tf (план 2A.3).
 * Возвращает новую текущую свечу: продолжение той же корзины или начало новой.
 */
export function foldMinute(current: Candle | null, m1: Candle, tf: Timeframe): Candle {
  const start = bucketStart(tf, m1.time);
  if (current && current.time === start) {
    return {
      time: start,
      open: current.open,
      high: Math.max(current.high, m1.high),
      low: Math.min(current.low, m1.low),
      close: m1.close,
      volume: current.volume + m1.volume,
      open_: true,
    };
  }
  return { time: start, open: m1.open, high: m1.high, low: m1.low, close: m1.close, volume: m1.volume, open_: true };
}

/** Закрыта ли текущая свеча tf к моменту ``now`` (unix с). */
export function isClosed(c: Candle, tf: Timeframe, now: number): boolean {
  return c.time + TF_SECONDS[tf] <= now;
}

/** Секунд до закрытия свечи tf, начавшейся в ``time``. */
export function secondsToClose(tf: Timeframe, time: number, now: number): number {
  return Math.max(0, time + TF_SECONDS[tf] - now);
}

/**
 * Живая текущая свеча tf из событий WebSocket (план 2A.3, ADR-0010): закрытые минуты (`candle`),
 * формирующаяся минута с сервера (`forming`, раз в 15 с при REST-опросе) и тики цены (`tick`, раз в с).
 *
 * Свеча tf = свёртка подтверждённых закрытых минут (`base`; при загрузке — текущая свеча с сервера) и
 * неподтверждённых минут после последней закрытой (`minutes`: снимок с сервера, дополненный тиками).
 * Тик внутри интервала меняет close и расширяет high/low, объём не трогает; новый бар появляется
 * только с первым событием следующего интервала. Закрытая минута, пришедшая уже после первого тика
 * следующего интервала (REST-опрос раз в 15 с), уточняет только что закрытую свечу — `amended`.
 */
export type LiveBarState = {
  tf: Timeframe;
  /** Свёртка подтверждённых минут корзины base.time. */
  base: Candle | null;
  /** Неподтверждённые минуты после последней закрытой, по времени. */
  minutes: Candle[];
  /** Время последней закрытой минуты: события не новее неё устарели. */
  lastClosed: number;
  /** Текущая (незакрытая) свеча tf — как показана. */
  head: Candle | null;
  /** Последняя свеча, закрытая автоматом: её ещё может уточнить запоздавшая минута. */
  tail: Candle | null;
};

export type LiveStep = {
  state: LiveBarState;
  /** Текущая свеча tf после события (null — данных ещё нет). */
  bar: Candle | null;
  /** Свечи, закрытые событием, — дописать в историю перед `bar`. */
  closed: Candle[];
  /** Уточнённая последняя закрытая свеча (то же время) — заменить в истории. */
  amended: Candle | null;
};

/** Сколько неподтверждённых минут держим; старшие сверх — считаем закрытыми как есть. */
export const LIVE_PENDING_MINUTES = 5;

export function liveStart(tf: Timeframe, current: Candle | null): LiveBarState {
  const cur = current ? { ...current, open_: true } : null;
  // у 1m текущая свеча с сервера — сама формирующаяся минута: её уточнят forming и тики
  if (tf === "1m") return { tf, base: null, minutes: cur ? [cur] : [], lastClosed: -Infinity, head: cur, tail: null };
  return { tf, base: cur, minutes: [], lastClosed: -Infinity, head: cur, tail: null };
}

function merge(acc: Candle | null, m: Candle, time: number): Candle {
  if (!acc) return { time, open: m.open, high: m.high, low: m.low, close: m.close, volume: m.volume, open_: true };
  return { time, open: acc.open, high: Math.max(acc.high, m.high), low: Math.min(acc.low, m.low), close: m.close, volume: acc.volume + m.volume, open_: true };
}

function sameBar(a: Candle, b: Candle): boolean {
  return a.time === b.time && a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close && a.volume === b.volume;
}

type Parts = { base: Candle | null; minutes: Candle[]; lastClosed: number; finished: Candle[] };

/** Подтверждение минуты m: она и пропущенные до неё неподтверждённые — в base по корзинам. */
function confirm(tf: Timeframe, p: Parts, m: Candle): Parts {
  let base = p.base;
  const finished = p.finished.slice();
  for (const x of [...p.minutes.filter((y) => y.time < m.time), m]) {
    const b = bucketStart(tf, x.time);
    if (!base || base.time < b) {
      if (base) finished.push(base);
      base = merge(null, x, b);
    } else if (base.time === b) base = merge(base, x, b);
    // base.time > b: минута старше свечи с сервера — уже в ней
  }
  return { base, minutes: p.minutes.filter((y) => y.time > m.time), lastClosed: m.time, finished };
}

function withMinute(tf: Timeframe, p: Parts, m: Candle): Parts {
  const minutes = p.minutes.filter((x) => x.time !== m.time);
  minutes.push(m);
  minutes.sort((a, b) => a.time - b.time);
  let out: Parts = { ...p, minutes };
  while (out.minutes.length > LIVE_PENDING_MINUTES) out = confirm(tf, out, out.minutes[0]!);
  return out;
}

function settle(s: LiveBarState, p: Parts, touched: number): LiveStep {
  const { tf } = s;
  const view = (B: number): Candle | null => {
    let acc = p.finished.find((f) => f.time === B) ?? (p.base && p.base.time === B ? p.base : null);
    for (const m of p.minutes) if (bucketStart(tf, m.time) === B) acc = merge(acc, m, B);
    return acc;
  };
  let ht: number | null = p.base ? p.base.time : null;
  for (const m of p.minutes) ht = Math.max(ht ?? -Infinity, bucketStart(tf, m.time));
  const closed: Candle[] = [];
  let amended: Candle | null = null;
  let tail = s.tail;
  let head = ht === null ? s.head : view(ht);
  if (s.head && ht !== null && ht < s.head.time) head = s.head; // показанную свечу назад не откатываем
  else if (s.head && ht !== null && ht > s.head.time) {
    tail = { ...(view(s.head.time) ?? s.head), open_: false };
    closed.push(tail);
  } else if (tail && (touched === tail.time || p.finished.some((f) => f.time === tail!.time))) {
    const upd = view(tail.time);
    if (upd && !sameBar(upd, tail)) {
      tail = { ...upd, open_: false };
      amended = tail;
    }
  }
  return { state: { tf, base: p.base, minutes: p.minutes, lastClosed: p.lastClosed, head, tail }, bar: head, closed, amended };
}

const parts = (s: LiveBarState): Parts => ({ base: s.base, minutes: s.minutes, lastClosed: s.lastClosed, finished: [] });
const unchanged = (s: LiveBarState): LiveStep => ({ state: s, bar: s.head, closed: [], amended: null });

/** Закрытая минутная свеча (`candle`). */
export function liveCandle(s: LiveBarState, m: Candle): LiveStep {
  if (m.time <= s.lastClosed) return unchanged(s);
  return settle(s, confirm(s.tf, parts(s), { ...m, open_: false }), bucketStart(s.tf, m.time));
}

/** Формирующаяся минута с сервера (`forming`): снимок o/h/l/c/v; тики после снимка расширяют high/low. */
export function liveForming(s: LiveBarState, f: Candle): LiveStep {
  if (f.time <= s.lastClosed) return unchanged(s);
  const prev = s.minutes.find((x) => x.time === f.time);
  const next: Candle = { ...f, high: Math.max(f.high, prev?.high ?? f.high), low: Math.min(f.low, prev?.low ?? f.low), open_: true };
  return settle(s, withMinute(s.tf, parts(s), next), bucketStart(s.tf, f.time));
}

/** Тик цены (`tick`): close = цена, high/low расширяются, объём не меняется. at — unix с. */
export function liveTick(s: LiveBarState, price: number, at: number): LiveStep {
  const t = Math.floor(at / 60) * 60;
  if (!Number.isFinite(price) || !Number.isFinite(at) || t <= s.lastClosed) return unchanged(s);
  const prev = s.minutes.find((x) => x.time === t);
  const next: Candle = prev ? { ...prev, high: Math.max(prev.high, price), low: Math.min(prev.low, price), close: price } : { time: t, open: price, high: price, low: price, close: price, volume: 0, open_: true };
  return settle(s, withMinute(s.tf, parts(s), next), bucketStart(s.tf, t));
}
