import type { Timeframe } from "@platform/charts";
import { ApiError } from "@/lib/auth-client";
import { INTRADAY } from "@/lib/timeframes";

/**
 * Сбой загрузки первой порции свечей (аудит chart-data-live-1, TSA-2): статус ответа API (null — ответа нет: сеть,
 * обрыв) и текст сервера. Текст сервера на экран не идёт — он русский и не для человека; экран выбирает объяснение
 * по статусу (loadErrorKind).
 */
export type LoadError = { status: number | null; message: string };

/** Паузы перед повторами первой порции после сбоя, с; дальше — последняя. */
export const LOAD_RETRY_S = [2, 5, 15, 30] as const;

export function loadError(e: unknown): LoadError {
  if (e instanceof ApiError) return { status: e.status, message: e.message };
  return { status: null, message: e instanceof Error ? e.message : String(e) };
}

/** Повторять ли загрузку самим: нет ответа, 5xx, 408 и 429 — да; отказ по тарифу (403), нет инструмента (404) и прочие 4xx — нет. */
export function retryable(e: LoadError): boolean {
  return e.status === null || e.status >= 500 || e.status === 408 || e.status === 429;
}

/** Пауза перед повтором номер `tries` (с нуля), мс. */
export function retryDelayMs(tries: number): number {
  return LOAD_RETRY_S[Math.min(tries, LOAD_RETRY_S.length - 1)]! * 1000;
}

/**
 * Что показать вместо графика: «1m–15m — Pro» — только отказ (403) на минутном ТФ (гость или Free); «инструмент не
 * найден» — 404; остальное — сбой загрузки с «Повторить».
 */
export function loadErrorKind(e: LoadError, tf: Timeframe): "intraday" | "not_found" | "failed" {
  if (e.status === 403 && INTRADAY.includes(tf)) return "intraday";
  if (e.status === 404) return "not_found";
  return "failed";
}
