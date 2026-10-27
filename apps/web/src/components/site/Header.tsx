"use client";

import Link from "next/link";
import { Button, ThemeToggle } from "@/components/ui";
import s from "./Header.module.css";
import { LanguageSwitch, useT } from "@/i18n/client";

export function Header() {
  const t = useT();
  return (
    <header className={s.header}>
      <div className={`container ${s.inner}`}>
        <Link href="/" className={s.brand}>
          Platform
        </Link>
        <nav className={s.nav} aria-label={t("разделы")}>
          <Link href="/#signals">{t("Сигналы")}</Link>
          <Link href="/stats">{t("Статистика")}</Link>
          <Link href="/chart">{t("График")}</Link>
          <Link href="/#rules">{t("Правила")}</Link>
          <Link href="/#pricing">{t("Тарифы")}</Link>
          <Link href="/#faq">{t("Вопросы")}</Link>
        </nav>
        <div className={s.right}>
          <LanguageSwitch />
            <ThemeToggle />
          <Button href="/login" variant="primary" size="sm">{t("Войти")}</Button>
        </div>
      </div>
    </header>
  );
}
