"use client";

import { useEffect, useState } from "react";
import { Button, Panel } from "@/components/ui";
import { DEFAULT_LOCALE, localeFromCookie, makeT, type Locale } from "@/i18n";

/** Страница кэшируется service worker'ом при установке, поэтому язык берём из cookie в момент показа, а не со сборки. */
export function OfflineBody() {
  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE);
  useEffect(() => {
    const l = localeFromCookie(document.cookie);
    if (l) queueMicrotask(() => setLocale(l));
  }, []);
  const t = makeT(locale);
  return (
    <Panel title={t("Нет соединения")}>
      <p className="text-2">{t("Сигналы и цены не кэшируются, чтобы вы не видели устаревшие данные. Проверьте сеть и обновите страницу.")}</p>
      <div style={{ marginTop: 12 }}>
        <Button href="/chart">{t("Повторить")}</Button>
      </div>
    </Panel>
  );
}
