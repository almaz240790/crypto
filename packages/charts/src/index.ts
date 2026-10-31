/** Пакет графика (план 2B): обёртка LWC v5, буфер свечей, тема, слои, Heikin Ashi. */
export { createBuffer, EDGE, MAX_CANDLES, needsNewer, needsOlder, PAGE, prependOlder, pushLatest, replaceNewest } from "./buffer";
export type { BufferState } from "./buffer";
export { heikinAshi, heikinNext } from "./heikin";
export { LayerManager } from "./layers";
export type { Layer, LayerContext } from "./layers";
export { barsForWidth, createTerminal, Terminal, VIEW_BAR_PX, VIEW_MAX_BARS, VIEW_MIN_BARS } from "./terminal";
export type { PaneSeries, ScaleMode, TerminalOptions } from "./terminal";
export { LIQ_DEFAULTS, LIQ_MIN_OI_COVERAGE, liquidationMap, oiCoverage, SR_DEFAULTS, supportResistance } from "./levels";
export type { LiqBucket, LiqMap, LiqOptions, SrLevel, SrOptions } from "./levels";
export { DEFAULT_PRECISION, formatCompactValue, formatCountdown, formatSignedPercent, formatUsd, formatIndicatorValue, formatPercentValue, formatPriceLabel, formatPriceShort, formatTicks, tickDecimals, tickFormat, tickPrecision } from "./format";
export type { TickFormat } from "./format";
export { COMPACT_FORMAT, instrumentPriceFormat, PERCENT_FORMAT, priceFormatter, VALUE_FORMAT, withHiddenTicks } from "./priceFormat";
export type { InstrumentPriceFormat, PriceFormatter } from "./priceFormat";
export { alignToCandles } from "./derivatives";
export { alpha, chartOptions, DEFAULT_ALPHAS, PLAQUE, readChartTheme, RIGHT_OFFSET, seriesColors, tokensFromElement, toneColor } from "./theme";
export type { CanvasType, ChartAlphas, ChartPalette, ChartTheme } from "./theme";
export { CHART_TYPES, LAYER_KEYS, TF_SECONDS, TONES } from "./types";
export type { Candle, ChartType, Device, LayerKey, PanelKey, SceneLayer, ThemeTokens, Timeframe, Tone } from "./types";
export * from "./indicators";
export { bucketStart, foldMinute, isClosed, secondsToClose } from "./live";
export * from "./drawings";
// Разметка (PR B, план 2B.2): пресеты, сцена, раскладка подписей и шкалы — чистые модули.
// barsForWidth(plotW, view, tf) из presets.ts заменит barsForWidth из terminal.ts, когда терминал перейдёт на VIEW.
export { cleanOverrides, DEFAULT_LIMITS, DEFAULT_PRESET, deviceFor, hitTolerance, INDEX_LIMITS, INTERACTION, LAYERS_VERSION, normalizeMarkup, PHONE_MAX_WIDTH, PRESET_IDS, PRESETS, resolvePreset, SELECTABLE_PRESETS, selectPreset, setLayerOverride, VIEW } from "./presets";
export type { AxisBudget, LabelBudget, LayerLimits, LayerOverrides, LayerPreset, LevelKey, MarkupSettings, PresetId, ResolvedPreset, ViewPreset } from "./presets";
export * from "./scene";
export * from "./layout";
