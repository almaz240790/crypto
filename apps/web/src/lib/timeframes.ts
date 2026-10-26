/** Таймфреймы терминала (план 2A.3): общий список для серверных и клиентских модулей. */
export const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d", "1w"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];
export const INTRADAY: readonly Timeframe[] = ["1m", "5m", "15m"];
