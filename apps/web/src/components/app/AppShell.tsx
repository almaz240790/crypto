"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { Button, ThemeToggle } from "@/components/ui";
import s from "./AppShell.module.css";
import { LanguageSwitch, useT } from "@/i18n/client";
import { Logo } from "@/components/site/Logo";
import { getWatchlist } from "@/lib/user";
import { api } from "@/lib/auth-client";
import { formatPrice } from "@/lib/format";

/**
 * Меню кабинета (ADR-0006): только инструменты анализа. Сигналы, статистика, журнал и калькулятор
 * убраны из меню (страницы доступны по ссылкам); тариф, настройки и поддержка — в блоке аккаунта.
 */
const NAV: { href: string; label: string; icon: string }[] = [
  { href: "/chart", label: "График", icon: "M4 17l5-5 4 4 7-8M4 21h16" },
  { href: "/screener", label: "Скринер", icon: "M4 5h16l-6 7v6l-4 2v-8z" },
  { href: "/alerts", label: "Алерты", icon: "M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0" },
];
const ADMIN = { href: "/admin", label: "Админка", icon: "M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z" };
const ACCOUNT: { href: string; label: string }[] = [
  { href: "/billing", label: "Тариф" },
  { href: "/settings", label: "Настройки" },
  { href: "/support", label: "Поддержка" },
];
/** Сколько монет из вотчлиста показывать в меню. */
const MY_COINS_MAX = 8;

/** Шаг цены по самой строке биржи: «0.004758» → «0.000001», чтобы не терять знаки у дешёвых монет. */
const tickOf = (p: string) => {
  const f = p.split(".")[1];
  return f ? `0.${"0".repeat(f.length - 1)}1` : "1";
};

function Icon({ d }: { d: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/** «Мои монеты»: вотчлист с последней ценой; ссылка открывает монету на графике. */
function MyCoins() {
  const t = useT();
  const [items, setItems] = useState<{ symbol: string; p?: string }[] | null>(null);

  useEffect(() => {
    let stop = false;
    getWatchlist()
      .then(async (w) => {
        const syms = w.items.map((i) => i.symbol).slice(0, MY_COINS_MAX);
        const prices = syms.length ? await api<Record<string, { p: string }>>(`/v1/prices?symbols=${syms.join(",")}`).catch(() => ({}) as Record<string, { p: string }>) : {};
        if (!stop) setItems(syms.map((symbol) => ({ symbol, p: prices[symbol]?.p })));
      })
      .catch(() => !stop && setItems([]));
    return () => {
      stop = true;
    };
  }, []);

  if (items === null) return null;
  return (
    <div className={s.coins}>
      <div className={s.coinsHead}>
        <span>{t("Мои монеты")}</span>
        <Link href="/watchlist">{items.length ? t("изменить") : t("добавить")}</Link>
      </div>
      {items.length === 0 ? (
        <p className={s.coinsEmpty}>{t("Добавьте монеты, чтобы открывать их в один клик.")}</p>
      ) : (
        <ul>
          {items.map((c) => (
            <li key={c.symbol}>
              <Link href={`/chart/${c.symbol}/4h`}>
                <b>{c.symbol.replace(/USDT$/, "")}</b>
                <span>{c.p ? formatPrice(c.p, tickOf(c.p)) : "—"}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AppShell({ title, actions, children, flush = false }: { title: string; actions?: ReactNode; children: ReactNode; flush?: boolean }) {
  const t = useT();
  const path = usePathname();
  const router = useRouter();
  const { user, loading, logout } = useAuth();

  const nav = user && (user.role === "admin" || user.role === "owner") ? [...NAV, ADMIN] : NAV;
  const isCurrent = (href: string) => path === href || path.startsWith(href + "/");
  const links = nav.map((n) => (
    <Link key={n.href} href={n.href} aria-current={isCurrent(n.href) ? "page" : undefined}>
      <Icon d={n.icon} />
      {t(n.label)}
    </Link>
  ));

  return (
    <div className={s.shell}>
      <aside className={s.side}>
        <Link href="/" className={s.brand} aria-label="PlatformSol">
          <Logo />
        </Link>
        <nav className={s.nav} aria-label={t("разделы")}>
          {links}
        </nav>
        {user && <MyCoins />}
        <div className={s.user}>
          {loading ? (
            <span className={s.email}>…</span>
          ) : user ? (
            <>
              <span className={s.email} title={user.email}>
                {user.email}
              </span>
              <nav className={s.account} aria-label={t("аккаунт")}>
                {ACCOUNT.map((a) => (
                  <Link key={a.href} href={a.href} aria-current={isCurrent(a.href) ? "page" : undefined}>
                    {t(a.label)}
                  </Link>
                ))}
              </nav>
            </>
          ) : (
            <div className={s.guest}>
              <Button href="/login" size="sm">
                {t("Войти")}
              </Button>
              <Button href="/register" size="sm" variant="primary">
                {t("Регистрация")}
              </Button>
            </div>
          )}
          <div className={s.prefs}>
            <LanguageSwitch />
            <ThemeToggle />
            {user && (
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  await logout();
                  router.replace("/login");
                }}
              >
                {t("Выйти")}
              </Button>
            )}
          </div>
        </div>
      </aside>
      <div className={s.body}>
        <div className={s.mobileBar}>
          <Link href="/" className={s.mobileBrand} aria-label="PlatformSol">
            <Logo compact />
          </Link>
          {links}
          <Link href={user ? "/settings" : "/login"} className={s.mobileAccount} aria-current={isCurrent("/settings") ? "page" : undefined}>
            {user ? t("Аккаунт") : t("Войти")}
          </Link>
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
