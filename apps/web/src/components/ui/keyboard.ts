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

/**
 * Буква сочетания клавиш (Ctrl+Z, Alt+H): латинская буква e.key — она (так работают и другие латинские раскладки,
 * AZERTY и Dvorak); иначе — буква клавиши по e.code. На русской раскладке Chrome отдаёт в e.key «я» для Ctrl+Z, на
 * Mac Option+H — «˙»: по одной e.key такие сочетания не срабатывали. Не буква — null.
 */
export function shortcutLetter(e: Pick<KeyboardEvent, "key" | "code">): string | null {
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase();
  const m = /^Key([A-Z])$/.exec(e.code);
  return m ? m[1]!.toLowerCase() : null;
}

/** Поля ввода без текста: на них сочетания клавиш работают, как на кнопке. */
const NON_TEXT_INPUTS: ReadonlySet<string> = new Set(["checkbox", "radio", "button", "submit", "reset"]);

/**
 * Фокус в поле, куда вводят текст (поле ввода, textarea, select): там клавиши — тексту, сочетания терминала (Esc,
 * Delete, Ctrl+Z, цифры) не срабатывают. Флажок, переключатель и кнопка — не поле ввода: после нажатия флажка
 * в карточке рисунка («Линии до края», «на всех таймфреймах») Esc снимает выбор, Ctrl+Z отменяет правку.
 */
export function typingTarget(target: EventTarget | null): boolean {
  const el = target as { tagName?: unknown; type?: unknown } | null;
  const tag = typeof el?.tagName === "string" ? el.tagName : "";
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  return !NON_TEXT_INPUTS.has(typeof el?.type === "string" ? el.type.toLowerCase() : "text");
}
