"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { Logo } from "./Logo";
import s from "./Header.module.css";
import { LanguageSwitch, useT } from "@/i18n/client";

/** Шапка маркетинговых страниц: всегда чёрная (сетка по образцу robinhood.com, ADR-0006); на телефоне — меню-«гамбургер». */
export function Header() {
  const t = useT();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const burgerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // меню закрывается клавишей Esc; фокус из меню возвращается на кнопку меню
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const focusInMenu = menuRef.current?.contains(document.activeElement) ?? false;
      setOpen(false);
      if (focusInMenu) burgerRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  const nav = [
    { href: "/chart", label: t("График") },
    { href: "/#features", label: t("Возможности") },
    { href: "/pricing", label: t("Подписка") },
    { href: "/support", label: t("Вопросы") },
  ];
  return (
    <header className={s.header} data-open={open || undefined}>
      <div className={s.inner}>
        <Link href="/" className={s.brand} aria-label="PlatformSol">
          <Logo />
        </Link>
        <nav className={s.nav} aria-label={t("разделы")}>
          {nav.map((n) => (
            <Link key={n.href} href={n.href}>
              {n.label}
            </Link>
          ))}
        </nav>
        <div className={s.right}>
          <span className={s.lang}>
            <LanguageSwitch />
          </span>
          {user ? (
            <Link href="/chart" className={`${s.pill} ${s.acc}`}>
              <span className={s.labelLong}>{t("Открыть график")}</span>
              <span className={s.labelShort}>{t("График")}</span>
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
          <button ref={burgerRef} type="button" className={s.burger} aria-expanded={open} aria-controls="site-menu" aria-label={open ? t("закрыть меню") : t("открыть меню")} onClick={() => setOpen(!open)}>
            <span />
            <span />
          </button>
        </div>
      </div>
      {open && (
        <div ref={menuRef} id="site-menu" className={s.menu}>
          <nav aria-label={t("меню")}>
            {nav.map((n) => (
              <Link key={n.href} href={n.href} onClick={() => setOpen(false)}>
                {n.label}
              </Link>
            ))}
          </nav>
          {!user && (
            <Link href="/login" className={`${s.pill} ${s.line}`} onClick={() => setOpen(false)}>
              {t("Войти")}
            </Link>
          )}
          <LanguageSwitch />
        </div>
      )}
    </header>
  );
}
