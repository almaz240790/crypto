import { useSyncExternalStore } from "react";

/**
 * Брейкпоинты интерфейса (план 2B.9, ADR «Раскладка терминала») — единственный источник.
 * Телефон — ширина окна < 900, десктоп — ≥ 900 (без пересечения ровно на 900 px: max-width 899.98px),
 * широкий десктоп — ≥ 1280. Класс устройства графика (deviceFor, порог 640 по ширине области графика)
 * — другое понятие: он считается по контейнеру, а не по окну.
 *
 * CSS не может импортировать эти строки, поэтому в стилях терминала, AppShell и ui разрешены только
 * запросы из CSS_MEDIA (проверяет breakpoints.test.ts); в коде — только MQ.
 */
export const BP = { phone: 640, desktop: 900, wide: 1280 } as const;

export const MQ = {
  desktop: "(min-width: 900px)",
  mobile: "(max-width: 899.98px)",
  wide: "(min-width: 1280px)",
  coarse: "(pointer: coarse)",
  phoneLandscape: "(orientation: landscape) and (max-height: 520px) and (pointer: coarse)",
} as const;

/** Медиа-условия, разрешённые в CSS терминала, AppShell и ui: ширины — только из BP, без пересечений. */
export const CSS_MEDIA_WIDTHS: readonly string[] = ["(min-width: 900px)", "(max-width: 899.98px)", "(min-width: 1280px)", "(max-width: 1279.98px)", "(max-width: 639.98px)"];
/**
 * Запросы по высоте — только как ландшафт телефона. Вариант без pointer: coarse — нынешний ландшафт
 * терминала до раскладки телефона (C2), которая переводит его на MQ.phoneLandscape.
 */
export const CSS_MEDIA_LANDSCAPE: readonly string[] = [MQ.phoneLandscape, "(orientation: landscape) and (max-height: 520px)"];

/** Раскладка страницы: ландшафт телефона имеет приоритет при любой ширине (например, 932×430). */
export type LayoutClass = "desktop" | "phone" | "landscape";

export function layoutFor(m: { desktop: boolean; landscape: boolean }): LayoutClass {
  if (m.landscape) return "landscape";
  return m.desktop ? "desktop" : "phone";
}

const noop = () => () => {};

/** Одна функция подписки на запрос: стабильная ссылка, иначе useSyncExternalStore переподписывается на каждом рендере. */
const subscribers = new Map<string, (cb: () => void) => () => void>();
function subscribeTo(query: string) {
  let fn = subscribers.get(query);
  if (!fn) {
    fn = (cb: () => void) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const mq = window.matchMedia(query);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    };
    subscribers.set(query, fn);
  }
  return fn;
}

const matches = (query: string) => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(query).matches;

/**
 * Совпадает ли медиа-запрос (useSyncExternalStore по matchMedia). На сервере и при гидратации — ssr
 * (по умолчанию false), затем — фактическое значение без лишнего кадра.
 */
export function useMediaQuery(query: string, ssr = false): boolean {
  return useSyncExternalStore(
    typeof window === "undefined" ? noop : subscribeTo(query),
    () => matches(query),
    () => ssr,
  );
}

/** Раскладка страницы по окну: desktop (≥ 900), phone (< 900) или landscape (ландшафт телефона). */
export function useLayout(): LayoutClass {
  const desktop = useMediaQuery(MQ.desktop, true);
  const landscape = useMediaQuery(MQ.phoneLandscape);
  return layoutFor({ desktop, landscape });
}
