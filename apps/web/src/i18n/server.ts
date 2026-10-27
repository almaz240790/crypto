import { cookies, headers } from "next/headers";
import { DEFAULT_LOCALE, isLocale, localeFromAcceptLanguage, makeT, type Locale, type T } from "./index";

/** Локаль для серверных компонентов: cookie pl_locale, иначе Accept-Language. */
export async function getLocale(): Promise<Locale> {
  const c = (await cookies()).get("pl_locale")?.value;
  if (isLocale(c)) return c;
  try {
    return localeFromAcceptLanguage((await headers()).get("accept-language"));
  } catch {
    return DEFAULT_LOCALE;
  }
}

export async function getT(): Promise<T> {
  return makeT(await getLocale());
}
