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
  equity: { t: string; r: number }[];
  worst_drawdowns: { start: string; trough: string; depth_r: number }[];
  scope: string;
  generated_at: string;
};

export type SignalRow = {
  id: string;
  symbol: string;
  strategy_version: string;
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

async function get<T>(path: string, revalidate = 60): Promise<T | null> {
  try {
    const res = await fetch(`${API_URL}${path}`, {
      next: { revalidate },
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function getStats(days = 90): Promise<Stats | null> {
  return get<Stats>(`/v1/stats?days=${days}`);
}

export async function getClosedSignals(limit = 5): Promise<SignalRow[]> {
  const r = await get<{ items: SignalRow[] }>(`/v1/signals?status=closed&limit=${limit}`);
  return r?.items ?? [];
}

export function getHealth(): Promise<Health | null> {
  return get<Health>("/health", 30);
}
