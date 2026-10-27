"use client";

/** Данные терминала (план 2A.3, 2B.4): свечи порциями, слои. */
import type { Candle, Timeframe } from "@platform/charts";
import { api } from "./auth-client";

export type CandleOut = { t: number; o: string; h: string; l: string; c: string; v: string; open: boolean };
export type CandlesResponse = { symbol: string; tf: Timeframe; candles: CandleOut[]; current: CandleOut | null; has_older: boolean; tick_size: string | null; server_time: string };

export type Structure = {
  tf: string;
  strategy_version: string | null;
  swings: { t: number; p: string; kind: "high" | "low" }[];
  events: { t: number; type: "bos" | "choch"; dir: "up" | "down"; level: string; from_t: number }[];
  zones: { kind: string; dir: string; top: string; bottom: string; from_t: number; status: string }[];
  levels: Record<string, string | null>;
  equal_levels: { kind: string; p: string; from_t: number; to_t: number | null; swept: boolean }[];
  sweeps: { t: number; kind: "high" | "low"; level: string }[];
  bias: { bias: string; d1_trend: string; w1_trend: string; ema50_d1: string | null } | null;
  atr: string | null;
};
export type SignalOnChart = { id: string; version: string; dir: "long" | "short"; t: number; status: string; grade: string; entry: string | null; sl: string | null; tp: (string | null)[]; zone: { top: string; bottom: string; kind?: string } | null; events: { type: string; p: string | null; t: number }[] };
export type LayersResponse = { symbol: string; tf: string; structure: Structure | null; signals: SignalOnChart[]; server_time: string };

export { TIMEFRAMES } from "./timeframes";

export function toCandle(c: CandleOut): Candle {
  return { time: c.t, open: Number(c.o), high: Number(c.h), low: Number(c.l), close: Number(c.c), volume: Number(c.v), open_: c.open };
}

export const getCandles = (symbol: string, tf: Timeframe, before?: number) =>
  api<CandlesResponse>(`/v1/chart/candles?symbol=${symbol}&tf=${tf}${before ? `&before=${before}` : ""}&limit=500`);
export const getLayers = (symbol: string, tf: Timeframe) => api<LayersResponse>(`/v1/chart/layers?symbol=${symbol}&tf=${tf}`);

export type Derivatives = {
  symbol: string;
  tf: string;
  funding: { t: number; v: string }[];
  funding_current: string | null;
  next_funding_t: number | null;
  oi: { t: number; v: string }[];
  liquidations: { t: number; long: string; short: string }[];
  liquidations_note: string;
};
export const getDerivatives = (symbol: string, tf: Timeframe) => api<Derivatives>(`/v1/chart/derivatives?symbol=${symbol}&tf=${tf}&limit=500`, { auth: false });

export type PatternOnChart = { id: number; type: string; title: string; direction: "up" | "down" | null; status: string; significant: boolean; t: number; start_t: number; confirm_t: number; price: string | null; atr: string | null; context: Record<string, unknown>; source: string; tf: string };
export type PatternStat = { type: string; title: string; horizon: number; n: number; low_n: boolean; success_rate: string | null; ci_low: string | null; ci_high: string | null; avg_move_atr: string | null; avg_adverse_atr: string | null };
export type PatternsResponse = { symbol: string; tf: string; items: PatternOnChart[]; stats: Record<string, PatternStat>; horizon: number; note: string };
/** Свечные паттерны (план 2A.10.1, 2B.12): публично, по закрытым свечам. */
export const getPatterns = (symbol: string, tf: Timeframe, since?: number, until?: number) =>
  api<PatternsResponse>(`/v1/chart/patterns?symbol=${symbol}&tf=${tf}${since ? `&since=${since}` : ""}${until ? `&until=${until}` : ""}&limit=500`, { auth: false });

export type Explanation = { text: string; source: "llm" | "cache" | "template"; reason?: string; footer: string; generated_at: string; facts_hash: string; prompt_version: string; used?: number; limit?: number | null };
/** Объяснение паттерна по фактам (план 2A.10.3): Free — шаблон, Pro+ — текст модели с постпроверкой. */
export const explainPattern = (symbol: string, tf: Timeframe, pattern_id: number) => api<Explanation>("/v1/chart/explain", { method: "POST", json: { symbol, tf, pattern_id } });

/** Короткие подписи маркеров паттернов (план 2A.10.1): без оценочных слов. */
export const PATTERN_GLYPH: Record<string, string> = {
  engulfing: "ПГ",
  pin_bar: "ПБ",
  doji: "Д",
  doji_dragonfly: "Д↑",
  doji_gravestone: "Д↓",
  star: "ЗВ",
  three_line: "3",
  harami: "ХР",
  inside_bar: "ВБ",
  inside_bar_breakout: "ВБ›",
  marubozu: "МБ",
  tweezer: "ПЦ",
};

export type FigureOnChart = { id: number; type: string; title: string; direction: "up" | "down" | null; status: "forming" | "confirmed" | "invalidated"; scale: number; start_t: number; end_t: number; known_t: number; confirm_t: number | null; invalidated_t: number | null; points: [number, string][]; lines: { name: string; a: [number, string]; b: [number, string] }[]; breakout_level: string | null; target: string | null; invalidation: string | null; quality: number; metrics: Record<string, number>; source: string; tf: string };
export type FigureStat = { type: string; title: string; n: number; low_n: boolean; success_rate: string | null; ci_low: string | null; ci_high: string | null; avg_move_atr: string | null; avg_adverse_atr: string | null; avg_bars_to_target: string | null };
export type FiguresResponse = { symbol: string; tf: string; items: FigureOnChart[]; stats: Record<string, FigureStat>; note: string };
/** Графические фигуры (план 2A.10.2, 4B.6): публично, по закрытым свечам; только 4h/1d/1w. */
export const getFigures = (symbol: string, tf: Timeframe, since?: number, until?: number) =>
  api<FiguresResponse>(`/v1/chart/figures?symbol=${symbol}&tf=${tf}${since ? `&since=${since}` : ""}${until ? `&until=${until}` : ""}&limit=100`, { auth: false });
export const FIGURE_TFS: Timeframe[] = ["4h", "1d", "1w"];

/** Вопрос о графике (план 2A.10.3, 4B.7): Premium; текст ≤ 500 символов идёт как данные. */
export const askChart = (symbol: string, tf: Timeframe, question: string) => api<Explanation>("/v1/chart/ask", { method: "POST", json: { symbol, tf, question } });
