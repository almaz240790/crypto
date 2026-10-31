/**
 * Данные крипто-панелей (фандинг, OI, ликвидации, L/S — план 2A.4) на время свечей.
 *
 * Все серии графика делят одну шкалу времени: точка панели со временем, которого нет у свечей, добавляет
 * на шкалу лишнее деление, а точка левее первой свечи сдвигает логические индексы (с панелью OI график
 * открывался на 84 дня в прошлом). Поэтому каждая точка относится к свече, в интервал которой попала,
 * а точки вне диапазона загруженных свечей отбрасываются.
 */

/** Индекс последней свечи с временем ≤ t (times отсортированы), −1 — левее первой. */
function floorIndex(times: readonly number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let out = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) {
      out = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return out;
}

/**
 * Точки на время свечей: по одной на свечу; несколько точек в одной свече склеиваются merge
 * (по умолчанию — последняя). lastEnd — конец интервала последней свечи (unix с), правее точки отбрасываются.
 */
export function alignToCandles<T extends { t: number }>(rows: readonly T[], times: readonly number[], lastEnd: number, merge: (prev: T, next: T) => T = (_prev, next) => next): { time: number; row: T }[] {
  const out = new Map<number, T>();
  if (times.length === 0) return [];
  for (const r of rows) {
    if (r.t >= lastEnd) continue;
    const i = floorIndex(times, r.t);
    if (i < 0) continue;
    const time = times[i]!;
    const prev = out.get(time);
    out.set(time, prev === undefined ? r : merge(prev, r));
  }
  return [...out.entries()].sort((a, b) => a[0] - b[0]).map(([time, row]) => ({ time, row }));
}
