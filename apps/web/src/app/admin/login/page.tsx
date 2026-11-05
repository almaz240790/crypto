import type { Metadata } from "next";
import { AdminLogin } from "@/components/admin/AdminLogin";
import { safeAdminNext } from "@/lib/adminGate";
import { getT } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Вход в админку"), robots: { index: false, follow: false } };
}

/** Отдельный вход в админку (ADR-0011). Не связан со входом на сайт; ссылок на страницу на сайте нет. */
export default async function AdminLoginPage({ searchParams }: { searchParams: Promise<{ next?: string; link?: string; ended?: string }> }) {
  const { next, link, ended } = await searchParams;
  return <AdminLogin next={safeAdminNext(next)} link={link && /^[\w-]{10,200}$/.test(link) ? link : null} ended={ended === "1"} />;
}
