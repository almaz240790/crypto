import type { Metadata } from "next";
import { AuthCard } from "@/components/auth/AuthCard";
import { RegisterForm } from "@/components/auth/RegisterForm";
import { getT } from "@/i18n/server";

export const metadata: Metadata = { title: "Регистрация" };

function safeNext(v: string | undefined): string {
  return v && v.startsWith("/") && !v.startsWith("//") ? v : "/chart";
}

export default async function RegisterPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const t = await getT();
  const { next } = await searchParams;
  return (
    <AuthCard title={t("Регистрация")} footer={t("Бесплатно: все индикаторы, рисование и автоматическая разметка.")}>
      <RegisterForm next={safeNext(next)} />
    </AuthCard>
  );
}
