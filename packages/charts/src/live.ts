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
