/**
 * Подгонка строки по приоритетам (план 2B.9, раскладка шапки и тулбара): сколько элементов свернуть
 * до компактного вида и сколько спрятать (в меню «⋯» или в «Сводку»), чтобы строка влезла в ширину.
 * Чистая функция: ширины замерены заранее (useOverflow), здесь — только арифметика.
 */

/** Ширина элемента: полная и (если есть компактный вид) компактная, px. */
export type ItemWidth = { full: number; compact?: number };

/** Шаг сброса: «compact» — компактный вид (иконка без подписи), «hide» — элемент уходит из строки. */
export type ShedStep = { id: string; action: "compact" | "hide" };

export type Fit = { compact: ReadonlySet<string>; hidden: ReadonlySet<string> };

export const NO_FIT: Fit = { compact: new Set(), hidden: new Set() };

/**
 * Шаги применяются по порядку, пока сумма ширин видимых элементов и промежутков между ними больше
 * available. Элементы, которых нет в shed, не сворачиваются и не прячутся никогда (приоритет 0).
 * Шаг для отсутствующего элемента и «compact» без компактной ширины пропускаются; если спрятан
 * элемент, который раньше был свёрнут, он остаётся только в hidden.
 */
export function fitByPriority(widths: Readonly<Record<string, ItemWidth>>, shed: readonly ShedStep[], available: number, gap: number): Fit {
  const compact = new Set<string>();
  const hidden = new Set<string>();
  const width = (id: string) => (compact.has(id) ? (widths[id]!.compact ?? widths[id]!.full) : widths[id]!.full);
  const total = () => {
    const ids = Object.keys(widths).filter((id) => !hidden.has(id));
    return ids.reduce((s, id) => s + width(id), 0) + gap * Math.max(0, ids.length - 1);
  };
  for (const step of shed) {
    if (total() <= available) break;
    const w = widths[step.id];
    if (!w || hidden.has(step.id)) continue;
    if (step.action === "compact") {
      if (w.compact === undefined || w.compact >= w.full) continue;
      compact.add(step.id);
    } else {
      compact.delete(step.id);
      hidden.add(step.id);
    }
  }
  return { compact, hidden };
}

/** Два результата подгонки совпадают (не перерисовывать без нужды). */
export function sameFit(a: Fit, b: Fit): boolean {
  const eq = (x: ReadonlySet<string>, y: ReadonlySet<string>) => x.size === y.size && [...x].every((v) => y.has(v));
  return eq(a.compact, b.compact) && eq(a.hidden, b.hidden);
}
