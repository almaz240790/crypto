/**
 * Что умеет график — для главной и тарифов (ADR-0006). Списки сверяются с кодом графика
 * в capabilities.test.ts, чтобы маркетинговые цифры не расходились с продуктом.
 */

export type Pane = "overlay" | "separate" | "derivatives";

/** Индикаторы — как в packages/charts/src/indicators/registry.ts (короткие названия). */
export const INDICATOR_LIST: { name: string; pane: Pane }[] = [
  { name: "EMA", pane: "overlay" },
  { name: "SMA", pane: "overlay" },
  { name: "VWAP", pane: "overlay" },
  { name: "Bollinger Bands", pane: "overlay" },
  { name: "Ichimoku", pane: "overlay" },
  { name: "Supertrend", pane: "overlay" },
  { name: "Keltner", pane: "overlay" },
  { name: "RSI", pane: "separate" },
  { name: "MACD", pane: "separate" },
  { name: "Stochastic", pane: "separate" },
  { name: "ATR", pane: "separate" },
  { name: "CCI", pane: "separate" },
  { name: "OBV", pane: "separate" },
  { name: "Volume", pane: "separate" },
];

/** Панели данных деривативов (TerminalView: funding, oi, liq, ls). */
export const DERIVATIVE_PANELS = ["Funding", "Open interest", "Ликвидации", "Long / Short"];

/** Инструменты рисования, сгруппированные для витрины; всего — TOOL_TITLES в packages/charts/src/drawings/types.ts. */
export const TOOL_GROUPS: { name: string; note: string }[] = [
  { name: "Трендовая линия", note: "луч и продлённая линия" },
  { name: "Горизонтальные уровни", note: "линия и луч" },
  { name: "Параллельный канал", note: "по трём точкам" },
  { name: "Фибоначчи", note: "от 0,236 до 1,618" },
  { name: "Позиция Long и Short", note: "вход, стоп, цель и R:R" },
  { name: "Прямоугольник", note: "зоны и диапазоны" },
  { name: "Измеритель", note: "изменение цены в %" },
  { name: "Заметка", note: "подпись прямо на графике" },
];

/** Графические фигуры движка (packages/engine/engine/figures/types.py). */
export const FIGURES_COUNT = 15;

/** Слои автоматической разметки без слоя сигналов (TerminalPage, LAYER_LABEL). */
export const AUTO_LAYERS_COUNT = 8;

export const COUNTS = {
  indicators: INDICATOR_LIST.length,
  tools: 13,
  layers: AUTO_LAYERS_COUNT,
  figures: FIGURES_COUNT,
  timeframes: 7,
};
