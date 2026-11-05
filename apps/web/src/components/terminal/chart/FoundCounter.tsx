"use client";

import type { ChartState, ChartStore } from "@platform/charts";
import { useLayoutEffect, useRef, type ReactNode } from "react";
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

/** Форма числа для замера строки: 0 — бейджа нет, иначе число цифр (ширина меняется только с ним). */
export const countShape = (n: number): number => (n > 0 ? String(n).length : 0);

/**
 * Лист-счётчик «Найдено» (план 2B.9 §8.1, §10): вкладка «Найдено (n)» и бейдж «Объекты» в тулбаре. Перерисовывается
 * сам при сдвиге графика (store.visible) — TerminalShell и тулбар от видимого участка не зависят.
 * onTotal — сумма после каждого изменения (до отрисовки): владелец строки с приоритетами перемеряет её, когда
 * у числа меняется число цифр (countShape), — бейдж не уезжает за край тулбара.
 */
export function FoundCounter({ store, figures, patterns, onTotal, children }: { store: ChartStore; figures: readonly FigureOnChart[]; patterns: readonly PatternOnChart[]; onTotal?: (n: number) => void; children: (n: number) => ReactNode }) {
  const c = useFoundCounts(store, figures, patterns);
  const cb = useRef(onTotal);
  useLayoutEffect(() => {
    cb.current = onTotal;
  });
  useLayoutEffect(() => {
    cb.current?.(c.total);
  }, [c.total]);
  return <>{children(c.total)}</>;
}
