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

/**
 * Свечи терминала из живого потока: закрытые, текущая (незакрытая, null — её нет) и последняя минута, которая
 * уже учтена целиком (минуты WebSocket не позже неё — дубли).
 */
export type LiveBars = { closed: readonly Candle[]; current: Candle | null; through: number };

/** Последняя минута, учтённая целиком в ответе истории на момент serverTime (unix с): предыдущая к идущей. */
export function restThrough(serverTime: number): number {
  return Math.floor(serverTime / 60) * 60 - 60;
}

const openFrom = (start: number, m1: Candle): Candle => ({ time: start, open: m1.open, high: m1.high, low: m1.low, close: m1.close, volume: m1.volume, open_: true });

/**
 * Закрытая минута (сообщение WebSocket `candle`) в свечах tf (план 2A.3). null — минута ничего не меняет.
 *
 * 1m: минута — это закрытая свеча. Она заменяет свечу с тем же временем (текущую недописанную из истории или
 * последнюю закрытую), следующая минута добавляется справа новой свечой; текущей свечи после неё нет — на 1m
 * поток приносит только закрытые минуты.
 *
 * Старше 1m: минута с временем начала текущей свечи заменяет её (до неё в текущей могла быть только эта же
 * минута, недописанная); остальные минуты той же корзины сворачиваются, а уже учтённые (through) пропускаются —
 * иначе объём минуты считался бы дважды; минута следующей корзины закрывает текущую и открывает новую; минута
 * старой корзины пропускается — закрытые свечи приходят из истории.
 */
export function applyMinute(s: LiveBars, m1: Candle, tf: Timeframe): LiveBars | null {
  if (tf === "1m") {
    const bar: Candle = { ...m1, open_: false };
    const through = Math.max(s.through, m1.time);
    const cur = s.current;
    if (cur && m1.time >= cur.time) {
      // текущая закрылась этой минутой; минута позже текущей — текущая закрывается как есть
      return { closed: m1.time === cur.time ? [...s.closed, bar] : [...s.closed, { ...cur, open_: false }, bar], current: null, through };
    }
    const last = s.closed[s.closed.length - 1];
    if (!last || m1.time > last.time) return { closed: [...s.closed, bar], current: cur, through };
    if (m1.time === last.time) return { closed: [...s.closed.slice(0, -1), bar], current: cur, through };
    return null;
  }
  const start = bucketStart(tf, m1.time);
  const cur = s.current;
  if (!cur) {
    const last = s.closed[s.closed.length - 1];
    if (last && start <= last.time) return null;
    return { closed: s.closed, current: openFrom(start, m1), through: m1.time };
  }
  if (start < cur.time) return null;
  if (start > cur.time) return { closed: [...s.closed, { ...cur, open_: false }], current: openFrom(start, m1), through: m1.time };
  if (m1.time <= s.through) return null;
  if (m1.time === start) return { closed: s.closed, current: openFrom(start, m1), through: m1.time };
  return { closed: s.closed, current: foldMinute(cur, m1, tf), through: m1.time };
}

/**
 * Свежая порция истории поверх живых свечей — догон после фона, переподключения или просроченного отсчёта.
 * page — закрытые свечи порции по возрастанию, current — незакрытая из того же ответа, through — restThrough(server_time).
 *
 * Закрытые свечи порции заменяют свои времена (они окончательные); старее порции — остаются как были (те же
 * объекты); новее последней закрытой порции — тоже остаются (их закрыл WebSocket уже после ответа). Текущая —
 * более новая из двух, при равном времени — та, где больше целых минут (при равенстве — из порции). Прежняя
 * текущая, которую порция не закрыла и не заменила, остаётся закрытой, а не пропадает.
 *
 * null — порция не стыкуется с тем, что есть (разрыв длиннее порции): историю надо заменить целиком.
 */
export function mergeLive(s: LiveBars, page: readonly Candle[], current: Candle | null, through: number): LiveBars | null {
  const known = s.current ?? s.closed[s.closed.length - 1] ?? null;
  const first = page[0]?.time ?? current?.time;
  if (first === undefined) return s;
  if (known === null) return { closed: page.slice(), current, through };
  if (first > known.time) return null;
  const pageLast = page[page.length - 1]?.time;
  const head = pageLast === undefined ? s.closed.slice() : s.closed.filter((c) => c.time < first);
  const tail = pageLast === undefined ? [] : s.closed.filter((c) => c.time > pageLast);
  const closed = [...head, ...page, ...tail];
  const lastClosed = closed[closed.length - 1]?.time ?? -Infinity;
  const rest = current && current.time > lastClosed ? current : null;
  const live = s.current && s.current.time > lastClosed ? s.current : null;
  const liveWins = live !== null && (rest === null || live.time > rest.time || (live.time === rest.time && s.through > through));
  const next = liveWins ? live : rest;
  if (live && next && live.time < next.time) closed.push({ ...live, open_: false });
  return { closed, current: next, through: Math.max(s.through, through) };
}

/**
 * Когда новая свеча просрочена, unix с: текущая должна смениться к своему закрытию; если текущей нет (1m после
 * минуты из WebSocket), новая свеча придёт с закрытием следующей минуты — ещё через 60 с. grace — запас на
 * задержку записи и доставки. null — свечей нет.
 */
export function liveDueAt(s: LiveBars, tf: Timeframe, grace: number): number | null {
  const last = s.current ?? s.closed[s.closed.length - 1];
  if (!last) return null;
  return last.time + TF_SECONDS[tf] + (s.current ? 0 : 60) + grace;
}

/**
 * Секунд до закрытия идущего интервала tf: от последней свечи, а если её интервал уже прошёл (1m после закрытой
 * минуты, свеча ещё не пришла) — от интервала по часам, а не «0:00».
 */
export function countdownSeconds(tf: Timeframe, lastTime: number, now: number): number {
  return secondsToClose(tf, Math.max(lastTime, bucketStart(tf, now)), now);
}

/** Закрыта ли текущая свеча tf к моменту ``now`` (unix с). */
export function isClosed(c: Candle, tf: Timeframe, now: number): boolean {
  return c.time + TF_SECONDS[tf] <= now;
}

/** Секунд до закрытия свечи tf, начавшейся в ``time``. */
export function secondsToClose(tf: Timeframe, time: number, now: number): number {
  return Math.max(0, time + TF_SECONDS[tf] - now);
}
