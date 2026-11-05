import type { ChartType, ScaleMode } from "@platform/charts";

/** Подписи вида графика (через t()): тип и шкала — в «Виде» на десктопе и в верхней строке телефона. */
export const TYPE_LABEL: Record<ChartType, string> = { candles: "Свечи", bars: "Бары", line: "Линия", heikin: "Heikin Ashi" };
export const SCALE_LABEL: Record<ScaleMode, string> = { linear: "линейная", log: "логарифмическая", percent: "проценты" };
