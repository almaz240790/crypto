"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { getBillingMe } from "@/lib/billing";

/** Доступ к «Спросить»: гость, тариф ниже Premium, есть; null — тариф ещё не известен. */
export type AskAccess = "guest" | "plan" | "ok" | null;

/**
 * Тариф пользователя в терминале (план 2B.9): узнаём один раз после входа (админам и владельцу не нужно).
 * askAccess — вопросы о графике (Premium; админы и владелец — всегда). intradayLocked — минутные ТФ
 * закрыты: гость или тариф Free. Пока вход проверяется или тариф неизвестен, замков нет, чтобы не мигало.
 */
export function usePlan(): { plan: string | null; askAccess: AskAccess; intradayLocked: boolean } {
  const { user, loading } = useAuth();
  const [plan, setPlan] = useState<string | null>(null);
  const staff = !!user && (user.role === "admin" || user.role === "owner");
  useEffect(() => {
    if (!user || user.role === "admin" || user.role === "owner") return;
    getBillingMe()
      .then((b) => setPlan(b.plan))
      .catch(() => setPlan("free"));
  }, [user]);
  const askAccess: AskAccess = !user ? "guest" : staff || plan === "premium" ? "ok" : plan === null ? null : "plan";
  const intradayLocked = !user ? !loading : !staff && plan === "free";
  return { plan, askAccess, intradayLocked };
}
