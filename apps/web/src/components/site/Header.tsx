"use client";

import Link from "next/link";
import { useAuth } from "@/components/auth/AuthProvider";
import { ThemeToggle } from "@/components/ui";
import { Logo } from "./Logo";
import s from "./Header.module.css";
import { LanguageSwitch, useT } from "@/i18n/client";

export function Header() {
  const t = useT();
  const { user } = useAuth();
  return (
    <header className={s.header}>
      <div className={`container ${s.inner}`}>
        <Link href="/" className={s.brand} aria-label="PlatformSol">
          <Logo />
        </Link>
        <nav className={s.nav} aria-label={t("разделы")}>
          <Link href="/chart">{t("График")}</Link>
          <Link href="/#features">{t("Возможности")}</Link>
          <Link href="/pricing">{t("Тарифы")}</Link>
          <Link href="/#faq">{t("Вопросы")}</Link>
        </nav>
        <div className={s.right}>
          <span className={s.desktopOnly}>
            <LanguageSwitch />
          </span>
          <ThemeToggle />
          {user ? (
            <Link href="/chart" className={`${s.pill} ${s.acc}`}>
              {t("Открыть график")}
            </Link>
          ) : (
            <>
              <Link href="/login" className={`${s.pill} ${s.line} ${s.desktopOnly}`}>
                {t("Войти")}
              </Link>
              <Link href="/register" className={`${s.pill} ${s.acc}`}>
                {t("Регистрация")}
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
