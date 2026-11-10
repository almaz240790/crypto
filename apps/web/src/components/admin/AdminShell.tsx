"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { Button, EmptyState, ThemeToggle } from "@/components/ui";
import { Logo } from "@/components/site/Logo";
import { useT } from "@/i18n/client";
import { ADMIN_SESSION_ENDED, AdminApiError, adminLogout, getAdminAccess, loadBackup, setAdminHint, type AdminMe } from "@/lib/admin-auth";
import { endedReason, type EndedReason } from "@/lib/adminGate";
import s from "./AdminShell.module.css";

const MeCtx = createContext<AdminMe | null>(null);
const ReloadCtx = createContext<() => void>(() => {});

/** Кто вошёл в админку (только внутри AdminShell — там сеанс уже проверен). */
export function useAdminMe(): AdminMe {
  const me = useContext(MeCtx);
  if (!me) throw new Error("useAdminMe вне AdminShell");
  return me;
}

/** Перечитать «кто вошёл» (после выпуска новых резервных кодов — их счётчик в шапке). */
export const useAdminReload = () => useContext(ReloadCtx);

const ROLE: Record<string, string> = { owner: "владелец", admin: "администратор" };

/** Куда ведёт «Настроить» в переходном режиме: страница входа на шаге настройки защиты. */
export const ADMIN_SETUP_HREF = "/admin/login?setup=1";

/**
 * Оболочка админки (ADR-0011): своя шапка, свой сеанс. Без сеанса админки — на /admin/login (не на вход сайта).
 * В шапке — кто вошёл и «Выйти из админки» (сайт при этом остаётся открытым).
 * Переходный режим (`grace`): админ или владелец вошёл на сайт, а код из телефона ещё не настроен — админка
 * открыта по входу на сайт, сверху постоянная плашка «Настройте защиту»; выйти из админки отдельно нечего.
 */
export function AdminShell({ children }: { children: ReactNode }) {
  const t = useT();
  const router = useRouter();
  const [me, setMe] = useState<AdminMe | null>(null);
  const [failed, setFailed] = useState(false);

  /** На страницу входа; `reason` — почему сеанс закрыт (страница объяснит), null — сеанса просто нет. */
  const toLogin = useCallback(
    (reason: EndedReason | null) => {
      setAdminHint(false);
      const here = `${window.location.pathname}${window.location.search}`;
      router.replace(`/admin/login?next=${encodeURIComponent(here)}${reason ? `&ended=${reason}` : ""}`);
    },
    [router],
  );

  const load = useCallback(() => {
    setFailed(false);
    getAdminAccess()
      .then(setMe)
      .catch((e) => (e instanceof AdminApiError && (e.status === 401 || e.status === 403) ? toLogin(e.ended) : setFailed(true)));
  }, [toLogin]);

  useEffect(() => {
    // резервные коды показаны, но не подтверждены сохранёнными — сначала вернуться к ним
    if (loadBackup()) {
      const here = `${window.location.pathname}${window.location.search}`;
      router.replace(`/admin/login?next=${encodeURIComponent(here)}`);
      return;
    }
    queueMicrotask(load);
    const ended = (e: Event) => toLogin(endedReason((e as CustomEvent<string>).detail) ?? "gone");
    window.addEventListener(ADMIN_SESSION_ENDED, ended);
    return () => window.removeEventListener(ADMIN_SESSION_ENDED, ended);
  }, [load, router, toLogin]);

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
            {!me.grace && (
              <Link href="/admin?tab=security" className={s.sec}>
                {t("Защита входа")}
              </Link>
            )}
          </div>
          <div className={s.actions}>
            <ThemeToggle />
            {!me.grace && (
              <Button size="sm" onClick={() => void logout()}>
                {t("Выйти из админки")}
              </Button>
            )}
          </div>
        </header>
        {me.grace && <GraceBanner />}
        {!me.grace && me.backup_codes_left <= 3 && (
          <p className={s.warn} role="status">
            {me.backup_codes_left > 0
              ? t("Осталось резервных кодов: {n}. Запасной способ входа почти закончился.", { n: me.backup_codes_left })
              : t("Резервных кодов не осталось: если телефон потеряется, войти будет нечем.")}{" "}
            <Link href="/admin?tab=security">{t("Выпустить новые коды")}</Link>
          </p>
        )}
        <ReloadCtx.Provider value={load}>
          <main className={s.main}>{children}</main>
        </ReloadCtx.Provider>
      </div>
    </MeCtx.Provider>
  );
}

/**
 * Плашка переходного режима: вход в админку пока без кода из телефона. Видна на каждой вкладке, не закрывается —
 * исчезнет сама, когда защита будет настроена.
 */
function GraceBanner() {
  const t = useT();
  return (
    <div className={s.grace} role="status" data-testid="admin-grace">
      <p className={s.graceText}>
        <strong>{t("Вход в админку пока без защиты кодом.")}</strong> {t("Настройте защиту — это одна минута.")}
      </p>
      <Button size="sm" variant="primary" href={ADMIN_SETUP_HREF}>
        {t("Настроить")}
      </Button>
    </div>
  );
}
