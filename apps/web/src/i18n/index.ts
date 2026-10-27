/**
 * Переводы интерфейса (план, раздел 1: русский и английский). Ключ словаря — исходная
 * русская строка; для «ru» возвращается она же, для «en» — перевод из en.json или исходник,
 * если перевода ещё нет (страница остаётся рабочей, просто по-русски). См. ADR-0005.
 */
import en from "./en.json";

export type Locale = "ru" | "en";
export const LOCALES: Locale[] = ["ru", "en"];
export const DEFAULT_LOCALE: Locale = "ru";
export const LOCALE_COOKIE = "pl_locale";

const EN = en as Record<string, string>;

export function isLocale(v: unknown): v is Locale {
  return v === "ru" || v === "en";
}

export function translate(locale: Locale, s: string): string {
  if (locale === "ru") return s;
  return EN[s] ?? s;
}

/** Перевод с подстановками: t("Сделок: {n}", { n: 3 }). */
export function translateWith(locale: Locale, s: string, vars: Record<string, string | number>): string {
  return translate(locale, s).replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
}

export type T = (s: string, vars?: Record<string, string | number>) => string;

export function makeT(locale: Locale): T {
  return (s, vars) => (vars ? translateWith(locale, s, vars) : translate(locale, s));
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
