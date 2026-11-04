import type { SceneIndex } from "@platform/charts";
import type { FigureOnChart, PatternOnChart } from "@/lib/chart";

/**
 * Счётчики «Найдено» (план 2B.9 §8.1): одно правило для вкладки «Найдено (n)», разделов «Уровни / Фигуры /
 * Паттерны», бейджа «Объекты» и списков — число совпадает с тем, что показано.
 * - уровни — строки каталога сцены, кроме ликвидаций (они — свёрнутой группой «Ликвидации (оценка)» отдельно);
 * - фигуры — не отменённые, конец не левее видимого участка;
 * - паттерны — значимые, не левее видимого участка.
 * visibleFrom — время первой свечи в кадре (store.visible); null — ещё неизвестно (считаем все).
 */
export type FoundCounts = { levels: number; figures: number; patterns: number; total: number };

export const isLiqRow = (kind: string): boolean => kind.startsWith("liq-");

export function visibleFigures<T extends Pick<FigureOnChart, "status" | "end_t">>(items: readonly T[], visibleFrom: number | null): T[] {
  return items.filter((f) => f.status !== "invalidated" && (visibleFrom === null || f.end_t >= visibleFrom));
}

export function visiblePatterns<T extends Pick<PatternOnChart, "significant" | "t">>(items: readonly T[], visibleFrom: number | null): T[] {
  return items.filter((p) => p.significant && (visibleFrom === null || p.t >= visibleFrom));
}

export function foundCounts(index: Pick<SceneIndex, "levels"> | null, figures: readonly Pick<FigureOnChart, "status" | "end_t">[], patterns: readonly Pick<PatternOnChart, "significant" | "t">[], visibleFrom: number | null): FoundCounts {
  const levels = (index?.levels ?? []).filter((r) => !isLiqRow(r.kind)).length;
  const f = visibleFigures(figures, visibleFrom).length;
  const p = visiblePatterns(patterns, visibleFrom).length;
  return { levels, figures: f, patterns: p, total: levels + f + p };
}
