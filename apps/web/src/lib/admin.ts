"use client";

import { api } from "./auth-client";

export type AdminVersion = { id: number; strategy: string; name: string; version: string; status: string; params: Record<string, unknown>; created_by: string | null; approved_by: string | null; activated_at: string | null; signals: number };
export type AdminRun = { id: number; strategy_version: string; period: [string, string]; instruments: number; note: string | null; metrics: Record<string, number | null> };
export type StatusRequest = { id: number; strategy_version_id: number; from_status: string; to_status: string; reason: string; requested_by: string; requested_by_id: number; decision: string; decision_note: string | null; created_at: string | null; decided_at: string | null };
export type AdminStrategies = { versions: AdminVersion[]; runs: AdminRun[]; requests: StatusRequest[]; me: { id: number; role: string } };
export type AdminInstrument = { id: number; symbol: string; exchange: string; market_type: string; is_active: boolean; tick_size: string | null; lot_size: string | null; min_notional: string | null; last_h4: string | null };
export type AdminSignal = { id: string; symbol: string; version: string; scope: string; direction: string; grade: string; score: number; status: string; candle_close_time: string; entry: string | null; stop: string | null; flags: string[]; facts: string[]; input_hash: string };
export type AdminUser = { id: number; email: string; name: string | null; role: string; country: string | null; verified: boolean; created_at: string | null; blocked_at: string | null; blocked_reason: string | null; deleted: boolean; plan?: string; plan_until?: string | null; plan_status?: string | null };
export type Promo = { id: number; code: string; percent: number; fixed_usd: string; plan: string | null; max_uses: number | null; used: number; expires_at: string | null; active: boolean; created_at: string | null };
export type SystemStatus = { now: string; workers: Record<string, { heartbeat_age_sec: number | null; status?: Record<string, unknown> | null } | string>; candles_h4: { instruments: number; stale_over_5h: number }; last_signal_at: string | null; last_event_at: string | null; notifications_sent_today: number; mail: string };
export type AuditRow = { id: number; actor: string; action: string; target: string; payload: Record<string, unknown>; at: string | null };

export const getStrategies = () => api<AdminStrategies>("/v1/admin/strategies");
export const createStatusRequest = (strategy_version_id: number, to_status: string, reason: string) => api("/v1/admin/strategies/status-requests", { method: "POST", json: { strategy_version_id, to_status, reason } });
export const decideStatusRequest = (id: number, approve: boolean, note: string | null) => api(`/v1/admin/strategies/status-requests/${id}/decide`, { method: "POST", json: { approve, note } });
export const getInstruments = () => api<AdminInstrument[]>("/v1/admin/instruments");
export const patchInstrument = (id: number, body: Record<string, unknown>) => api(`/v1/admin/instruments/${id}`, { method: "PATCH", json: body });
export const getSignals = (status?: string) => api<AdminSignal[]>(`/v1/admin/signals${status ? `?status=${status}` : ""}`);
export const cancelSignal = (id: string, reason: string) => api(`/v1/admin/signals/${id}/cancel`, { method: "POST", json: { reason } });
export const getUsers = (q?: string) => api<AdminUser[]>(`/v1/admin/users${q ? `?q=${encodeURIComponent(q)}` : ""}`);
export const patchUser = (id: number, body: Record<string, unknown>) => api(`/v1/admin/users/${id}`, { method: "PATCH", json: body });
export const getSystem = () => api<SystemStatus>("/v1/admin/system");
export const getAudit = () => api<AuditRow[]>("/v1/admin/audit");
export const getPromos = () => api<Promo[]>("/v1/admin/promo");
export const createPromo = (body: { code: string; percent: number; fixed_usd: string; plan: string | null; max_uses: number | null; expires_at: string | null }) => api<Promo>("/v1/admin/promo", { method: "POST", json: body });
export const togglePromo = (id: number, active: boolean) => api<Promo>(`/v1/admin/promo/${id}?active=${active}`, { method: "PATCH" });
export const grantSubscription = (userId: number, plan: string, months: number, reason: string) => api(`/v1/admin/users/${userId}/subscription`, { method: "POST", json: { plan, months, reason } });

/** Разметка кандидатов фигур (план 2A.10.2; 4B.2). */
export type LabelCandidate = { figure_id: number; symbol: string; tf: string; window_from: number; window_to: number; span_from: number; span_to: number; types: { id: string; title: string }[] };
export type LabelStats = { labelers: { id: number; email: string | null; n: number; avg_time_s: number; labels: Record<string, number> }[]; kappa: { a: number; b: number; n: number; kappa: number | null }[]; candidates_labeled: number; consensus: Record<string, number>; per_type: Record<string, number>; target_per_type: number; generated_at: string };
export const getNextLabel = () => api<{ candidate: LabelCandidate | null; message?: string }>("/v1/admin/labels/next");
export const submitLabel = (body: { figure_id: number; label: "figure" | "not_figure" | "unsure"; figure_type?: string | null; time_spent_s: number }) => api("/v1/admin/labels", { method: "POST", json: body });
export const getLabelStats = () => api<LabelStats>("/v1/admin/labels/stats");
export const labelImageUrl = (figureId: number) => `/v1/admin/labels/${figureId}/image.png`;
