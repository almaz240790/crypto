import type { Metadata } from "next";
import { AuthCard } from "@/components/auth/AuthCard";
import { RegisterForm } from "@/components/auth/RegisterForm";

export const metadata: Metadata = { title: "Регистрация" };

function safeNext(v: string | undefined): string {
  return v && v.startsWith("/") && !v.startsWith("//") ? v : "/onboarding";
}

export default async function RegisterPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <AuthCard title="Регистрация" footer="7 дней уровня Pro после регистрации, без оплаты.">
      <RegisterForm next={safeNext(next)} />
    </AuthCard>
  );
}
