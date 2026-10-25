import type { Metadata } from "next";
import { AuthCard } from "@/components/auth/AuthCard";
import { GoogleCallback } from "@/components/auth/GoogleCallback";

export const metadata: Metadata = { title: "Вход через Google", robots: { index: false } };

export default async function GooglePage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string; state?: string; error?: string }>;
}) {
  const { code, state, error } = await searchParams;
  return (
    <AuthCard title="Вход через Google">
      <GoogleCallback code={code ?? null} state={state ?? null} error={error ?? null} />
    </AuthCard>
  );
}
