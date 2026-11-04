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
 *
 * Автомат знает последнюю закрытую свечу истории (`tail` при старте): событие её интервала никогда не
 * становится текущей свечой, а уточняет её (`amended`): у 1m закрытая минута заменяет свечу целиком,
 * у старших tf — high, low и close. Событие интервала между последней закрытой и текущей свечой
 * (пропущенные свечи — сон телефона, обрыв связи) и переход через интервал — `gap`: историю справа
 * нужно перечитать с сервера.
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
  /** Последняя закрытая свеча: закрытая автоматом или последняя свеча истории с сервера. */
  tail: Candle | null;
  /** tail — из истории с сервера (её минут автомат не знает: события правят её напрямую). */
  tailHist: boolean;
  /** Минута, задавшая close свечи истории tail (более ранняя минута close не меняет). */
  tailMinute: number;
  /** Последний тик: минута, момент (unix с) и цена — снимок `forming` старше него close не откатывает. */
  lastTick: { minute: number; at: number; price: number } | null;
};

export type LiveStep = {
  state: LiveBarState;
  /** Текущая свеча tf после события (null — данных ещё нет). */
  bar: Candle | null;
  /** Свечи, закрытые событием, — дописать в историю перед `bar`. */
  closed: Candle[];
  /** Уточнённая закрытая свеча (то же время) — заменить в истории. */
  amended: Candle | null;
  /** Между последней закрытой и текущей свечой есть пропуск: перечитать свежую историю с сервера. */
  gap: boolean;
};

/** Сколько неподтверждённых минут держим; старшие сверх — считаем закрытыми как есть. */
export const LIVE_PENDING_MINUTES = 5;

/** Начало следующего интервала tf. */
export function nextBucket(tf: Timeframe, time: number): number {
  return bucketStart(tf, bucketStart(tf, time) + TF_SECONDS[tf]);
}

/**
 * Начало: текущая свеча с сервера (`current`) и последняя закрытая свеча истории (`last`). Без `last`
 * событие старого интервала могло стать текущей свечой и затереть свечу истории.
 */
export function liveStart(tf: Timeframe, current: Candle | null, last: Candle | null = null): LiveBarState {
  const cur = current ? { ...current, open_: true } : null;
  const tail = last && (!cur || last.time < cur.time) ? { ...last, open_: false } : null;
  const common = { lastClosed: -Infinity, head: cur, tail, tailHist: tail !== null, tailMinute: -Infinity, lastTick: null };
  // у 1m текущая свеча с сервера — сама формирующаяся минута: её уточнят forming и тики
  if (tf === "1m") return { tf, base: null, minutes: cur ? [cur] : [], ...common };
  return { tf, base: cur, minutes: [], ...common };
}

/**
 * Перезапуск по свежей истории с сервера (переподключение, пропуск): то, что автомат уже знает новее
 * сервера, сохраняется — текущая свеча новее серверной остаётся текущей (серверная закрыта), у той же
 * свечи — high/low шире и close последнего тика.
 */
