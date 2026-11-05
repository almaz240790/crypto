"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { getBillingMe } from "@/lib/billing";

/** Доступ к «Спросить»: гость, тариф ниже Premium, есть; null — тариф ещё не известен. */
export type AskAccess = "guest" | "plan" | "ok" | null;

/** Тариф не узнали (сбой /v1/billing/me и повтора): минутные ТФ не запираются — решает ответ сервера на свечи. */
export const PLAN_UNKNOWN = "unknown";
const RETRY_MS = 3000;

/**
 * Тариф пользователя в терминале (план 2B.9): узнаём после входа (админам и владельцу не нужно), при сбое — ещё
 * раз через 3 с. askAccess — вопросы о графике (Premium; админы и владелец — всегда). intradayLocked — минутные ТФ
 * закрыты: гость или тариф Free. Пока вход проверяется или тариф неизвестен (в том числе после сбоя), замков нет:
 * платящий не должен видеть замки из-за сбоя биллинга, а без тарифа сервер сам откажет в свечах.
 */
export function usePlan(): { plan: string | null; askAccess: AskAccess; intradayLocked: boolean } {
  const { user, loading } = useAuth();
  const [plan, setPlan] = useState<string | null>(null);
  const staff = !!user && (user.role === "admin" || user.role === "owner");
  useEffect(() => {
    if (!user || user.role === "admin" || user.role === "owner") return;
    let dead = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = (retry: boolean) =>
      getBillingMe()
        .then((b) => !dead && setPlan(b.plan))
        .catch(() => {
          if (dead) return;
          if (retry) timer = setTimeout(() => load(false), RETRY_MS);
          else setPlan(PLAN_UNKNOWN);
        });
    load(true);
    return () => {
      dead = true;
      clearTimeout(timer);
    };
  }, [user]);
  const askAccess: AskAccess = !user ? "guest" : staff || plan === "premium" ? "ok" : plan === null ? null : "plan";
  const intradayLocked = !user ? !loading : !staff && plan === "free";
  return { plan, askAccess, intradayLocked };
}
