/**
 * Клиент публичного API (apps/api). Только серверные вызовы для SSR-страниц.
 * Адрес — переменная окружения API_URL (на сервере) или NEXT_PUBLIC_API_URL.
 * Ошибки сети не роняют страницу: возвращаем null и показываем честное пустое состояние.
 */

export const API_URL =
  process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export type Metrics = {
  signals: number;
  closed: number;
  expired: number;
  open: number;
  winrate: number | null;
  avg_r: number | null;
  profit_factor: number | null;
  expectancy: number | null;
  max_drawdown_r: number;
  max_losing_streak: number;
  tp1_share: number | null;
  tp2_share: number | null;
  tp3_share: number | null;
  sum_r: number;
  avg_duration_hours: number | null;
};

export type Stats = {
  metrics: Metrics;
  by_grade: Record<string, Metrics>;
  by_symbol: Record<string, Metrics>;
  by_month: Record<string, Metrics>;
  by_direction: Record<string, Metrics>;
  by_entry_type: Record<string, Metrics>;
  r_histogram: { from: number | null; to: number | null; n: number }[];
  equity: { t: string; r: number }[];
  worst_drawdowns: { start: string; trough: string; depth_r: number }[];
  run?: BacktestRunMeta | null;
  scope: "live" | "forward" | "backtest";
  generated_at: string;
};

export type BacktestRunMeta = {
  id: number;
  strategy_version: string;
  period: [string, string];
  instruments: number;
  entry_type: string;
  fee_rate?: string | null;
  slippage?: string | null;
  note: string | null;
  created_at: string | null;
  closed?: number | null;
};

export type StrategyVersionInfo = {
  id: number;
  strategy: string;
  name: string;
  version: string;
  status: string;
  activated_at: string | null;
};

export type StatsQuery = {
  scope?: "live" | "forward" | "backtest";
  version?: string;
  run_id?: string;
  symbol?: string;
  grade?: string;
  entry_type?: string;
  days?: string;
};

export type TradeRowOut = {
  id: string;
  symbol: string;
  direction: "long" | "short";
  signal_time: string;
  grade: string;
  score: number;
  entry: string;
  stop: string;
  rr_tp2: string;
  entry_type: string;
  status: string;
  tp_hits: number;
  realized_r: number | null;
  mfe_r: number;
  mae_r: number;
  exit_time: string | null;
};

export function statsSearch(q: StatsQuery): string {
  const sp = new URLSearchParams();
  (Object.keys(q) as (keyof StatsQuery)[]).forEach((k) => {
    const v = q[k];
    if (v) sp.set(k, v);
  });
  return sp.toString();
}

export type SignalRow = {
  id: string;
  symbol: string;
  instrument_id: number;
  strategy_version: string;
  last_event_at: string | null;
  direction: "long" | "short";
  candle_close_time: string;
  created_at: string;
  entry_market: string | null;
  entry_limit: string | null;
  stop_loss: string | null;
  tp1: string | null;
  tp2: string | null;
  tp3: string | null;
  rr_tp2: string | null;
  score: number;
  grade: "A" | "B" | "C";
  status: string;
  flags: string[];
  result: {
    realized_r: string | null;
    closed_at: string;
    duration_hours: string | null;
    max_favorable_r: string | null;
    max_adverse_r: string | null;
  } | null;
};

export type Health = {
  status: string;
  db: string;
  schema: string;
  candles: string;
  env: string;
};

/** Предел ожидания API при рендере страниц: зависший API не должен держать страницу. */
const API_TIMEOUT_MS = 5000;

