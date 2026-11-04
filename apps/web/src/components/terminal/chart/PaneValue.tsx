"use client";

import { formatCompactValue, formatIndicatorValue, type ChartState, type ChartStore, type IndicatorValue } from "@platform/charts";
import { useCallback } from "react";
import { useChartStore } from "./useChartStore";
import c from "./chart.module.css";

const EMPTY: readonly IndicatorValue[] = [];

/**
 * Значения индикатора в заголовке его панели (лист, план 2B.9 §10): под перекрестием — на свече под курсором,
 * иначе последние. Читает хранилище графика сам — заголовки и ChartSurface при движении курсора не перерисовываются.
 * compact — объём и OBV: запись как у их шкалы («955K», «1.05M»), а не «954 920.63».
 */
export function PaneValue({ store, uid, compact = false }: { store: ChartStore; uid: string; compact?: boolean }) {
  const select = useCallback((s: ChartState) => s.crosshair?.values ?? s.values, []);
  const all = useChartStore(select, store) ?? EMPTY;
  const values = all.filter((v) => v.uid === uid);
  if (values.length === 0) return null;
  return (
    <span className={c.paneValues}>
      {values.map((v) => (
        <span key={v.key} className="num" style={{ color: v.color }}>
          {v.value == null ? "—" : compact ? formatCompactValue(v.value) : formatIndicatorValue(v.value)}
        </span>
      ))}
    </span>
  );
}
