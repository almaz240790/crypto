import type { Metadata } from "next";
import { AuthCard } from "@/components/auth/AuthCard";
import { LoginForm } from "@/components/auth/LoginForm";
import { getT } from "@/i18n/server";

export const metadata: Metadata = { title: "Вход" };

function safeNext(v: string | undefined): string {
  return v && v.startsWith("/") && !v.startsWith("//") ? v : "/chart";
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const t = await getT();
  const { next } = await searchParams;
  return (
    <AuthCard title={t("Вход")}>
      <LoginForm next={safeNext(next)} />
    </AuthCard>
  );
}
