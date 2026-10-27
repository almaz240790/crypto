import type { Metadata } from "next";
import { AuthCard } from "@/components/auth/AuthCard";
import { RegisterForm } from "@/components/auth/RegisterForm";
import { getT } from "@/i18n/server";

export const metadata: Metadata = { title: "Регистрация" };

function safeNext(v: string | undefined): string {
  return v && v.startsWith("/") && !v.startsWith("//") ? v : "/onboarding";
}

export default async function RegisterPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const t = await getT();
  const { next } = await searchParams;
  return (
    <AuthCard title={t("Регистрация")} footer={t("7 дней уровня Pro после регистрации, без оплаты.")}>
      <RegisterForm next={safeNext(next)} />
    </AuthCard>
  );
}
