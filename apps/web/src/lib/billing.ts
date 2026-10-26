"use client";

/** Тарифы и оплата (план 3.13): клиентские вызовы /v1/billing. */
import { api } from "./auth-client";

export type PlanInfo = { code: "pro" | "premium"; title: string; prices: Record<string, string>; price_month: string; price_year: string };
export type Months = 1 | 3 | 12;

export type BillingMe = {
  plan: "free" | "pro" | "premium";
  billing_enabled: boolean;
  balance_usd: string;
  subscription: {
    plan: string;
    status: string;
    provider: string;
    current_period_end: string;
    trial_end: string | null;
    in_grace: boolean;
    days_left: number;
  } | null;
};

export type Quote = { plan: string; months: number; price: string; discount: string; balance_applied: string; amount_due: string; promo_code: string | null };

export type PaymentOut = {
  id: string;
  plan: string;
  months: number;
  price_usd: string;
  discount_usd: string;
  balance_applied_usd: string;
  amount_due_usd: string;
  promo_code: string | null;
  provider: string;
  status: "pending" | "paid" | "underpaid" | "expired" | "failed" | "refunded";
  invoice_url: string | null;
  pay_currency: string | null;
  actually_paid: string | null;
  actually_paid_usd: string | null;
  tx_hash: string | null;
  expires_at: string | null;
  paid_at: string | null;
  created_at: string | null;
};

export const PLAN_TITLE: Record<string, string> = { free: "Free", pro: "Pro", premium: "Premium" };
export const PAYMENT_STATUS: Record<PaymentOut["status"], string> = {
  pending: "ожидает оплаты",
  paid: "оплачен",
  underpaid: "оплачен не полностью",
  expired: "истёк",
  failed: "ошибка",
  refunded: "возврат",
};

export const getPlans = () => api<{ plans: PlanInfo[]; billing_enabled: boolean }>("/v1/billing/plans", { auth: false });
export const getBillingMe = () => api<BillingMe>("/v1/billing/me");
export const getPayments = () => api<PaymentOut[]>("/v1/billing/payments");
export const getQuote = (plan: string, months: Months, promo_code: string | null) => api<Quote>("/v1/billing/quote", { method: "POST", json: { plan, months, promo_code: promo_code || null } });
export const checkout = (plan: string, months: Months, promo_code: string | null) =>
  api<{ payment: PaymentOut; paid_from_balance: boolean }>("/v1/billing/checkout", { method: "POST", json: { plan, months, promo_code: promo_code || null } });
export const refreshPayment = (id: string) => api<PaymentOut>(`/v1/billing/payments/${id}/refresh`, { method: "POST" });
