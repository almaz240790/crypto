/**
 * Вкладка «Форвард-тест» на /stats (план 2.11, 3.10): форвард считается только по одной версии
 * стратегии, пункта «все» нет. Какую версию посчитал API, он называет в поле strategy_version;
 * какие версии можно выбрать — в поле versions.
 */
import type { StrategyVersionInfo, StrategyVersionRef } from "./api";

/**
 * Версии для селектора форварда, по возрастанию id.
 *
 * listed — поле versions из ответа API: версии в статусе forward и версии, которые ушли из
 * форварда (например, в архив), но оставили записанную форвард-историю. Если поля нет (API
 * старше веб-сборки или недоступен), берём версии в статусе forward из /v1/strategies.
 * current — версия, посчитанная в ответе: она есть в списке всегда, даже если открыта по явному
 * адресу и в списке API её нет.
 */
export function forwardVersionOptions(
  listed: StrategyVersionRef[] | null | undefined,
  all: StrategyVersionInfo[],
  current: StrategyVersionRef | null | undefined,
): StrategyVersionRef[] {
  const out: StrategyVersionRef[] = (listed ?? all.filter((v) => v.status === "forward")).map(
    ({ id, strategy, name, version, status }) => ({ id, strategy, name, version, status }),
  );
  if (current && !out.some((v) => v.id === current.id)) out.push(current);
  return out.sort((a, b) => a.id - b.id);
}

/**
 * Что сказать, когда по форварду нечего показать:
 * - "none" — ни одна версия не в форварде (API не назвал версию);
 * - "filtered" — версия есть, но заданы фильтры: сделок нет по ним, а не вообще;
 * - "no-trades" — версия в форварде, сделок пока нет;
 * - "not-forward" — версия не в статусе forward (архив, backtest, live) и форвард-статистики
 *   по ней нет. «Пока нет сделок» здесь было бы неправдой: форвард она не проходит.
 */
export type ForwardEmpty = "none" | "filtered" | "no-trades" | "not-forward";

export function forwardEmptyKind(current: StrategyVersionRef | null | undefined, filtered: boolean): ForwardEmpty {
  if (!current) return "none";
  if (filtered) return "filtered";
  return current.status === "forward" ? "no-trades" : "not-forward";
}
