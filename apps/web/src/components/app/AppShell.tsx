"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { Button, ThemeToggle } from "@/components/ui";
import s from "./AppShell.module.css";
import { LanguageSwitch, useT } from "@/i18n/client";

const NAV: { href: string; label: string }[] = [
  { href: "/signals", label: "Сигналы" },
  { href: "/chart", label: "График" },
  { href: "/screener", label: "Скринер" },
  { href: "/watchlist", label: "Вотчлист" },
  { href: "/alerts", label: "Алерты" },
  { href: "/journal", label: "Журнал" },
  { href: "/calculator", label: "Калькулятор" },
  { href: "/stats", label: "Статистика" },
  { href: "/billing", label: "Тариф" },
  { href: "/settings", label: "Настройки" },
  { href: "/support", label: "Поддержка" },
];
const SOON: string[] = [];

export function AppShell({ title, actions, children, flush = false }: { title: string; actions?: ReactNode; children: ReactNode; flush?: boolean }) {
  const t = useT();
  const path = usePathname();
  const router = useRouter();
  const { user, loading, logout } = useAuth();

  const nav = user && (user.role === "admin" || user.role === "owner") ? [...NAV, { href: "/admin", label: t("Админка") }] : NAV;
  const links = nav.map((n) => (
    <Link key={n.href} href={n.href} aria-current={path === n.href || path.startsWith(n.href + "/") ? "page" : undefined}>
      {n.label}
    </Link>
  ));

  return (
    <div className={s.shell}>
      <aside className={s.side}>
        <Link href="/" className={s.brand}>
          Platform
        </Link>
        <nav className={s.nav} aria-label={t("разделы")}>
          {links}
          {SOON.map((l) => (
            <div key={l} className={s.soon}>
              {l}
              <span>{t("скоро")}</span>
            </div>
          ))}
        </nav>
        <div className={s.user}>
          <span className={s.email} title={user?.email}>
            {loading ? "…" : (user?.email ?? t("не вошли"))}
          </span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <LanguageSwitch />
            <ThemeToggle />
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                await logout();
                router.replace("/login");
              }}
            >{t("Выйти")}</Button>
          </div>
        </div>
      </aside>
      <div className={s.body}>
        <div className={s.mobileBar}>
          <Link href="/" className={s.brand} style={{ border: 0, height: "auto", padding: 0 }}>
            Platform
          </Link>
          {links}
          <span style={{ marginLeft: "auto" }}>
            <LanguageSwitch />
            <ThemeToggle />
          </span>
        </div>
        <main className={s.content} data-flush={flush || undefined}>
          {!flush && (
            <div className={s.top}>
              <h1 style={{ fontSize: "var(--fs-h2)" }}>{title}</h1>
              {actions}
            </div>
          )}
          {flush && <h1 className="sr-only">{title}</h1>}
          {children}
        </main>
      </div>
    </div>
  );
}