async function get<T>(path: string, revalidate = 60): Promise<T | null> {
  try {
    const res = await fetch(`${API_URL}${path}`, {
      next: { revalidate },
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    // в том числе таймаут (TimeoutError)
    return null;
  }
}

export function getStats(days = 90): Promise<Stats | null> {
  return get<Stats>(`/v1/stats?days=${days}`);
}

export function getStatsFor(q: StatsQuery): Promise<Stats | null> {
  return get<Stats>(`/v1/stats?${statsSearch(q)}`);
}

export function getStrategies(): Promise<StrategyVersionInfo[]> {
  return get<StrategyVersionInfo[]>("/v1/strategies", 300).then((r) => r ?? []);
}

export function getRuns(): Promise<BacktestRunMeta[]> {
  return get<BacktestRunMeta[]>("/v1/stats/runs", 300).then((r) => r ?? []);
}

export async function getStatsTrades(
  q: StatsQuery,
  offset = 0,
  limit = 50,
): Promise<{ items: TradeRowOut[]; total: number } | null> {
  return get<{ items: TradeRowOut[]; total: number }>(
    `/v1/stats/trades?${statsSearch(q)}&offset=${offset}&limit=${limit}`,
  );
}

export async function getClosedSignals(limit = 5): Promise<SignalRow[]> {
  const r = await get<{ items: SignalRow[] }>(`/v1/signals?status=closed&limit=${limit}`);
  return r?.items ?? [];
}

/** Число инструментов в работе — для цифр на главной. */
export async function getInstrumentCount(): Promise<number | null> {
  const list = await get<unknown[]>("/v1/instruments", 3600);
  return list ? list.length : null;
}

/** Цена за месяц по тарифам с сервера (apps/api/app/plans.py) — для главной; null, если API недоступен. */
export async function getMonthPrices(): Promise<Record<string, string> | null> {
  const r = await get<{ plans: { code: string; price_month: string }[] }>("/v1/billing/plans", 3600);
  return r ? Object.fromEntries(r.plans.map((p) => [p.code, p.price_month])) : null;
}

/** Закрытия последних дневных свечей (только закрытые) — для фоновой линии на главной; null, если API недоступен. */
export async function getDailyCloses(symbol = "BTCUSDT", count = 240): Promise<number[] | null> {
  const r = await get<{ candles: { c: string; open?: boolean }[] }>(`/v1/chart/candles?symbol=${symbol}&tf=1d&limit=500`, 3600);
  if (!r) return null;
  const closes = r.candles.filter((c) => !c.open).map((c) => Number(c.c));
  return closes.length > 10 ? closes.slice(-count) : null;
}

export function getHealth(): Promise<Health | null> {
  return get<Health>("/health", 30);
}

export type PatternStatItem = {
  type: string;
  title: string;
  horizon: number;
  n: number;
  low_n: boolean;
  success_rate: string | null;
  ci_low: string | null;
  ci_high: string | null;
  avg_move_atr: string | null;
  avg_adverse_atr: string | null;
  period_start: string | null;
  period_end: string | null;
};
export type PatternStats = {
  scope: string;
  tf: string;
  horizon: number;
  with_context: boolean | null;
  items: PatternStatItem[];
  note: string;
  computed_at: string | null;
  by_year?: (PatternStatItem & { year: number })[];
  by_context?: Record<"significant" | "found", PatternStatItem>;
};

/** Историческая отработка свечных паттернов (план 2A.10.4). */
export function getPatternStats(q: { tf?: string; scope?: string; horizon?: number; type?: string; with_context?: boolean | null }): Promise<PatternStats | null> {
  const p = new URLSearchParams();
  if (q.tf) p.set("tf", q.tf);
  if (q.scope) p.set("scope", q.scope);
  if (q.horizon) p.set("horizon", String(q.horizon));
  if (q.type) p.set("type", q.type);
  if (q.with_context !== undefined && q.with_context !== null) p.set("with_context", String(q.with_context));
  return get<PatternStats>(`/v1/stats/patterns?${p.toString()}`, 300);
}

export type FigureStatItem = {
  type: string;
  title: string;
  n: number;
  low_n: boolean;
  success_rate: string | null;
  ci_low: string | null;
  ci_high: string | null;
  avg_move_atr: string | null;
  avg_adverse_atr: string | null;
  avg_bars_to_target: string | null;
};
export type FigureStats = { scope: string; tf: string; horizon: number; items: FigureStatItem[]; note: string; computed_at: string | null; by_year?: (FigureStatItem & { year: number })[] };

/** Историческая отработка графических фигур (план 2A.10.4, 4B.6). */
export function getFigureStats(q: { tf?: string; scope?: string; type?: string }): Promise<FigureStats | null> {
  const p = new URLSearchParams();
  if (q.tf) p.set("tf", q.tf);
  if (q.scope) p.set("scope", q.scope);
  if (q.type) p.set("type", q.type);
  return get<FigureStats>(`/v1/stats/figures?${p.toString()}`, 300);
}
