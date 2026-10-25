"use client";

import { AppShell } from "@/components/app/AppShell";
import { Onboarding } from "@/components/app/Onboarding";
import { useAuth } from "@/components/auth/AuthProvider";

export default function OnboardingPage() {
  const { user, loading } = useAuth();
  return (
    <AppShell title="Первые настройки">
      {user ? <Onboarding key={user.id} user={user} /> : <p className="text-2">{loading ? "Загрузка…" : "Войдите, чтобы продолжить."}</p>}
    </AppShell>
  );
}
