import type { Metadata } from "next";
import { AuthCard } from "@/components/auth/AuthCard";
import { TokenAction } from "@/components/auth/TokenAction";

export const metadata: Metadata = { title: "Подтверждение email", robots: { index: false } };

export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <AuthCard title="Подтверждение email">
      <TokenAction kind="verify" token={token ?? null} />
    </AuthCard>
  );
}
