/**
 * Вкладка «Форвард-тест» на /stats (план 2.11, 3.10): форвард считается только по одной версии
 * стратегии, пункта «все» нет. Какую версию посчитал API, он называет в поле strategy_version.
 */
import type { StrategyVersionInfo, StrategyVersionRef } from "./api";

/** Версии для селектора форварда: версии в статусе forward и та, что посчитана в ответе API
 * (явно запрошенная версия может быть уже не в форварде). Порядок — по id. */
export function forwardVersionOptions(
  all: StrategyVersionInfo[],
  current: StrategyVersionRef | null | undefined,
): StrategyVersionInfo[] {
  const out = all.filter((v) => v.status === "forward");
  if (current && !out.some((v) => v.id === current.id)) {
    out.push({ ...current, activated_at: all.find((v) => v.id === current.id)?.activated_at ?? null });
  }
  return out.sort((a, b) => a.id - b.id);
}
