"use client";

import { AppShell } from "@/components/app/AppShell";
import { useAuth } from "@/components/auth/AuthProvider";
import { Button, EmptyState, Panel } from "@/components/ui";

// Заглушка до задачи 2.9 (лента сигналов).
export default function SignalsPage() {
  const { user } = useAuth();
  return (
    <AppShell title="Сигналы">
      {user && !user.email_verified && (
        <Panel title="Подтвердите email">
          <EmptyState text={`Мы отправили письмо на ${user.email}. Без подтверждения не будут приходить уведомления.`} />
        </Panel>
      )}
      <div style={{ height: 16 }} />
      <Panel title="Лента сигналов">
        <EmptyState
          text="Лента появится в следующем обновлении. Пока доступны правила системы и публичная статистика на главной."
          action={<Button href="/onboarding" size="sm">Настроить профиль</Button>}
        />
      </Panel>
    </AppShell>
  );
}