export function liveRestart(prev: LiveBarState | null, tf: Timeframe, current: Candle | null, last: Candle | null): LiveBarState {
  const head = prev?.head ?? null;
  let cur = current;
  let tail = last;
  if (head && cur && head.time > cur.time) {
    tail = { ...cur, open_: false };
    cur = head;
  } else if (head && cur && head.time === cur.time) {
    cur = { ...cur, high: Math.max(cur.high, head.high), low: Math.min(cur.low, head.low), close: prev?.lastTick ? head.close : cur.close };
  } else if (head && !cur && (!last || head.time > last.time)) cur = head;
  return { ...liveStart(tf, cur, tail), lastTick: prev?.lastTick ?? null };
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

function settle(s: LiveBarState, p: Parts, touched: number, extra: Partial<LiveBarState> = {}): LiveStep {
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
  let gap = false;
  let head = ht === null ? s.head : view(ht);
  if (s.head && ht !== null && ht < s.head.time) head = s.head; // показанную свечу назад не откатываем
  else if (s.head && ht !== null && ht > s.head.time) {
    tail = { ...(view(s.head.time) ?? s.head), open_: false };
    closed.push(tail);
    gap = ht > nextBucket(tf, s.head.time); // интервалы между ними пропущены
  } else if (!s.head && ht !== null && s.tail) gap = ht > nextBucket(tf, s.tail.time);
  else if (tail && !s.tailHist && (touched === tail.time || p.finished.some((f) => f.time === tail!.time))) {
    const upd = view(tail.time);
    if (upd && !sameBar(upd, tail)) {
      tail = { ...upd, open_: false };
      amended = tail;
    }
  }
  const tailHist = tail === s.tail && s.tailHist;
  const state: LiveBarState = { ...s, ...extra, base: p.base, minutes: p.minutes, lastClosed: p.lastClosed, head, tail, tailHist };
  return { state, bar: head, closed, amended, gap };
}

const parts = (s: LiveBarState): Parts => ({ base: s.base, minutes: s.minutes, lastClosed: s.lastClosed, finished: [] });
const unchanged = (s: LiveBarState, gap = false): LiveStep => ({ state: s, bar: s.head, closed: [], amended: null, gap });

/**
 * Куда относится событие интервала B: `live` — текущая свеча или новая (обычный путь), `tail` — свеча
 * истории с сервера, `gap` — интервал между последней закрытой и текущей (пропуск), `stale` — старше.
 */
function route(s: LiveBarState, B: number): "live" | "tail" | "gap" | "stale" {
  const { tail, head } = s;
  if (tail && s.tailHist) {
    if (B === tail.time) return "tail";
    if (B < tail.time) return "stale";
  }
  if (head && B < head.time) {
    if (tail && !s.tailHist && B === tail.time) return "live"; // уточнение закрытой автоматом
    return tail && B > tail.time ? "gap" : "stale";
  }
  return "live";
}

/** Событие интервала свечи истории: у 1m закрытая минута — свеча целиком, иначе high/low и close. */
function foldTail(s: LiveBarState, minute: number, m: Candle, whole: boolean, extra: Partial<LiveBarState> = {}): LiveStep {
  const t = s.tail!;
  let next: Candle;
  let tailMinute = s.tailMinute;
  if (whole) {
    next = { ...m, time: t.time, open_: false };
    tailMinute = minute;
  } else {
    const later = minute >= s.tailMinute;
    next = { ...t, high: Math.max(t.high, m.high), low: Math.min(t.low, m.low), close: later ? m.close : t.close };
    if (later) tailMinute = minute;
  }
  const changed = !sameBar(next, t);
  const state: LiveBarState = { ...s, ...extra, tail: changed ? next : t, tailMinute };
  return { state, bar: s.head, closed: [], amended: changed ? next : null, gap: false };
}

/** Закрытая минутная свеча (`candle`). */
export function liveCandle(s: LiveBarState, m: Candle): LiveStep {
  if (m.time <= s.lastClosed) return unchanged(s);
  const where = route(s, bucketStart(s.tf, m.time));
  if (where === "stale") return unchanged(s);
  if (where === "gap") return unchanged(s, true);
  if (where === "tail") return foldTail(s, m.time, m, s.tf === "1m", { lastClosed: m.time });
  return settle(s, confirm(s.tf, parts(s), { ...m, open_: false }), bucketStart(s.tf, m.time));
}

/**
 * Формирующаяся минута с сервера (`forming`): снимок o/h/l/c/v; тики после снимка расширяют high/low.
 * `asOf` — момент снимка (unix с): close из снимка, только если он не старше последнего тика этой
 * минуты; без `asOf` (старый сервер) close тика сохраняется — снимок REST-опроса обычно старше тика.
 */
export function liveForming(s: LiveBarState, f: Candle, asOf?: number): LiveStep {
  if (f.time <= s.lastClosed) return unchanged(s);
  const where = route(s, bucketStart(s.tf, f.time));
  if (where === "stale") return unchanged(s);
  if (where === "gap") return unchanged(s, true);
  const t = s.lastTick;
  const keepTick = t !== null && t.minute === f.time && !(asOf !== undefined && Number.isFinite(asOf) && asOf > t.at);
  if (where === "tail") return foldTail(s, f.time, keepTick ? { ...f, close: t.price } : f, false);
  const prev = s.minutes.find((x) => x.time === f.time);
  const high = Math.max(f.high, prev?.high ?? f.high, keepTick ? t.price : f.high);
  const low = Math.min(f.low, prev?.low ?? f.low, keepTick ? t.price : f.low);
  const next: Candle = { ...f, high, low, close: keepTick ? t.price : f.close, open_: true };
  return settle(s, withMinute(s.tf, parts(s), next), bucketStart(s.tf, f.time));
}

/**
 * Тик цены (`tick`): close = цена, high/low расширяются, объём не меняется. at — unix с. Тик старше
 * последнего (пришёл не по порядку) расширяет high/low, но close не трогает.
 */
export function liveTick(s: LiveBarState, price: number, at: number): LiveStep {
  const t = Math.floor(at / 60) * 60;
  if (!Number.isFinite(price) || !Number.isFinite(at) || t <= s.lastClosed) return unchanged(s);
  const where = route(s, bucketStart(s.tf, t));
  if (where === "stale") return unchanged(s);
  if (where === "gap") return unchanged(s, true);
  const late = s.lastTick !== null && at < s.lastTick.at;
  const lastTick = late ? s.lastTick : { minute: t, at, price };
  const flat: Candle = { time: t, open: price, high: price, low: price, close: price, volume: 0, open_: true };
  if (where === "tail") return foldTail(s, t, late ? { ...flat, close: s.tail!.close } : flat, false, { lastTick });
  const prev = s.minutes.find((x) => x.time === t);
  const next: Candle = prev ? { ...prev, high: Math.max(prev.high, price), low: Math.min(prev.low, price), close: late ? prev.close : price } : flat;
  return settle(s, withMinute(s.tf, parts(s), next), bucketStart(s.tf, t), { lastTick });
}
