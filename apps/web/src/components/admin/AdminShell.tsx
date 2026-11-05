"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { Button, EmptyState, ThemeToggle } from "@/components/ui";
import { Logo } from "@/components/site/Logo";
import { useT } from "@/i18n/client";
import { ApiError } from "@/lib/auth-client";
import { ADMIN_SESSION_ENDED, adminLogout, getAdminMe, setAdminHint, type AdminMe } from "@/lib/admin-auth";
import s from "./AdminShell.module.css";

const MeCtx = createContext<AdminMe | null>(null);

/** Кто вошёл в админку (только внутри AdminShell — там сеанс уже проверен). */
export function useAdminMe(): AdminMe {
  const me = useContext(MeCtx);
  if (!me) throw new Error("useAdminMe вне AdminShell");
  return me;
}

const ROLE: Record<string, string> = { owner: "владелец", admin: "администратор" };

/**
 * Оболочка админки (ADR-0011): своя шапка, свой сеанс. Без сеанса админки — на /admin/login (не на вход сайта).
 * В шапке — кто вошёл и «Выйти из админки» (сайт при этом остаётся открытым).
 */
export function AdminShell({ children }: { children: ReactNode }) {
  const t = useT();
  const router = useRouter();
  const [me, setMe] = useState<AdminMe | null>(null);
  const [failed, setFailed] = useState(false);

  const toLogin = useCallback(
    (ended: boolean) => {
      setAdminHint(false);
      const here = `${window.location.pathname}${window.location.search}`;
      router.replace(`/admin/login?next=${encodeURIComponent(here)}${ended ? "&ended=1" : ""}`);
    },
    [router],
  );

  const load = useCallback(() => {
    setFailed(false);
    getAdminMe()
      .then(setMe)
      .catch((e) => (e instanceof ApiError && (e.status === 401 || e.status === 403) ? toLogin(true) : setFailed(true)));
  }, [toLogin]);

  useEffect(() => {
    queueMicrotask(load);
    const ended = () => toLogin(true);
    window.addEventListener(ADMIN_SESSION_ENDED, ended);
    return () => window.removeEventListener(ADMIN_SESSION_ENDED, ended);
  }, [load, toLogin]);

  async function logout() {
    try {
      await adminLogout();
    } finally {
      router.replace("/admin/login");
    }
  }

  if (!me) {
    return (
      <div className={s.wait}>
        {failed ? (
          <EmptyState text={t("Не удалось связаться с сервером.")} action={<Button size="sm" onClick={load}>{t("Повторить")}</Button>} />
        ) : (
          <EmptyState text={t("Проверяем вход в админку…")} />
        )}
      </div>
    );
  }
  return (
    <MeCtx.Provider value={me}>
      <div className={s.shell}>
        <header className={s.head}>
          <div className={s.left}>
            <Link href="/" className={s.brand} aria-label={t("На сайт")} title={t("На сайт")}>
              <Logo compact />
            </Link>
            <h1 className={s.title}>{t("Админка")}</h1>
          </div>
          <div className={s.who} data-testid="admin-who">
            <span className={s.email} title={me.email}>
              {me.email}
            </span>
            <span className={s.role}>{t(ROLE[me.role] ?? me.role)}</span>
          </div>
          <div className={s.actions}>
            <ThemeToggle />
            <Button size="sm" onClick={() => void logout()}>
              {t("Выйти из админки")}
            </Button>
          </div>
        </header>
        {me.backup_codes_left > 0 && me.backup_codes_left <= 3 && (
          <p className={s.warn} role="status">
            {t("Осталось резервных кодов: {n}. Запасной способ входа почти закончился.", { n: me.backup_codes_left })}
          </p>
        )}
        <main className={s.main}>{children}</main>
      </div>
    </MeCtx.Provider>
  );
}
