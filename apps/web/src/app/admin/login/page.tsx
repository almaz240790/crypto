import type { Metadata } from "next";
import { cookies } from "next/headers";
import { AdminLogin } from "@/components/admin/AdminLogin";
import { ADMIN_HINT_COOKIE, endedReason, safeAdminNext } from "@/lib/adminGate";
import { getT } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Вход в админку"), robots: { index: false, follow: false } };
}

/**
 * Отдельный вход в админку (ADR-0011). Не связан со входом на сайт; ссылок на страницу на сайте нет.
 * Если в браузере есть подсказка открытого сеанса — страница сначала проверит его и поведёт сразу в админку.
 * `?setup=1` — пришли из плашки переходного режима («Настроить»): тот же вход с объяснением про настройку защиты.
 */
export default async function AdminLoginPage({ searchParams }: { searchParams: Promise<{ next?: string; link?: string; ended?: string; setup?: string }> }) {
  const { next, link, ended, setup } = await searchParams;
  const goodLink = link && /^[\w-]{10,200}$/.test(link) ? link : null;
  const reason = endedReason(ended);
  const hint = (await cookies()).get(ADMIN_HINT_COOKIE)?.value === "1";
  return <AdminLogin next={safeAdminNext(next)} link={goodLink} ended={reason} live={hint && !reason && !goodLink} setup={setup === "1"} />;
}
