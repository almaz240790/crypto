"use client";

import { Suspense, useEffect, useState } from "react";
import { AppShell } from "@/components/app/AppShell";
import { useAuth } from "@/components/auth/AuthProvider";
import { Feed } from "@/components/signals/Feed";
import { TestModeBadge } from "@/components/signals/TestMode";
import { Button, EmptyState, Panel } from "@/components/ui";
import { getInstruments } from "@/lib/user";
import { useT } from "@/i18n/client";
import s from "./page.module.css";

/**
 * Гостю — только объяснение, что такое тестовые сигналы, и призыв войти: данных сигналов нет, API ленты не
 * запрашивается (ADR-0013). Тексты — без обещаний и без призывов к сделкам (план 5.2, 8).
 */
function GuestSignals() {
  const t = useT();
  return (
    <Panel
      title={
        <span className={s.guestTitle}>
          {t("Тестовые сигналы")} <TestModeBadge />
        </span>
      }
    >
      <div className={s.guest} data-testid="signals-guest">
        <p>{t("Каждые 4 часа, после закрытия свечи H4, программа проверяет монеты по жёстким правилам стратегии. Если все условия сошлись, появляется сигнал: инструмент, направление, вход, стоп и цели. Дальше видно, что с ним стало: ждёт входа, в работе, дошёл до цели или закрыт.")}</p>
        <p>{t("Сейчас стратегия проходит проверку на живых данных — это тестовый режим. Результаты не подтверждены. Не является инвестиционной рекомендацией.")}</p>
        <p>{t("Сигналы редкие: правила строгие, по всем монетам выходит примерно 1–2 сигнала в неделю.")}</p>
        <p className={s.guestCall}>{t("Тестовые сигналы видны после входа. Регистрация бесплатная.")}</p>
        <div className={s.guestActions}>
          <Button href="/register?next=/signals" variant="primary">
            {t("Регистрация")}
          </Button>
          <Button href="/login?next=/signals">{t("Войти")}</Button>
        </div>
      </div>
    </Panel>
  );
}

export default function SignalsPage() {
  const t = useT();
  const { user, loading } = useAuth();
  const [instruments, setInstruments] = useState<{ symbol: string; tick_size: string | null }[]>([]);
  const authed = Boolean(user);
  useEffect(() => {
    if (!authed) return;
    getInstruments()
      .then(setInstruments)
      .catch(() => {});
  }, [authed]);
  return (
    <AppShell title={t("Сигналы")}>
      {loading ? (
        <EmptyState text={t("Загрузка…")} />
      ) : !user ? (
        <GuestSignals />
      ) : (
        <>
          {!user.email_verified && (
            <div style={{ marginBottom: 12 }}>
              <Panel title={t("Подтвердите email")}>
                <EmptyState text={t("Письмо отправлено на {email}. Без подтверждения не будут приходить уведомления.", { email: user.email })} />
              </Panel>
            </div>
          )}
          <Suspense fallback={<EmptyState text={t("Загрузка…")} />}>
            <Feed instruments={instruments} />
          </Suspense>
        </>
      )}
    </AppShell>
  );
}
