"use client";

import { Suspense, useEffect, useState } from "react";
import { AppShell } from "@/components/app/AppShell";
import { useAuth } from "@/components/auth/AuthProvider";
import { Feed } from "@/components/signals/Feed";
import { EmptyState, Panel } from "@/components/ui";
import { api } from "@/lib/auth-client";

export default function SignalsPage() {
  const { user } = useAuth();
  const [instruments, setInstruments] = useState<{ symbol: string; tick_size: string | null }[]>([]);
  useEffect(() => {
    api<{ symbol: string; tick_size: string | null }[]>("/v1/instruments", { auth: false })
      .then(setInstruments)
      .catch(() => {});
  }, []);
  return (
    <AppShell title="Сигналы">
      {user && !user.email_verified && (
        <div style={{ marginBottom: 12 }}>
          <Panel title="Подтвердите email">
            <EmptyState text={`Письмо отправлено на ${user.email}. Без подтверждения не будут приходить уведомления.`} />
          </Panel>
        </div>
      )}
      <Suspense fallback={<EmptyState text="Загрузка…" />}>
        <Feed instruments={instruments} />
      </Suspense>
    </AppShell>
  );
}
