import type { Candle } from "./types";

/**
 * Heikin Ashi (план 2A.3): считается на клиенте из обычных свечей, паттерны и алерты по нему не работают.
 * Формулы: close = (o+h+l+c)/4; open = (prev.open + prev.close)/2, первая — (o+c)/2;
 * high = max(h, open, close); low = min(l, open, close). Объём и время — как у исходной свечи.
 */
export function heikinAshi(candles: readonly Candle[]): Candle[] {
  const out: Candle[] = [];
  let prevOpen = 0;
  let prevClose = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    const close = (c.open + c.high + c.low + c.close) / 4;
    const open = i === 0 ? (c.open + c.close) / 2 : (prevOpen + prevClose) / 2;
    const high = Math.max(c.high, open, close);
    const low = Math.min(c.low, open, close);
    out.push({ time: c.time, open, high, low, close, volume: c.volume, open_: c.open_ });
    prevOpen = open;
    prevClose = close;
  }
  return out;
}

/** Инкрементально: следующая HA-свеча по предыдущей HA-свече (для обновления текущей). */
export function heikinNext(prev: Candle | undefined, c: Candle): Candle {
  const close = (c.open + c.high + c.low + c.close) / 4;
  const open = prev ? (prev.open + prev.close) / 2 : (c.open + c.close) / 2;
  return {
    time: c.time,
    open,
    high: Math.max(c.high, open, close),
    low: Math.min(c.low, open, close),
    close,
    volume: c.volume,
    open_: c.open_,
  };
}
