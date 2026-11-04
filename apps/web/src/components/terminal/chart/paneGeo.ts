import type { IndicatorInstance } from "@platform/charts";

/**
 * Геометрия панелей графика для управления ими (ADR-0009, «Управление панелями»): координаты колонки графика, CSS px.
 * Считает ChartSurface, рисует PaneChrome; границы — чистая функция (vitest).
 */

/** Панель на экране: основная (key "main", index 0) или панель под графиком. */
export type PaneGeo = {
  key: string;
  index: number;
  title: string;
  top: number;
  height: number;
  /** Свёрнута до заголовка (в том числе на время «развернуть» другой панели). */
  collapsed: boolean;
  color?: string;
  testId: string;
  /** Значения в заголовке: у индикаторов — да, у панелей данных фьючерсов — нет. */
  values: boolean;
  compactValues: boolean;
  /** Экземпляр с параметрами — кнопка «настройки»; null — у панели нет параметров. */
  inst: IndicatorInstance | null;
  /** Шкалу цены растянули вручную (автомасштаб выключен): показывается «A». */
  manual: boolean;
  /** Шкалу можно тянуть (процентная шкала основной панели — нельзя): подсветка под курсором. */
  scalable: boolean;
};

export type ChartGeo = { panes: PaneGeo[]; plotW: number; scaleW: number; width: number };

/** Граница, которую можно тянуть: y — линия между панелями, above / below — индексы меняемых панелей. */
export type PaneSep = { y: number; above: number; below: number; key: string };

/**
 * Границы панелей: между каждой парой соседних — линия; тянется пара ближайших раскрытых панелей выше и ниже
 * (свёрнутые до заголовка пропускаются). Без раскрытой панели ниже и в режиме «развернуть» — границы не тянутся.
 */
export function paneSeparators(panes: readonly PaneGeo[], maximized: boolean): PaneSep[] {
  if (maximized) return [];
  const out: PaneSep[] = [];
  for (let i = 1; i < panes.length; i++) {
    let above = i - 1;
    while (above > 0 && panes[above]!.collapsed) above--;
    let below = i;
    while (below < panes.length && panes[below]!.collapsed) below++;
    if (below >= panes.length || panes[above]!.collapsed) continue;
    out.push({ y: panes[i]!.top, above: panes[above]!.index, below: panes[below]!.index, key: panes[i]!.key });
  }
  return out;
}
