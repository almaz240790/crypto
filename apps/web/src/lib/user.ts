"use client";

/** Клиентские вызовы пользовательских разделов (план 3.6–3.9, 3.12). */
import { api, type Me } from "./auth-client";

export type ScreenerRow = {
  symbol: string;
  instrument_id: number;
  exchange: string;
  error?: string;
  price?: string;
  change_24h?: string | null;
  volume_24h?: string | null;
  bias?: string;
  d1_trend?: string;
  w1_trend?: string;
  last_event?: { type: string; direction: string; time: string; level: string } | null;
  zone?: { kind: string; direction: string; top: string; bottom: string; status: string; distance_atr: string | null; distance_pct: string | null } | null;
  atr_pct?: string | null;
  atr_percentile?: string | null;
  beta_btc?: string | null;
  funding?: string | null;
  funding_pct?: string | null;
  oi_change_24h?: string | null;
  liq_long_24h?: string | null;
  liq_short_24h?: string | null;
};

export type JournalEntry = {
  id: number;
  symbol: string;
  direction: "long" | "short";
  entry_price: string;
  entry_at: string;
  stop_loss: string | null;
  take_profits: string[];
  size: string | null;
  exit_price: string | null;
  exit_at: string | null;
  realized_r: string | null;
  realized_quote: string | null;
  fees: string | null;
  tags: string[];
  note: string | null;
  source: string;
  signal_id: number | null;
  created_at: string | null;
};

export type JournalSummary = {
  trades: number;
  closed: number;
  sum_r: string;
  avg_r: string | null;
  winrate: number | null;
  linked: number;
  executed_share: number | null;
  system_avg_r: string | null;
};

export type JournalIn = {
  symbol: string;
  direction: "long" | "short";
  entry_price: string;
  entry_at: string;
  stop_loss?: string | null;
  take_profits?: string[];
  size?: string | null;
  exit_price?: string | null;
  exit_at?: string | null;
  fees?: string | null;
  tags?: string[];
  note?: string | null;
  signal_id?: string | null;
};

export type Instrument = { id: number; symbol: string; base: string; quote: string; tick_size: string | null; lot_size: string | null };

export const getScreener = (symbols?: string[]) =>
  api<{ items: ScreenerRow[]; generated_at: string; sparklines?: Record<string, string[]> }>(`/v1/screener${symbols?.length ? `?symbols=${symbols.join(",")}` : ""}`, { auth: false });

/** Фильтры скринера (план 3.6 v2): пустая строка — без фильтра. */
export type ScreenerFilters = { bias: string; near: string; d1: string; w1: string; event: string; atrp: string; funding: string; change: string; zone_kind: string };
export const EMPTY_FILTERS: ScreenerFilters = { bias: "", near: "", d1: "", w1: "", event: "", atrp: "", funding: "", change: "", zone_kind: "" };
export type SavedScreen = { name: string; filters: Partial<ScreenerFilters>; created_at: string };
export const getScreens = () => api<SavedScreen[]>("/v1/screener/screens");
export const putScreen = (name: string, filters: Partial<ScreenerFilters>) => api<SavedScreen>("/v1/screener/screens", { method: "PUT", json: { name, filters } });
export const deleteScreen = (name: string) => api<void>(`/v1/screener/screens?name=${encodeURIComponent(name)}`, { method: "DELETE" });

export const getInstruments = () => api<Instrument[]>("/v1/instruments", { auth: false });

export const getWatchlist = () => api<{ id: number; name: string; items: { symbol: string; instrument_id: number; added_at: string }[] }>("/v1/watchlist");
export const addWatch = (symbol: string) => api("/v1/watchlist/items", { method: "POST", json: { symbol } });
export const removeWatch = (symbol: string) => api(`/v1/watchlist/items/${symbol}`, { method: "DELETE" });

export type AnalyticsBucket = { key: string | number; trades: number; closed: number; sum_r: string; avg_r: string | null; winrate: number | null };
export type JournalAnalytics = {
  total: Omit<AnalyticsBucket, "key">;
  by_weekday: AnalyticsBucket[];
  by_symbol: AnalyticsBucket[];
  by_grade: AnalyticsBucket[];
  equity: { points: { t: string; r: string }[]; max_drawdown_r: string | null };
  errors: { early_exit: { count: number; of: number }; no_signal: { count: number; of: number }; risk_exceeded: { count: number; of: number; budget_usd: string | null } };
};
export const getJournalAnalytics = () => api<JournalAnalytics>("/v1/journal/analytics");
export const getJournal = (limit = 200) => api<{ items: JournalEntry[]; summary: JournalSummary }>(`/v1/journal?limit=${limit}`);
export const createJournal = (body: JournalIn) => api<JournalEntry>("/v1/journal", { method: "POST", json: body });
export const updateJournal = (id: number, body: JournalIn) => api<JournalEntry>(`/v1/journal/${id}`, { method: "PUT", json: body });
export const deleteJournal = (id: number) => api(`/v1/journal/${id}`, { method: "DELETE" });

export type TwoFactorStatus = { enabled: boolean; backup_codes_left: number };
export const getTwoFactor = () => api<TwoFactorStatus>("/v1/me/2fa");
export const setupTwoFactor = () => api<{ secret: string; otpauth_url: string }>("/v1/me/2fa/setup", { method: "POST" });
export const enableTwoFactor = (code: string) => api<{ enabled: boolean; backup_codes: string[] }>("/v1/me/2fa/enable", { method: "POST", json: { code } });
export const disableTwoFactor = (code: string) => api<void>("/v1/me/2fa/disable", { method: "POST", json: { code } });

export const getIdentities = () => api<{ provider: string; label: string; connected_at: string | null }[]>("/v1/me/identities");
export const changePassword = (current_password: string | null, new_password: string) =>
  api("/v1/me/password", { method: "POST", json: { current_password, new_password } });
export const deleteAccount = () => api("/v1/me", { method: "DELETE" });
export const exportData = () => api<Record<string, unknown>>("/v1/me/export.json");

export type { Me };
