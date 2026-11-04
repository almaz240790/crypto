"use client";

import type { ChartState, ChartStore } from "@platform/charts";
import type { ReactNode } from "react";
import type { FigureOnChart, PatternOnChart } from "@/lib/chart";
import { foundCounts, type FoundCounts } from "../panels/found/counts";
import { useChartStore } from "./useChartStore";

const selectIndex = (s: ChartState) => s.sceneIndex;
const selectFrom = (s: ChartState) => s.visible.fromTime;

/** Счётчики «Найдено» по хранилищу графика (сцена и видимый участок) — для листов. */
export function useFoundCounts(store: ChartStore, figures: readonly FigureOnChart[], patterns: readonly PatternOnChart[]): FoundCounts {
  const index = useChartStore(selectIndex, store);
  const visibleFrom = useChartStore(selectFrom, store);
  return foundCounts(index, figures, patterns, visibleFrom);
}

/**
 * Лист-счётчик «Найдено» (план 2B.9 §8.1, §10): вкладка «Найдено (n)» и бейдж «Объекты» в тулбаре. Перерисовывается
 * сам при сдвиге графика (store.visible) — TerminalShell и тулбар от видимого участка не зависят.
 */
export function FoundCounter({ store, figures, patterns, children }: { store: ChartStore; figures: readonly FigureOnChart[]; patterns: readonly PatternOnChart[]; children: (n: number) => ReactNode }) {
  const c = useFoundCounts(store, figures, patterns);
  return <>{children(c.total)}</>;
}
