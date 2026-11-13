"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { getBillingMe, getPlans, type BillingMe } from "@/lib/billing";

/** Доступ к «Спросить»: гость, тариф ниже Premium, есть; null — тариф ещё не известен. */
export type AskAccess = "guest" | "plan" | "ok" | null;

/**
 * Доступ к мультичарту (план, раздел 4: Premium; ADR-0009, дополнение 2026-11-13): "guest" — гость при включённой
 * оплате, "plan" — тариф без мультичарта, "ok" — сетка; null — ещё не известно (ни сетки, ни замка).
 */
export type MultichartAccess = "guest" | "plan" | "ok" | null;

/** Тариф не узнали (сбой /v1/billing/me и повтора): минутные ТФ не запираются — решает ответ сервера на свечи. */
export const PLAN_UNKNOWN = "unknown";
const RETRY_MS = 3000;

/**
 * Право на мультичарт из /v1/billing/me: поле multichart сервера (entitlements_for); API без этого поля — Premium
 * или оплата выключена (тогда — у всех).
 */
export function multichartOf(b: Pick<BillingMe, "plan" | "billing_enabled"> & { multichart?: boolean }): boolean {
  return b.multichart ?? (!b.billing_enabled || b.plan === "premium");
}

/**
 * Что показать на /multichart. Вошедший — по праву тарифа (multichart из usePlan). Гость — по billing_enabled из
 * /v1/billing/plans: оплата выключена — сетка, как до решения; включена — замок. Биллинг не ответил (PLAN_UNKNOWN) —
 * замка нет, как у минутных ТФ: платящий не должен видеть замок из-за сбоя.
 */
export function multichartAccess(o: { loading: boolean; authed: boolean; multichart: boolean | null; guestBilling: boolean | typeof PLAN_UNKNOWN | null }): MultichartAccess {
  if (o.authed) return o.multichart === null ? null : o.multichart ? "ok" : "plan";
  if (o.loading || o.guestBilling === null) return null;
  return o.guestBilling === true ? "guest" : "ok";
}

/**
 * Тариф пользователя в терминале (план 2B.9): узнаём после входа (админам и владельцу не нужно), при сбое — ещё
 * раз через 3 с. askAccess — вопросы о графике (Premium; админы и владелец — всегда). intradayLocked — минутные ТФ
 * закрыты: гость или тариф Free. Пока вход проверяется или тариф неизвестен (в том числе после сбоя), замков нет:
 * платящий не должен видеть замки из-за сбоя биллинга, а без тарифа сервер сам откажет в свечах. multichart — право
 * вошедшего на мультичарт (админы и владелец — всегда, сбой — есть); гость и тариф ещё не известен — null.
 */
export function usePlan(): { plan: string | null; askAccess: AskAccess; intradayLocked: boolean; multichart: boolean | null } {
  const { user, loading } = useAuth();
  const [me, setMe] = useState<{ plan: string; multichart: boolean } | null>(null);
  const staff = !!user && (user.role === "admin" || user.role === "owner");
  useEffect(() => {
    if (!user || user.role === "admin" || user.role === "owner") return;
    let dead = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = (retry: boolean) =>
      getBillingMe()
        .then((b) => !dead && setMe({ plan: b.plan, multichart: multichartOf(b) }))
        .catch(() => {
          if (dead) return;
          if (retry) timer = setTimeout(() => load(false), RETRY_MS);
          else setMe({ plan: PLAN_UNKNOWN, multichart: true });
        });
    load(true);
    return () => {
      dead = true;
      clearTimeout(timer);
    };
  }, [user]);
  const plan = me?.plan ?? null;
  const askAccess: AskAccess = !user ? "guest" : staff || plan === "premium" ? "ok" : plan === null ? null : "plan";
  const intradayLocked = !user ? !loading : !staff && plan === "free";
  const multichart = !user ? null : staff ? true : (me?.multichart ?? null);
  return { plan, askAccess, intradayLocked, multichart };
}

/**
 * Доступ к странице мультичарта и замок минутных ТФ в её ячейках (один запрос тарифа на страницу). Гостю — запрос
 * /v1/billing/plans (включена ли оплата), при сбое — ещё раз через 3 с; терминал его не делает.
 */
export function useMultichartAccess(): { access: MultichartAccess; intradayLocked: boolean } {
  const { user, loading } = useAuth();
  const { multichart, intradayLocked } = usePlan();
  const [guestBilling, setGuestBilling] = useState<boolean | typeof PLAN_UNKNOWN | null>(null);
  useEffect(() => {
    if (loading || user) return;
    let dead = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = (retry: boolean) =>
      getPlans()
        .then((r) => !dead && setGuestBilling(r.billing_enabled))
        .catch(() => {
          if (dead) return;
          if (retry) timer = setTimeout(() => load(false), RETRY_MS);
          else setGuestBilling(PLAN_UNKNOWN);
        });
    load(true);
    return () => {
      dead = true;
      clearTimeout(timer);
    };
  }, [loading, user]);
  return { access: multichartAccess({ loading, authed: !!user, multichart, guestBilling }), intradayLocked };
}
