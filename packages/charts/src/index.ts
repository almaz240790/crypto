/** Пакет графика (план 2B): обёртка LWC v5, буфер свечей, тема, слои, Heikin Ashi. */
export { createBuffer, EDGE, MAX_CANDLES, needsNewer, needsOlder, PAGE, prependOlder, pushLatest, replaceNewest } from "./buffer";
export type { BufferState } from "./buffer";
export { heikinAshi, heikinNext } from "./heikin";
export { LayerManager } from "./layers";
export type { Layer, LayerContext } from "./layers";
export { createTerminal, Terminal } from "./terminal";
export type { PaneSeries, TerminalOptions } from "./terminal";
export { alpha, chartOptions, seriesColors, tokensFromElement } from "./theme";
export { CHART_TYPES, TF_SECONDS } from "./types";
export type { Candle, ChartType, ThemeTokens, Timeframe } from "./types";
export * from "./indicators";
