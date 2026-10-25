import type { Metadata } from "next";
import { AuthCard } from "@/components/auth/AuthCard";
import { TokenAction } from "@/components/auth/TokenAction";

export const metadata: Metadata = { title: "Вход по ссылке", robots: { index: false } };

export default async function MagicPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <AuthCard title="Вход по ссылке">
      <TokenAction kind="magic" token={token ?? null} />
    </AuthCard>
  );
}
