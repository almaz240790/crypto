"use client";

/** Данные терминала (план 2A.3, 2B.4): свечи порциями, слои. */
import type { Candle, FigureOnChart, PatternOnChart, SignalOnChart, Structure, Timeframe } from "@platform/charts";
import { api } from "./auth-client";

export type CandleOut = { t: number; o: string; h: string; l: string; c: string; v: string; open: boolean };
export type CandlesResponse = { symbol: string; tf: Timeframe; candles: CandleOut[]; current: CandleOut | null; has_older: boolean; tick_size: string | null; server_time: string };

/** Типы ответов слоёв живут в пакете графика (scene/wire.ts) — сцена читает их без копий. */
export type { FigureOnChart, PatternOnChart, SignalOnChart, Structure } from "@platform/charts";
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
  /** Соотношение long/short аккаунтов (все / топ-трейдеры), индикаторы v2. */
  ls_ratio?: { t: number; v: string }[];
  ls_top?: { t: number; v: string }[];
};
export const getDerivatives = (symbol: string, tf: Timeframe) => api<Derivatives>(`/v1/chart/derivatives?symbol=${symbol}&tf=${tf}&limit=500`, { auth: false });

export type PatternStat = { type: string; title: string; horizon: number; n: number; low_n: boolean; success_rate: string | null; ci_low: string | null; ci_high: string | null; avg_move_atr: string | null; avg_adverse_atr: string | null };
export type PatternsResponse = { symbol: string; tf: string; items: PatternOnChart[]; stats: Record<string, PatternStat>; horizon: number; note: string };
/** Свечные паттерны (план 2A.10.1, 2B.12): публично, по закрытым свечам. */
export const getPatterns = (symbol: string, tf: Timeframe, since?: number, until?: number) =>
  api<PatternsResponse>(`/v1/chart/patterns?symbol=${symbol}&tf=${tf}${since ? `&since=${since}` : ""}${until ? `&until=${until}` : ""}&limit=500`, { auth: false });

export type Explanation = { text: string; source: "llm" | "cache" | "template"; reason?: string; footer: string; generated_at: string; facts_hash: string; prompt_version: string; used?: number; limit?: number | null };
/** Объяснение паттерна по фактам (план 2A.10.3): Free — шаблон, Pro+ — текст модели с постпроверкой. */
export const explainPattern = (symbol: string, tf: Timeframe, pattern_id: number) => api<Explanation>("/v1/chart/explain", { method: "POST", json: { symbol, tf, pattern_id } });

/** Подписи паттернов на графике (план 2A.10.1): понятные названия без оценочных слов. */
export const PATTERN_LABEL: Record<string, string> = {
  engulfing: "поглощение",
  pin_bar: "пин-бар",
  doji: "доджи",
  doji_dragonfly: "доджи-стрекоза",
  doji_gravestone: "доджи-надгробие",
  star: "звезда",
  three_line: "три свечи",
  harami: "харами",
  inside_bar: "внутренний бар",
  inside_bar_breakout: "пробой вн. бара",
  marubozu: "марубозу",
  tweezer: "пинцет",
};

export type FigureStat = { type: string; title: string; n: number; low_n: boolean; success_rate: string | null; ci_low: string | null; ci_high: string | null; avg_move_atr: string | null; avg_adverse_atr: string | null; avg_bars_to_target: string | null };
export type FiguresResponse = { symbol: string; tf: string; items: FigureOnChart[]; stats: Record<string, FigureStat>; note: string };
/** Графические фигуры (план 2A.10.2, 4B.6): публично, по закрытым свечам; только 4h/1d/1w. */
export const getFigures = (symbol: string, tf: Timeframe, since?: number, until?: number) =>
  api<FiguresResponse>(`/v1/chart/figures?symbol=${symbol}&tf=${tf}${since ? `&since=${since}` : ""}${until ? `&until=${until}` : ""}&limit=100`, { auth: false });
export const FIGURE_TFS: Timeframe[] = ["4h", "1d", "1w"];

/** Вопрос о графике (план 2A.10.3, 4B.7): Premium; текст ≤ 500 символов идёт как данные. */
export const askChart = (symbol: string, tf: Timeframe, question: string) => api<Explanation>("/v1/chart/ask", { method: "POST", json: { symbol, tf, question } });
