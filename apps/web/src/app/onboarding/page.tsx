"use client";

import { AppShell } from "@/components/app/AppShell";
import { Onboarding } from "@/components/app/Onboarding";
import { useAuth } from "@/components/auth/AuthProvider";
import { useT } from "@/i18n/client";

export default function OnboardingPage() {
  const t = useT();
  const { user, loading } = useAuth();
  return (
    <AppShell title={t("Первые настройки")}>
      {user ? <Onboarding key={user.id} user={user} /> : <p className="text-2">{loading ? t("Загрузка…") : t("Войдите, чтобы продолжить.")}</p>}
    </AppShell>
  );
}
