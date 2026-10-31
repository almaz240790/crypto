"use client";

/**
 * Переходный реэкспорт (план 2B.2): поверхность графика теперь chart/ChartSurface.tsx на ChartController.
 * Имя TerminalView и типы остаются до PR C, чтобы импорты страниц не менялись одной правкой со всем остальным.
 */
export { ChartSurface as TerminalView, ChartSurface, IND_COLOR_VAR, INDICATORS, INDICATOR_COLOR, PANELS, indicatorColor } from "./chart/ChartSurface";
export type { ActiveIndicator, CrosshairInfo, IndColor, LayerKey, PanelKey, TerminalControls } from "./chart/ChartSurface";
