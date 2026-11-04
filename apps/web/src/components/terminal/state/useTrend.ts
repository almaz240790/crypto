"use client";

import { useMemo } from "react";
import type { LayersResponse } from "@/lib/chart";

export type TrendDir = "up" | "down" | "flat";

/**
 * Тренд старших таймфреймов для слота шапки (план 2B.9). Источник сейчас один — направление структуры
 * (bias D1 и W1) из /v1/chart/layers. Слот зарезервирован под «лесенку» «Разбора сверху вниз» (topdown,
 * план 2A.11.12): она заменит источник здесь, а шапка (порядок, приоритет скрытия) останется прежней.
 */
export type Trend = { source: "bias"; day: TrendDir; week: TrendDir };

const dir = (v: string | undefined): TrendDir => (v === "up" || v === "down" ? v : "flat");

export function useTrend(layers: LayersResponse | null): Trend | null {
  const bias = layers?.structure?.bias;
  const d1 = bias?.d1_trend;
  const w1 = bias?.w1_trend;
  return useMemo(() => (d1 === undefined && w1 === undefined ? null : { source: "bias", day: dir(d1), week: dir(w1) }), [d1, w1]);
}
