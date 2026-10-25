import type { Metadata } from "next";
import { AuthCard } from "@/components/auth/AuthCard";
import { Unsubscribe } from "@/components/settings/Unsubscribe";

export const metadata: Metadata = { title: "Отписка от писем", robots: { index: false } };

export default async function UnsubscribePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <AuthCard title="Отписка от писем">
      <Unsubscribe token={token ?? null} />
    </AuthCard>
  );
}
