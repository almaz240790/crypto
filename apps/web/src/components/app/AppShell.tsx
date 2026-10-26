"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { Button, ThemeToggle } from "@/components/ui";
import s from "./AppShell.module.css";

const NAV: { href: string; label: string }[] = [
  { href: "/signals", label: "Сигналы" },
  { href: "/screener", label: "Скринер" },
  { href: "/watchlist", label: "Вотчлист" },
  { href: "/journal", label: "Журнал" },
  { href: "/calculator", label: "Калькулятор" },
  { href: "/stats", label: "Статистика" },
  { href: "/billing", label: "Тариф" },
  { href: "/settings", label: "Настройки" },
];
const SOON: string[] = [];

export function AppShell({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const { user, loading, logout } = useAuth();

  const nav = user && (user.role === "admin" || user.role === "owner") ? [...NAV, { href: "/admin", label: "Админка" }] : NAV;
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
        <nav className={s.nav} aria-label="разделы">
          {links}
          {SOON.map((l) => (
            <div key={l} className={s.soon}>
              {l}
              <span>скоро</span>
            </div>
          ))}
        </nav>
        <div className={s.user}>
          <span className={s.email} title={user?.email}>
            {loading ? "…" : (user?.email ?? "не вошли")}
          </span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <ThemeToggle />
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                await logout();
                router.replace("/login");
              }}
            >
              Выйти
            </Button>
          </div>
        </div>
      </aside>
      <div>
        <div className={s.mobileBar}>
          <Link href="/" className={s.brand} style={{ border: 0, height: "auto", padding: 0 }}>
            Platform
          </Link>
          {links}
          <span style={{ marginLeft: "auto" }}>
            <ThemeToggle />
          </span>
        </div>
        <main className={s.content}>
          <div className={s.top}>
            <h1 style={{ fontSize: "var(--fs-h2)" }}>{title}</h1>
            {actions}
          </div>
          {children}
        </main>
      </div>
    </div>
  );
}
