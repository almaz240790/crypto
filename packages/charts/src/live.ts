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
 * Свечи для догона (catchUpLive): закрытые, текущая (незакрытая, null — её нет) и последняя минута, которая уже
 * учтена целиком (минуты WebSocket не позже неё — дубли). У живого потока это история LiveBar, head и lastClosed
 * автомата; у порции с сервера — свечи ответа, его current и through.
 */
export type LiveBars = { closed: readonly Candle[]; current: Candle | null; through: number };

/**
 * Оценка последней минуты, учтённой целиком в ответе истории на момент serverTime (unix с): предыдущая к идущей.
 * Только запасной путь для API без поля through: минута, закрытая перед самым ответом, могла ещё не попасть в
 * БД (запись раз в секунду, в режиме REST-опроса — до 15 с), а идущая минута уже лежит в текущей недописанной.
 */
export function restThrough(serverTime: number): number {
  return Math.floor(serverTime / 60) * 60 - 60;
}

/**
 * Свежая порция истории поверх живых свечей — догон после фона, переподключения или просроченного отсчёта.
 * page — закрытые свечи порции по возрастанию, current — незакрытая из того же ответа, through — последняя минута,
 * учтённая ответом целиком (поле through ответа, без него — restThrough(server_time)).
 *
 * Закрытые свечи порции заменяют свои времена (они окончательные); старее порции — остаются как были (те же
 * объекты); новее последней закрытой порции — тоже остаются (их закрыл WebSocket уже после ответа). Текущая —
 * более новая из двух, при равном времени — та, где больше целых минут (при равенстве — из порции). Прежняя
 * текущая, которую порция не закрыла и не заменила, остаётся закрытой, а не пропадает.
 *
 * null — порция не стыкуется с историей (разрыв длиннее порции): историю надо заменить целиком (catchUpLive).
 * Стык проверяется по истории, а не по самой новой живой свече: после долгого отсутствия минута WebSocket,
 * пришедшая раньше ответа, уже дописана справа далеко за разрывом — по ней порция «стыковалась» бы, и в
 * истории навсегда оставалась дыра. Поэтому: свеча истории прямо перед началом порции — соседняя (не дальше
 * одного tf), а прежняя текущая — не старше начала порции (иначе окончательной её версии в порции нет).
 */
export function mergeLive(s: LiveBars, page: readonly Candle[], current: Candle | null, through: number, tf: Timeframe): LiveBars | null {
  const known = s.current ?? s.closed[s.closed.length - 1] ?? null;
  const first = page[0]?.time ?? current?.time;
  if (first === undefined) return s;
  if (known === null) return { closed: page.slice(), current, through };
  if (first > known.time) return null;
  if (s.current && s.current.time < first) return null;
  const before = lastBefore(s.closed, first);
  if (before && first - before.time > TF_SECONDS[tf]) return null;
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

/** Последняя свеча раньше time в отсортированном массиве. */
function lastBefore(bars: readonly Candle[], time: number): Candle | undefined {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.time < time) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? bars[lo - 1] : undefined;
}

/**
 * Догон целиком: порция сливается с концом (mergeLive), а если не стыкуется — история заменяется порцией, но
 * свечи потока новее порции (минута закрылась, пока шёл запрос) остаются сверху: без них последняя минута
 * пропала бы до следующей минуты потока. replaced — история заменена (подгруженное слева и вид — заново).
 */
export function catchUpLive(s: LiveBars, page: readonly Candle[], current: Candle | null, through: number, tf: Timeframe): { bars: LiveBars; replaced: boolean } {
  const merged = mergeLive(s, page, current, through, tf);
  if (merged) return { bars: merged, replaced: false };
  const edge = page[page.length - 1]?.time ?? -Infinity;
  const newer: LiveBars = { closed: s.closed.filter((c) => c.time > edge), current: s.current && s.current.time > edge ? s.current : null, through: s.through };
  return { bars: mergeLive(newer, page, current, through, tf) ?? { closed: page.slice(), current, through }, replaced: true };
}

