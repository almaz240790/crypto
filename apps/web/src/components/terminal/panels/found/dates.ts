import type { Locale } from "@/i18n";

/** Даты в «Найдено» (план 2B.9 §8.1): модульный кэш Intl.DateTimeFormat по локали, всегда UTC — без toLocaleString в рендере. */
const cache = new Map<Locale, Intl.DateTimeFormat>();

export function formatBarTime(sec: number, locale: Locale): string {
  let f = cache.get(locale);
  if (!f) {
    f = new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "ru-RU", { timeZone: "UTC", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    cache.set(locale, f);
  }
  return `${f.format(new Date(sec * 1000))} UTC`;
}
