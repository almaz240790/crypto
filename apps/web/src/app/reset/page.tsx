import type { Metadata } from "next";
import { AuthCard } from "@/components/auth/AuthCard";
import { ResetForm } from "@/components/auth/ResetForm";
import { getT } from "@/i18n/server";

export const metadata: Metadata = { title: "Восстановление пароля", robots: { index: false } };

export default async function ResetPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const t = await getT();
  const { token } = await searchParams;
  return (
    <AuthCard title={token ? t("Новый пароль") : t("Восстановление пароля")}>
      <ResetForm token={token ?? null} />
    </AuthCard>
  );
}