/**
 * Когда новая свеча просрочена, unix с (план 2A.7): текущая (head) должна смениться к своему закрытию; если текущей
 * нет или на 1m она уже подтверждена закрытой минутой, новая свеча придёт с закрытием следующей минуты — ещё через
 * 60 с. grace — запас на задержку записи и доставки. null — свечей нет.
 */
export function liveDueAt(s: LiveBarState, grace: number): number | null {
  const last = s.head ?? s.tail;
  if (!last) return null;
  const closedHead = !s.head || (s.tf === "1m" && s.head.time <= s.lastClosed);
  return last.time + TF_SECONDS[s.tf] + (closedHead ? 60 : 0) + grace;
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
 * (пропущенные свечи — сон телефона, обрыв связи), переход через интервал и пропущенная закрытая минута — `gap`:
 * историю справа нужно перечитать с сервера (догон — catchUpLive + liveRestart, ADR-0003 и ADR-0010).
 *
 * Поле `through` ответа истории (последняя закрытая минута в БД, текущая свеча tf ≥ 5m свёрнута только из закрытых
 * минут) задаёт `lastClosed` при старте и при догоне: минуты, формирующиеся минуты и тики не новее него уже учтены
 * и пропускаются — объём минуты не считается дважды. У 1m through нет: там закрытая минута заменяет свечу по времени.
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
 * through ответа годится как последняя учтённая минута: не 1m, конечное и не позже текущей свечи с сервера
 * (иначе ответ противоречит сам себе — не доверяем); иначе −∞ (минуты сворачиваются все).
 */
function seedThrough(tf: Timeframe, current: Candle | null, through: number | null | undefined): number {
  if (tf === "1m" || through == null || !Number.isFinite(through)) return -Infinity;
  if (current && through >= current.time + TF_SECONDS[tf]) return -Infinity;
  return through;
}

/**
 * Начало: текущая свеча с сервера (`current`), последняя закрытая свеча истории (`last`) и through ответа — последняя
 * закрытая минута, уже учтённая текущей (tf ≥ 5m): события не новее неё пропускаются (объём не дважды). Без `last`
 * событие старого интервала могло стать текущей свечой и затереть свечу истории.
 */
export function liveStart(tf: Timeframe, current: Candle | null, last: Candle | null = null, through?: number | null): LiveBarState {
  const cur = current ? { ...current, open_: true } : null;
  const tail = last && (!cur || last.time < cur.time) ? { ...last, open_: false } : null;
  const common = { lastClosed: seedThrough(tf, cur, through), head: cur, tail, tailHist: tail !== null, tailMinute: -Infinity, lastTick: null };
  // у 1m текущая свеча с сервера — сама формирующаяся минута: её уточнят forming и тики
  if (tf === "1m") return { tf, base: null, minutes: cur ? [cur] : [], ...common };
  return { tf, base: cur, minutes: [], ...common };
}

/** Текущая свеча из свёртки base и неподтверждённых минут — самой новой корзины (как settle). */
function headOf(tf: Timeframe, base: Candle | null, minutes: readonly Candle[], lastClosed: number): Candle | null {
  let ht: number | null = base ? base.time : null;
  for (const m of minutes) ht = Math.max(ht ?? -Infinity, bucketStart(tf, m.time));
  if (ht === null) return null;
  let acc = base && base.time === ht ? base : null;
  for (const m of minutes) if (bucketStart(tf, m.time) === ht) acc = fold(acc, base, m, ht, lastClosed);
  return acc && tf === "1m" && acc.time <= lastClosed ? { ...acc, open_: false } : acc;
}

/**
 * Перезапуск по свежей истории с сервера (догон: переподключение, пропуск, возврат вкладки, просрочка). current —
 * текущая, которую выбрал catchUpLive: сам head автомата (поток впереди ответа — у той же свечи у него больше целых
 * минут) или свеча ответа; last — последняя закрытая итоговой истории; through и serverTime — из ответа.
 *
 * - lastClosed = max(прежний, through): минуты, учтённые ответом, дальше пропускаются.
 * - Поток впереди (current — сам head): автомат тот же, из ответа — только последняя свеча истории.
 * - Свеча ответа: она — свёртка закрытых минут, неподтверждённые минуты потока новее lastClosed (формирующаяся
 *   минута, тики) остаются сверху — объём и цена идущей минуты не теряются. У той же свечи, что head, high/low —
 *   объединение (тики могли выйти за ответ); close — из минут потока, а без них — тика, если он не старше ответа
 *   (serverTime; без времени сервера — тика), иначе ответа.
 */
export function liveRestart(prev: LiveBarState | null, tf: Timeframe, current: Candle | null, last: Candle | null, through?: number | null, serverTime?: number): LiveBarState {
  const lc = Math.max(prev?.lastClosed ?? -Infinity, seedThrough(tf, current, through));
  const tail = last && (!current || last.time < current.time) ? { ...last, open_: false } : null;
  const lastTick = prev?.lastTick ?? null;
  const ph = prev?.head ?? null;
  if (prev && ph && (current === ph || !current || ph.time > current.time) && (!last || ph.time > last.time)) {
    // поток впереди ответа: его текущая остаётся; текущая ответа, которую он уже обогнал, — закрытая свеча истории
    const passed = current !== null && current !== ph && (!last || current.time > last.time);
    const t = passed ? { ...current, open_: false } : last ? { ...last, open_: false } : null;
    // последняя свеча истории — та, что закрыл сам автомат (её минуты он знает): его версия
    const own = !passed && prev.tail !== null && t !== null && !prev.tailHist && prev.tail.time === t.time;
    return { ...prev, lastClosed: lc, minutes: prev.minutes.filter((m) => m.time > lc), tail: own ? prev.tail : t, tailHist: own ? false : t !== null, tailMinute: own ? prev.tailMinute : -Infinity };
  }
  const head = prev?.head ?? null;
  let cur = current ? { ...current, open_: true } : null;
  if (cur && head && head.time === cur.time) cur = { ...cur, high: Math.max(cur.high, head.high), low: Math.min(cur.low, head.low) };
  const from = cur?.time ?? Infinity;
  const kept = (prev?.minutes ?? []).filter((m) => m.time > lc && bucketStart(tf, m.time) >= from && !(tf === "1m" && m.time === from));
  if (cur && lastTick && !kept.some((m) => bucketStart(tf, m.time) === from) && bucketStart(tf, lastTick.minute) === from && (serverTime === undefined || !Number.isFinite(serverTime) || lastTick.at >= serverTime)) {
    const p = lastTick.price;
    cur = { ...cur, high: Math.max(cur.high, p), low: Math.min(cur.low, p), close: p };
  }
  const base = tf === "1m" ? null : cur;
  const minutes = tf === "1m" && cur ? [cur, ...kept] : kept;
  return { tf, base, minutes, lastClosed: lc, head: headOf(tf, base, minutes, lc), tail, tailHist: tail !== null, tailMinute: -Infinity, lastTick };
}

function merge(acc: Candle | null, m: Candle, time: number): Candle {
  if (!acc) return { time, open: m.open, high: m.high, low: m.low, close: m.close, volume: m.volume, open_: true };
  return { time, open: acc.open, high: Math.max(acc.high, m.high), low: Math.min(acc.low, m.low), close: m.close, volume: acc.volume + m.volume, open_: true };
}

/**
 * base — снимок той же минуты, что m, а не свёртка до неё: base новее последней закрытой минуты (в нём нет ни одной
 * подтверждённой минуты корзины) и m — первая минута корзины. Так бывает, когда текущая с сервера — ответ без закрытых
 * минут интервала (в ней только недописанная первая минута) или неподтверждённые минуты потока остались поверх такой
 * текущей при догоне.
 */
function sameMinute(base: Candle, m: Candle, lastClosed: number): boolean {
  return base.time === m.time && base.time > lastClosed;
}

/**
 * Свёртка неподтверждённой минуты m в свечу acc корзины time. Если acc — сам base и он снимок той же минуты
 * (sameMinute), минута не складывается, а сливается как два снимка одной минуты: объём — больший (он только растёт),
 * high/low — объединение, open — из base (у минуты из тиков open — цена первого тика), close — минуты (тики).
 */
function fold(acc: Candle | null, base: Candle | null, m: Candle, time: number, lastClosed: number): Candle {
  if (acc === null || acc !== base || !sameMinute(acc, m, lastClosed)) return merge(acc, m, time);
  return { time, open: acc.open, high: Math.max(acc.high, m.high), low: Math.min(acc.low, m.low), close: m.close, volume: Math.max(acc.volume, m.volume), open_: true };
}

function sameBar(a: Candle, b: Candle): boolean {
  return a.time === b.time && a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close && a.volume === b.volume;
}

type Parts = { base: Candle | null; minutes: Candle[]; lastClosed: number; finished: Candle[] };

/**
 * Подтверждение минуты m: она и пропущенные до неё неподтверждённые — в base по корзинам. closed — m пришла
 * закрытой минутой с сервера (а не неподтверждённая сверх LIVE_PENDING_MINUTES): только она может заменить base.
 */
function confirm(tf: Timeframe, p: Parts, m: Candle, closed = false): Parts {
  let base = p.base;
  const finished = p.finished.slice();
  for (const x of [...p.minutes.filter((y) => y.time < m.time), m]) {
    const b = bucketStart(tf, x.time);
    if (!base || base.time < b) {
      if (base) finished.push(base);
      base = merge(null, x, b);
    } else if (base.time === b && sameMinute(base, x, p.lastClosed)) {
      // первая минута корзины, а base — снимок её же, недописанной (текущая с сервера, в которую попала формирующаяся
      // первая минута, — ответ без закрытых минут интервала): закрытая минута base заменяет, неподтверждённая сверх
      // LIVE_PENDING_MINUTES — сливается с ним как снимок той же минуты; иначе её объём считался бы дважды
      base = closed && x === m ? merge(null, x, b) : fold(base, base, x, b, p.lastClosed);
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
    for (const m of p.minutes) if (bucketStart(tf, m.time) === B) acc = fold(acc, p.base, m, B, p.lastClosed);
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
  // 1m: свеча, подтверждённая закрытой минутой, показывается закрытой (следующая придёт новой свечой)
  if (tf === "1m" && head && head.open_ && head.time <= p.lastClosed) head = { ...head, open_: false };
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

/**
 * Пропущена закрытая минута: минута позже следующей за последней учтённой (поток молчал, пока телефон спал, или
 * минута закрылась между ответом истории и подпиской). У 1m учтённая — и последняя свеча истории (минута).
 */
function missedMinute(s: LiveBarState, t: number): boolean {
  const known = s.tf === "1m" ? Math.max(s.lastClosed, s.tail?.time ?? -Infinity) : s.lastClosed;
  return Number.isFinite(known) && t > known + 60;
}

/**
 * Закрытая минутная свеча (`candle`). Пропущенная перед ней закрытая минута — `gap` (догон историей), сама минута
 * всё равно сворачивается.
 */
export function liveCandle(s: LiveBarState, m: Candle): LiveStep {
  if (m.time <= s.lastClosed) return unchanged(s);
  const missed = missedMinute(s, m.time);
  const where = route(s, bucketStart(s.tf, m.time));
  if (where === "stale") return unchanged(s);
  if (where === "gap") return unchanged(s, true);
  const step = where === "tail" ? foldTail(s, m.time, m, s.tf === "1m", { lastClosed: m.time }) : settle(s, confirm(s.tf, parts(s), { ...m, open_: false }, true), bucketStart(s.tf, m.time));
  return missed && !step.gap ? { ...step, gap: true } : step;
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
