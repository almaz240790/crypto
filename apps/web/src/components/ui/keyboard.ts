/**
 * Клавиатурная навигация по группе элементов (вкладки, сегменты, пункты меню) — чистые функции,
 * общие для SegmentedControl и Menu. Недоступные элементы пропускаются, движение по кругу.
 */

export type NavKey = "next" | "prev" | "first" | "last";

/** Клавиша → направление: стрелки по ориентации группы, Home/End. Остальные клавиши — null. */
export function navKey(key: string, orientation: "horizontal" | "vertical"): NavKey | null {
  if (key === "Home") return "first";
  if (key === "End") return "last";
  if (orientation === "horizontal") {
    if (key === "ArrowRight") return "next";
    if (key === "ArrowLeft") return "prev";
  } else {
    if (key === "ArrowDown") return "next";
    if (key === "ArrowUp") return "prev";
  }
  return null;
}

/**
 * Индекс следующего доступного элемента. current = -1 — фокуса в группе ещё нет (next → первый,
 * prev → последний). Все недоступны — -1.
 */
export function rovingIndex(current: number, nav: NavKey, count: number, disabled: (i: number) => boolean = () => false): number {
  if (count <= 0) return -1;
  const ok = (i: number) => !disabled(i);
  if (nav === "first" || nav === "last") {
    const step = nav === "first" ? 1 : -1;
    for (let k = 0, i = nav === "first" ? 0 : count - 1; k < count; k++, i += step) if (ok(i)) return i;
    return -1;
  }
  const step = nav === "next" ? 1 : -1;
  let i = current < 0 ? (nav === "next" ? -1 : count) : current;
  for (let k = 0; k < count; k++) {
    i = (i + step + count) % count;
    if (ok(i)) return i;
  }
  return -1;
}

/**
 * Поиск по первым буквам (меню): следующий после current элемент, подпись которого начинается с query
 * (без учёта регистра). Не найден — -1.
 */
export function typeaheadIndex(labels: readonly string[], query: string, current: number, disabled: (i: number) => boolean = () => false): number {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return -1;
  const n = labels.length;
  for (let k = 1; k <= n; k++) {
    const i = (Math.max(current, -1) + k + n) % n;
    if (!disabled(i) && (labels[i] ?? "").trim().toLocaleLowerCase().startsWith(q)) return i;
  }
  return -1;
}
