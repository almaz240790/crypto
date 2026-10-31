"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { patchProfile } from "@/lib/auth-client";
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, localeFromCookie, makeT, type Locale, type T } from "./index";

type LocaleState = { locale: Locale; t: T; setLocale: (l: Locale) => void };

const Ctx = createContext<LocaleState>({ locale: DEFAULT_LOCALE, t: makeT(DEFAULT_LOCALE), setLocale: () => {} });

function writeCookie(l: Locale) {
  try {
    document.cookie = `${LOCALE_COOKIE}=${l}; path=/; max-age=${365 * 86400}; samesite=lax`;
  } catch {
    /* приватный режим */
  }
}

/** Локаль: с сервера (cookie / Accept-Language), затем профиль пользователя, если он задал язык. */
export function LocaleProvider({ initial, children }: { initial: Locale; children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initial);
  const { user } = useAuth();
  const router = useRouter();
  useEffect(() => {
    const fromUser = user?.locale;
    if (isLocale(fromUser) && fromUser !== localeFromCookie(document.cookie)) {
      writeCookie(fromUser);
      queueMicrotask(() => setLocaleState(fromUser));
    }
  }, [user?.locale]);
  const setLocale = useCallback(
    (l: Locale) => {
      writeCookie(l);
      setLocaleState(l);
      document.documentElement.lang = l;
      if (user) void patchProfile({ locale: l }).catch(() => {});
      router.refresh();
    },
    [user, router],
  );
  const value = useMemo(() => ({ locale, t: makeT(locale), setLocale }), [locale, setLocale]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useT(): T {
  return useContext(Ctx).t;
}

export function useLocale(): LocaleState {
  return useContext(Ctx);
}

/** Переключатель языка: две кнопки, активная подсвечена. */
export function LanguageSwitch() {
  const { locale, setLocale, t } = useLocale();
  return (
    <span role="group" aria-label={t("Язык")} style={{ display: "inline-flex", gap: 2 }}>
      {(["ru", "en"] as Locale[]).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => setLocale(l)}
          aria-pressed={locale === l}
          style={{ font: "inherit", fontSize: 12, padding: "2px 6px", border: "1px solid var(--border)", borderRadius: 6, background: locale === l ? "var(--row-hover)" : "transparent", color: locale === l ? "var(--text)" : "var(--text-2)", cursor: "pointer" }}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </span>
  );
}
