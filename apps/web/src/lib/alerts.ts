import { api } from "./auth-client";

/** Алерты на графике (план 2A.6; задача 2B.13). */
export type AlertType = "price" | "indicator" | "zone" | "structure" | "pattern";
export type AlertFrequency = "once" | "every" | "once_per_bar";
export type AlertTrigger = { id: number; alert_id: number; triggered_at: string; price: string | null; details: Record<string, unknown>; notified: boolean };
export type Alert = {
  id: number;
  symbol: string | null;
  timeframe: string | null;
  type: AlertType;
  condition: Record<string, unknown>;
  text: string;
  frequency: AlertFrequency;
  expires_at: string | null;
  status: "active" | "triggered" | "expired" | "paused";
  drawing_client_id: string | null;
  note: string | null;
  last_triggered_at: string | null;
  triggers_count: number;
  created_at: string | null;
  last_trigger: AlertTrigger | null;
};
export type AlertIn = {
  symbol?: string | null;
  timeframe?: string | null;
  type: AlertType;
  condition: Record<string, unknown>;
  frequency?: AlertFrequency;
  expires_in_days?: number;
  note?: string | null;
  drawing_client_id?: string | null;
};
export type AlertsList = { items: Alert[]; active: number; limit: number | null; types: AlertType[]; frequencies: AlertFrequency[] };

export const getAlerts = (q: { symbol?: string; status?: string } = {}) => {
  const p = new URLSearchParams();
  if (q.symbol) p.set("symbol", q.symbol);
  if (q.status) p.set("status", q.status);
  const qs = p.toString();
  return api<AlertsList>(`/v1/alerts${qs ? `?${qs}` : ""}`);
};
export const createAlert = (body: AlertIn) => api<Alert>("/v1/alerts", { method: "POST", json: body });
export const patchAlert = (id: number, body: { status?: "active" | "paused"; note?: string; expires_in_days?: number }) => api<Alert>(`/v1/alerts/${id}`, { method: "PATCH", json: body });
export const deleteAlert = (id: number) => api(`/v1/alerts/${id}`, { method: "DELETE" });
export const getAlertTriggers = (limit = 100) => api<{ items: (AlertTrigger & { alert: Alert })[] }>(`/v1/alerts/triggers?limit=${limit}`);

export const STATUS_LABEL: Record<Alert["status"], string> = { active: "активен", triggered: "сработал", expired: "истёк", paused: "на паузе" };
export const FREQ_LABEL: Record<AlertFrequency, string> = { once: "один раз", every: "каждый раз", once_per_bar: "раз в свечу" };
export const TYPE_LABEL: Record<AlertType, string> = { price: "Цена", indicator: "Индикатор", zone: "Зона", structure: "Структура", pattern: "Паттерн" };
