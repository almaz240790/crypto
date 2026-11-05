"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { Button, IconButton, ThemeToggle } from "@/components/ui";
import { IconClose, IconMenu } from "@/components/ui/icons";
import s from "./AppShell.module.css";
import { LanguageSwitch, useT } from "@/i18n/client";
import { Logo } from "@/components/site/Logo";
import { getWatchlist } from "@/lib/user";
import { api } from "@/lib/auth-client";
import { formatPrice } from "@/lib/format";

/**
 * Меню кабинета (ADR-0006): только инструменты анализа. Сигналы, статистика, журнал и калькулятор
 * убраны из меню (страницы доступны по ссылкам); тариф, настройки и поддержка — в блоке аккаунта.
 * Ссылки на админку здесь нет и не должно быть: у неё свой вход по адресу /admin/login (ADR-0011).
 */
const NAV: { href: string; label: string; icon: string }[] = [
  { href: "/chart", label: "График", icon: "M4 17l5-5 4 4 7-8M4 21h16" },
  { href: "/screener", label: "Скринер", icon: "M4 5h16l-6 7v6l-4 2v-8z" },
  { href: "/alerts", label: "Алерты", icon: "M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0" },
];
const ACCOUNT: { href: string; label: string }[] = [
  { href: "/billing", label: "Подписка" },
  { href: "/settings", label: "Настройки" },
  { href: "/support", label: "Поддержка" },
];
/** Сколько монет из вотчлиста показывать в меню. */
const MY_COINS_MAX = 8;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

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

/** Меню разделов страницы с рейкой: открыть выдвижное меню (кнопка рейки; на телефоне — ☰ терминала, PR C2). */
export type AppNav = { open: () => void };
const AppNavContext = createContext<AppNav>({ open: () => {} });
export const useAppNav = () => useContext(AppNavContext);

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

function useNav() {
  const path = usePathname();
  const nav = NAV;
  const isCurrent = useCallback((href: string) => path === href || path.startsWith(href + "/"), [path]);
  return { nav, isCurrent, path };
}

/** Содержимое сайдбара: знак, разделы, мои монеты, аккаунт и настройки (сайдбар и выдвижное меню рейки). */
function SidebarContent() {
  const t = useT();
  const router = useRouter();
  const { user, loading, logout } = useAuth();
  const { nav, isCurrent } = useNav();
  return (
    <>
      <Link href="/" className={s.brand} aria-label="PlatformSol">
        <Logo />
      </Link>
      <nav className={s.nav} aria-label={t("разделы")}>
        {nav.map((n) => (
          <Link key={n.href} href={n.href} aria-current={isCurrent(n.href) ? "page" : undefined}>
            <Icon d={n.icon} />
            {t(n.label)}
          </Link>
        ))}
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
    </>
  );
}

/**
 * Рейка 56 px (план 2B.9, страницы /chart и /multichart, только ≥ 900 px): знак, разделы иконками (подпись —
 * sr-only внутри ссылки и подсказка справа по наведению и фокусу), внизу — аккаунт и «развернуть меню».
 */
function Rail({ menuOpen, onMenu, menuButton }: { menuOpen: boolean; onMenu: () => void; menuButton: (el: HTMLButtonElement | null) => void }) {
  const t = useT();
  const { user } = useAuth();
  const { nav, isCurrent } = useNav();
  return (
    <aside className={s.rail} data-testid="app-rail" aria-label={t("навигация")}>
      <Link href="/" className={s.railBrand} aria-label="PlatformSol">
        <Logo compact />
      </Link>
      <nav className={s.railNav} aria-label={t("разделы")}>
        {nav.map((n) => (
          <Link key={n.href} href={n.href} className={s.railLink} data-tip={t(n.label)} aria-current={isCurrent(n.href) ? "page" : undefined}>
            <Icon d={n.icon} />
            <span className="sr-only">{t(n.label)}</span>
          </Link>
        ))}
      </nav>
      <div className={s.railFoot}>
        {user && (
          <Link href="/settings" className={s.avatar} title={user.email} aria-label={t("Аккаунт")} aria-current={isCurrent("/settings") ? "page" : undefined}>
            <span aria-hidden="true">{user.email.slice(0, 1).toUpperCase()}</span>
          </Link>
        )}
        <IconButton ref={menuButton} label={t("развернуть меню")} aria-expanded={menuOpen} onClick={onMenu}>
          <IconMenu />
        </IconButton>
      </div>
    </aside>
  );
}

/**
 * Выдвижное меню (role=dialog «меню»): весь сайдбар поверх страницы. Закрывается по Esc, клику по подложке,
 * кнопке ✕ и переходу на другую страницу; Tab не выходит за меню; фокус возвращается на вызвавшую кнопку.
 */
function NavDrawer({ onClose, returnTo }: { onClose: () => void; returnTo: HTMLElement | null }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus({ preventScroll: true });
    return () => returnTo?.focus({ preventScroll: true });
  }, [returnTo]);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !ref.current) return;
    const all = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = all[0];
    const last = all[all.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  return (
    <>
      <div className={s.scrim} onClick={onClose} aria-hidden="true" />
      <div ref={ref} role="dialog" aria-modal="true" aria-label={t("меню")} className={s.drawer} onKeyDown={onKey}>
        <div className={s.drawerClose}>
          <IconButton label={t("закрыть меню")} onClick={onClose}>
            <IconClose />
          </IconButton>
        </div>
        <SidebarContent />
      </div>
    </>
  );
}

/**
 * Каркас кабинета. rail — страница-инструмент (график, мультичарт): вместо сайдбара 220 px рейка 56 px,
 * страница ровно в высоту окна, содержимое заполняет остаток (без calc от высоты шапки). На телефоне
 * (< 900 px) — прежняя верхняя строка разделов (раскладка телефона — PR C2).
 */
export function AppShell({ title, actions, children, flush = false, rail = false }: { title: string; actions?: ReactNode; children: ReactNode; flush?: boolean; rail?: boolean }) {
  const t = useT();
  const { user } = useAuth();
  const { nav, isCurrent, path } = useNav();
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuButton, setMenuButton] = useState<HTMLButtonElement | null>(null);
  const appNav = useMemo<AppNav>(() => ({ open: () => setMenuOpen(true) }), []);
  // переход на другую страницу закрывает меню
  const [menuPath, setMenuPath] = useState(path);
  if (menuPath !== path) {
    setMenuPath(path);
    if (menuOpen) setMenuOpen(false);
  }
  const close = useCallback(() => setMenuOpen(false), []);

  const links = nav.map((n) => (
    <Link key={n.href} href={n.href} aria-current={isCurrent(n.href) ? "page" : undefined}>
      <Icon d={n.icon} />
      {t(n.label)}
    </Link>
  ));

  return (
    <AppNavContext.Provider value={appNav}>
      <div className={s.shell} data-rail={rail || undefined}>
        {rail ? (
          <Rail menuOpen={menuOpen} onMenu={() => setMenuOpen(!menuOpen)} menuButton={setMenuButton} />
        ) : (
          <aside className={s.side}>
            <SidebarContent />
          </aside>
        )}
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
        {rail && menuOpen && <NavDrawer onClose={close} returnTo={menuButton} />}
      </div>
    </AppNavContext.Provider>
  );
}
