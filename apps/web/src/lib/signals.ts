"use client";

/** Типы и вызовы API ленты сигналов (план 3.4). */
import { api } from "./auth-client";
import type { SignalRow } from "./api";

export type { SignalRow };

export type FeedResponse = {
  items: SignalRow[];
  sparklines: Record<string, string[]>;
  prices: Record<string, { p: string; at: string }>;
  total: number;
  scope: "live" | "forward";
  limit: number;
  offset: number;
  restrictions?: { plan: string; grades: string[] | null; delay_hours: number; all_instruments: boolean } | null;
};

export type Summary = {
  active: number;
  today_new: number;
  next_h4_close: string;
  now: string;
  scope: string;
};

export type FeedFilters = {
  tab: "open" | "closed" | "all";
  symbol: string;
  grade: string;
  direction: string;
  scope: "live" | "forward";
  days: string;
  sort: string;
  order: "asc" | "desc";
  page: number;
};

export const PAGE = 50;

export const DEFAULT_FILTERS: FeedFilters = {
  tab: "open",
  symbol: "",
  grade: "",
  direction: "",
  scope: "live",
  days: "",
  sort: "time",
  order: "desc",
  page: 0,
};

export function filtersFromSearch(sp: URLSearchParams): FeedFilters {
  const tab = sp.get("tab");
  const order = sp.get("order");
  const scope = sp.get("scope");
  return {
    tab: tab === "closed" || tab === "all" ? tab : "open",
    symbol: (sp.get("symbol") ?? "").toUpperCase(),
    grade: sp.get("grade") ?? "",
    direction: sp.get("direction") ?? "",
    scope: scope === "forward" ? "forward" : "live",
    days: sp.get("days") ?? "",
    sort: sp.get("sort") ?? "time",
    order: order === "asc" ? "asc" : "desc",
    page: Math.max(0, Number(sp.get("page") ?? 0) || 0),
  };
}

export function filtersToSearch(f: FeedFilters): string {
  const sp = new URLSearchParams();
  (Object.keys(DEFAULT_FILTERS) as (keyof FeedFilters)[]).forEach((k) => {
    const v = f[k];
    if (v !== DEFAULT_FILTERS[k] && v !== "" && v !== 0) sp.set(k, String(v));
  });
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export function fetchFeed(f: FeedFilters): Promise<FeedResponse> {
  const sp = new URLSearchParams({
    status: f.tab,
    scope: f.scope,
    sort: f.sort,
    order: f.order,
    limit: String(PAGE),
    offset: String(f.page * PAGE),
  });
  if (f.symbol) sp.set("symbol", f.symbol);
  if (f.grade) sp.set("grade", f.grade);
  if (f.direction) sp.set("direction", f.direction);
  if (f.days) sp.set("days", f.days);
  return api<FeedResponse>(`/v1/signals?${sp}`);
}

export function fetchSummary(scope: string): Promise<Summary> {
  return api<Summary>(`/v1/signals/summary?scope=${scope}`);
}

export function addToWatchlist(symbol: string): Promise<unknown> {
  return api("/v1/watchlist/items", { method: "POST", json: { symbol } });
}

export function journalFromSignal(s: SignalRow): Promise<unknown> {
  return api("/v1/journal", {
    method: "POST",
    json: {
      symbol: s.symbol,
      direction: s.direction,
      entry_price: s.entry_limit ?? s.entry_market,
      entry_at: new Date().toISOString(),
      stop_loss: s.stop_loss,
      take_profits: [s.tp1, s.tp2, s.tp3].filter(Boolean),
      signal_id: s.id,
      tags: ["signal"],
    },
  });
}

/** Нереализованный результат открытого сигнала в R по текущей цене. */
export function unrealizedR(s: SignalRow, price: string | undefined): number | null {
  if (!price || !s.stop_loss) return null;
  const entry = Number(s.entry_limit ?? s.entry_market);
  const stop = Number(s.stop_loss);
  const p = Number(price);
  const risk = Math.abs(entry - stop);
  if (!(risk > 0) || !Number.isFinite(p)) return null;
  if (s.status === "pending") return null; // вход ещё не исполнен
  const sign = s.direction === "long" ? 1 : -1;
  return ((p - entry) * sign) / risk;
}
