import { FIB_LEVELS, FIB_LEVELS_MAX, FIB_LEVEL_DECIMALS, FIB_LEVEL_LIMIT, type Drawing } from "./types";

/**
 * Уровни Фибоначчи рисунка (план 2A.5; ADR-0009, «Рисование», дополнение 2026-11-11): один набор правил для
 * карточки рисунка, контроллера (новый рисунок), чтения сохранённых и пришедших с сервера рисунков и настроек.
 */

const SCALE = 10 ** FIB_LEVEL_DECIMALS;

/** Уровень как он хранится: конечное число в пределах ±FIB_LEVEL_LIMIT, 3 знака; иначе null. */
function cleanLevel(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  // + 0: «−0» после округления (−0.0001) — это уровень 0
  const r = Math.round(v * SCALE) / SCALE + 0;
  return Math.abs(r) <= FIB_LEVEL_LIMIT ? r : null;
}

/**
 * Набор уровней как он хранится: конечные числа в пределах ±FIB_LEVEL_LIMIT, округлённые до 3 знаков, без повторов,
 * по возрастанию, не больше FIB_LEVELS_MAX (то, что принимает сервер). Не массив (null, undefined — поля нет),
 * пустой список и мусор без единого числа — уровни по умолчанию FIB_LEVELS. Всегда новый массив.
 */
export function normalizeFibLevels(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [...FIB_LEVELS];
  const seen = new Set<number>();
  for (const v of raw as unknown[]) {
    const r = cleanLevel(v);
    if (r !== null) seen.add(r);
  }
  if (seen.size === 0) return [...FIB_LEVELS];
  return [...seen].sort((a, b) => a - b).slice(0, FIB_LEVELS_MAX);
}

/** Два набора показывают одни и те же уровни (после приведения). */
export function sameFibLevels(a: unknown, b: unknown): boolean {
  const x = normalizeFibLevels(a), y = normalizeFibLevels(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * Включить или выключить уровень в наборе. Последний оставшийся уровень не выключается (Фибоначчи без уровней —
 * две ручки без линий): набор возвращается как был.
 */
export function toggleFibLevel(levels: unknown, level: number): number[] {
  const cur = normalizeFibLevels(levels);
  const want = cleanLevel(level);
  if (want === null) return cur;
  if (!cur.includes(want)) return normalizeFibLevels([...cur, want]);
  return cur.length > 1 ? cur.filter((l) => l !== want) : cur;
}

/** Уровень в подписи и на кнопке: минус — типографский, как у цен и процентов («−0.618»). */
export function fibLevelText(level: number): string {
  return `${level < 0 ? "−" : ""}${Math.abs(level)}`;
}

/** Группа уровня: цели по движению (за второй точкой), коррекция (между точками), за началом (за первой точкой). */
export type FibLevelGroup = "targets" | "retracement" | "beyond";
export const FIB_LEVEL_GROUPS: readonly FibLevelGroup[] = ["targets", "retracement", "beyond"];

export function fibLevelGroup(level: number): FibLevelGroup {
  return level < 0 ? "targets" : level <= 1 ? "retracement" : "beyond";
}

/**
 * Рисунок из localStorage или с сервера: у Фибоначчи уровни приводятся (пустой список и мусор — уровни по умолчанию),
 * поля нет — так и остаётся (рисуются FIB_LEVELS, как раньше); у остальных типов уровней нет. Рисунок, которому
 * правка не нужна, возвращается тем же объектом (updated_at не меняется — в синхронизацию он не уходит).
 */
export function cleanDrawingLevels<T extends Pick<Drawing, "type" | "levels">>(d: T): T {
  if (d.levels === undefined) return d;
  if (d.type !== "fib" || d.levels === null) {
    const { levels: _l, ...rest } = d;
    void _l;
    return rest as T;
  }
  const raw: unknown = d.levels;
  const clean = normalizeFibLevels(raw);
  const same = Array.isArray(raw) && raw.length === clean.length && clean.every((v, i) => v === (raw as unknown[])[i]);
  return same ? d : { ...d, levels: clean };
}

/**
 * Уровни Фибоначчи, изменённые шагом истории (отмена, повтор): набор живого рисунка, у которого после шага уровни
 * другие. null — шаг уровней не менял (сдвиг, удаление, новый рисунок).
 */
export function changedFibLevels(before: readonly Drawing[], after: readonly Drawing[]): number[] | null {
  const prev = new Map(before.map((d) => [d.id, d]));
  let out: number[] | null = null;
  for (const d of after) {
    const was = prev.get(d.id);
    if (!was || was === d || d.type !== "fib" || d.deleted_at || was.deleted_at) continue;
    if (!sameFibLevels(was.levels, d.levels)) out = normalizeFibLevels(d.levels);
  }
  return out;
}
