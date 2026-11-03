"use client";

import type { ChartState, ChartStore } from "@platform/charts";
import { createContext, useCallback, useContext, useSyncExternalStore } from "react";

/** Хранилище графика для листовых компонентов (план 2B.2): создаёт владелец — TerminalPage или ячейка мультичарта. */
export const ChartStoreContext = createContext<ChartStore | null>(null);

/**
 * Срез состояния графика: useSyncExternalStore, селектор возвращает срез или примитив, поэтому компонент
 * перерисовывается только при смене именно этого среза. store — явно или из ChartStoreContext.
 */
export function useChartStore<T>(selector: (s: ChartState) => T, store?: ChartStore | null): T {
  const ctx = useContext(ChartStoreContext);
  const s = store ?? ctx;
  if (!s) throw new Error("useChartStore: нет ChartStore (ChartStoreContext.Provider)");
  const get = useCallback(() => selector(s.getState()), [s, selector]);
  return useSyncExternalStore(s.subscribe, get, get);
}
