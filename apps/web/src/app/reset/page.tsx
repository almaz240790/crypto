import type { Metadata } from "next";
import { AuthCard } from "@/components/auth/AuthCard";
import { ResetForm } from "@/components/auth/ResetForm";

export const metadata: Metadata = { title: "Восстановление пароля", robots: { index: false } };

export default async function ResetPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <AuthCard title={token ? "Новый пароль" : "Восстановление пароля"}>
      <ResetForm token={token ?? null} />
    </AuthCard>
  );
}
