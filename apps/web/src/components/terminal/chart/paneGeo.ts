import type { IndicatorInstance, SepLimits } from "@platform/charts";

/**
 * Геометрия панелей графика для управления ими (ADR-0009, «Управление панелями»): координаты колонки графика, CSS px.
 * Считает ChartSurface, рисует PaneChrome; границы и места кнопок — чистые функции (vitest).
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
  /**
   * Свёрнутая панель в общей строке «ещё N панелей» (строк на все панели не хватило, planPanes): своего заголовка
   * у неё нет — у остальных полоска GROUPED_PX под заслонкой, у host — строка с кнопками раскрытия.
   */
  grouped?: boolean;
  /** Только у host: панели общей строки по порядку (и сама host) — кнопки раскрытия. */
  group?: { key: string; testId: string; title: string }[];
};

/** limits — пределы перетаскивания границ (доля основной, минимум панели, сжатие окном): по ним граница стоит или нет. */
export type ChartGeo = { panes: PaneGeo[]; plotW: number; scaleW: number; width: number; limits: SepLimits };

/** Граница, которую можно тянуть: y — линия между панелями, above / below — индексы меняемых панелей. */
export type PaneSep = { y: number; above: number; below: number; key: string };

/**
 * Размеры управления панелями поверх холста, px (стили — chart.module.css). Зона границы лежит над линией, в нижней
 * полосе раскрытой панели выше неё: так её не закрывает заголовок панели ниже (он начинается от линии). Ручка
 * и «A» — у правого края области графика, левее шкалы цены: «A» в углу панели, ручка левее «A»; заголовки — слева.
 */
export const PANE_UI = {
  /** Зона границы: над линией и под ней (на 1 px — сама линия LWC). Под пальцем — 12 px, ручка — 44 × 44. */
  sepAbove: 8,
  sepAboveTouch: 12,
  sepBelow: 1,
  /** Ручка: зона касания (ширина × высота) — десктоп 32 × 12, под пальцем 44 × 44. */
  grip: { w: 32, h: 12 },
  gripTouch: { w: 44, h: 44 },
  /** «A»: десктоп 20 (IconButton xs), под пальцем 44. */
  auto: 20,
  autoTouch: 44,
  /** Отступ от шкалы цены, от низа панели и между «A» и ручкой. */
  edge: 4,
  gap: 8,
} as const;

/** Зона границы над линией, px. */
export const sepAbove = (coarse: boolean): number => (coarse ? PANE_UI.sepAboveTouch : PANE_UI.sepAbove);

/** Ручка границы: левый край и размер — левее столбца «A» у шкалы цены. */
export function gripBox(plotW: number, coarse: boolean): { left: number; w: number; h: number } {
  const g = coarse ? PANE_UI.gripTouch : PANE_UI.grip;
  const a = coarse ? PANE_UI.autoTouch : PANE_UI.auto;
  return { left: Math.max(0, plotW - PANE_UI.edge - a - PANE_UI.gap - g.w), w: g.w, h: g.h };
}

/**
 * «A» (автомасштаб) панели: правый нижний угол области графика, вплотную к шкале цены, над зоной границы ниже.
 * Не на шкале — не закрывает её деления и метку последнего значения; справа от последней свечи место пустое.
 */
export function autoBox(p: Pick<PaneGeo, "top" | "height">, plotW: number, coarse: boolean): { left: number; top: number; size: number } {
  const size = coarse ? PANE_UI.autoTouch : PANE_UI.auto;
  const top = p.top + p.height - sepAbove(coarse) - PANE_UI.edge - size;
  return { left: Math.max(0, plotW - PANE_UI.edge - size), top: Math.max(p.top, top), size };
}

/**
 * Границы панелей: одна на каждую пару соседних раскрытых панелей (свёрнутые до заголовка между ними пропускаются).
 * Линия — низ верхней раскрытой панели: зона границы лежит в её нижней полосе, а не на заголовке свёрнутой панели
 * или панели ниже. Без раскрытой панели ниже и в режиме «развернуть» — границ нет.
 */
export function paneSeparators(panes: readonly PaneGeo[], maximized: boolean): PaneSep[] {
  if (maximized || panes.length < 2) return [];
  const out: PaneSep[] = [];
  let above = 0;
  for (let i = 1; i < panes.length; i++) {
    if (panes[i]!.collapsed) continue;
    const line = panes[above + 1]!;
    out.push({ y: line.top, above: panes[above]!.index, below: panes[i]!.index, key: line.key });
    above = i;
  }
  return out;
}

/**
 * Заслонки над полосками свёрнутых в общую строку панелей (2 px каждая, своего заголовка нет): во всю ширину графика
 * (и шкалу цены), подряд идущие — одной заслонкой. Без них видны стопка линий между панелями и обрезки подписей шкалы.
 * Сверху на пиксель выше — вместе с линией над первой полоской.
 */
export function groupCovers(panes: readonly PaneGeo[]): { key: string; top: number; height: number }[] {
  const out: { key: string; top: number; height: number }[] = [];
  let run: PaneGeo[] = [];
  const close = () => {
    const a = run[0];
    const b = run[run.length - 1];
    if (a && b) {
      const top = a.top - 1;
      out.push({ key: `cover:${a.key}`, top, height: Math.max(1, b.top + b.height - top) });
    }
    run = [];
  };
  for (const p of panes) {
    if (p.grouped && !p.group) run.push(p);
    else close();
  }
  close();
  return out;
}
