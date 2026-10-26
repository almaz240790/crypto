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
