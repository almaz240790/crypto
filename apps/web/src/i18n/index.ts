/**
 * Переводы интерфейса (план, раздел 1: русский и английский). Ключ словаря — исходная
 * русская строка; для «ru» возвращается она же, для «en» — перевод из en.json или исходник,
 * если перевода ещё нет (страница остаётся рабочей, просто по-русски). См. ADR-0005.
 *
 * Переводы разделов сигналов — отдельный словарь en.signals.json (ADR-0013): общий en.json попадает в JS каждой
 * страницы, и, пока сигналы закрыты, в нём не должно быть их текстов. Сервер подключает его всегда
 * (i18n/server.ts — в браузер не попадает), браузер подгружает отдельным файлом только тем, кому сигналы видны
 * (LocaleProvider). Какие ключи туда идут — проверяет scripts/check-i18n.mjs.
 */
import en from "./en.json";

export type Locale = "ru" | "en";
export const LOCALES: Locale[] = ["ru", "en"];
export const DEFAULT_LOCALE: Locale = "ru";
export const LOCALE_COOKIE = "pl_locale";

/** Словарь «русский исходник → перевод». */
export type Dict = Record<string, string>;

const EN = en as Dict;

export function isLocale(v: unknown): v is Locale {
  return v === "ru" || v === "en";
}

/** extra — дополнительный словарь (переводы разделов сигналов, en.signals.json). */
export function translate(locale: Locale, s: string, extra?: Dict): string {
  if (locale === "ru") return s;
  return EN[s] ?? extra?.[s] ?? s;
}

/** Перевод с подстановками: t("Сделок: {n}", { n: 3 }). */
export function translateWith(locale: Locale, s: string, vars: Record<string, string | number>, extra?: Dict): string {
  return translate(locale, s, extra).replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
}

export type T = (s: string, vars?: Record<string, string | number>) => string;

export function makeT(locale: Locale, extra?: Dict): T {
  return (s, vars) => (vars ? translateWith(locale, s, vars, extra) : translate(locale, s, extra));
}

/** Локаль из строки cookie (document.cookie или заголовок Cookie). */
export function localeFromCookie(cookie: string | null | undefined): Locale | null {
  const m = /(?:^|;\s*)pl_locale=(ru|en)(?:;|$)/.exec(cookie ?? "");
  return m ? (m[1] as Locale) : null;
}

/** Локаль из Accept-Language: английский, если он идёт раньше русского. */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale {
  const langs = (header ?? "").toLowerCase().split(",").map((x) => x.trim().split(";")[0] ?? "");
  for (const l of langs) {
    if (l.startsWith("ru")) return "ru";
    if (l.startsWith("en")) return "en";
  }
  return DEFAULT_LOCALE;
}
