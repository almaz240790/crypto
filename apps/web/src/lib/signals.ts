"use client";

/** Типы и вызовы API ленты сигналов (план 3.4). */
import { api } from "./auth-client";
import type { SignalRow } from "./api";

export type { SignalRow };

/** Область сигнала: live — выпущенные версии; forward — «тестовые сигналы» (ADR-0013). */
export type Scope = "live" | "forward";

/** Плашка у каждого тестового сигнала и одна строка пояснения (ADR-0013). Меняются только вместе с ADR. */
export const TEST_BADGE = "Тестовый режим";
export const TEST_LINE = "Это сигналы стратегии, которая проходит проверку на живых данных. Результаты не подтверждены. Не является инвестиционной рекомендацией.";

export type FeedResponse = {
  items: SignalRow[];
  sparklines: Record<string, string[]>;
  prices: Record<string, { p: string; at: string }>;
  total: number;
  scope: Scope;
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
  /** Есть live-версия или live-сигналы. */
  live_available?: boolean;
  /** Пользователю видны тестовые сигналы, и версия в тестовом режиме есть. */
  test_available?: boolean;
  /** Что лента открывает без явного выбора: тестовые, пока нет live. */
  default_scope?: Scope;
};

export type FeedFilters = {
  tab: "open" | "closed" | "all";
  symbol: string;
  grade: string;
  direction: string;
  /** "" — без явного выбора: область решает сервер (default_scope сводки). */
  scope: Scope | "";
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
  scope: "",
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
    scope: scope === "forward" || scope === "live" ? scope : "",
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

/**
 * Область ленты: явный выбор из адреса, иначе — по сводке сервера (тестовые, пока нет live). null — сводка ещё не
 * пришла, запрашивать рано. Сводка без новых полей (старый API) — live, как раньше.
 */
export function effectiveScope(f: Pick<FeedFilters, "scope">, meta: Pick<Summary, "default_scope"> | null | undefined): Scope | null {
  if (f.scope) return f.scope;
  if (meta === undefined) return null;
  return meta?.default_scope === "forward" ? "forward" : "live";
}

/** Вкладки «Live» / «Тестовые»: когда есть обе области или открыта не та, что по умолчанию (чтобы было куда вернуться). */
export function scopeTabs(scope: Scope, meta: Pick<Summary, "default_scope" | "live_available" | "test_available"> | null | undefined): Scope[] {
  if (!meta?.test_available) return [];
  const def: Scope = meta.default_scope === "forward" ? "forward" : "live";
  return meta.live_available || scope !== def ? ["live", "forward"] : [];
}

/** `scope` — область запроса; без неё — явный выбор из фильтров, иначе live (вотчлист считает live-сигналы). */
export function fetchFeed(f: FeedFilters, scope: Scope = f.scope || "live"): Promise<FeedResponse> {
  const sp = new URLSearchParams({
    status: f.tab,
    scope,
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

export function fetchSummary(scope: Scope = "live"): Promise<Summary> {
  return api<Summary>(`/v1/signals/summary?scope=${scope}`);
}

/**
 * Текст всплывающего сообщения о смене статуса по WebSocket: у тестового сигнала — с пометкой «Тестовый режим».
 * `label` — уже переведённый статус («в работе», «TP1»).
 */
export function statusToast(ev: { scope?: string }, symbol: string, label: string, testBadge: string): string {
  return `${ev.scope === "forward" ? `${testBadge} · ` : ""}${symbol}: ${label}`;
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
