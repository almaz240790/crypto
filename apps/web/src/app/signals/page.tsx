"use client";

import { Suspense, useEffect, useState } from "react";
import { AppShell } from "@/components/app/AppShell";
import { useAuth } from "@/components/auth/AuthProvider";
import { Feed } from "@/components/signals/Feed";
import { EmptyState, Panel } from "@/components/ui";
import { api } from "@/lib/auth-client";
import { useT } from "@/i18n/client";

export default function SignalsPage() {
  const t = useT();
  const { user } = useAuth();
  const [instruments, setInstruments] = useState<{ symbol: string; tick_size: string | null }[]>([]);
  useEffect(() => {
    api<{ symbol: string; tick_size: string | null }[]>("/v1/instruments", { auth: false })
      .then(setInstruments)
      .catch(() => {});
  }, []);
  return (
    <AppShell title={t("Сигналы")}>
      {user && !user.email_verified && (
        <div style={{ marginBottom: 12 }}>
          <Panel title={t("Подтвердите email")}>
            <EmptyState text={t("Письмо отправлено на {email}. Без подтверждения не будут приходить уведомления.", { email: user.email })} />
          </Panel>
        </div>
      )}
      <Suspense fallback={<EmptyState text={t("Загрузка…")} />}>
        <Feed instruments={instruments} />
      </Suspense>
    </AppShell>
  );
}
