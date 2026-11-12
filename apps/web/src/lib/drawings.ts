"use client";

/** Синхронизация рисунков и раскладок терминала (план 2A.5, 2B.7). */
import { cleanDrawingLevels, type Drawing } from "@platform/charts";
import { api } from "./auth-client";

export type DrawingWire = {
  client_id: string;
  symbol: string;
  timeframe: string | null;
  type: Drawing["type"];
  points: { time: number; price: number }[];
  style: Drawing["style"];
  text: string | null;
  levels: number[] | null;
  locked: boolean;
  updated_at: number;
  deleted_at: number | null;
};

export const toWire = (d: Drawing, symbol: string): DrawingWire => ({
  client_id: d.id,
  symbol,
  timeframe: d.timeframe,
  type: d.type,
  points: d.points,
  style: d.style,
  text: d.text ?? null,
  levels: d.levels ?? null,
  locked: d.locked,
  updated_at: d.updated_at,
  deleted_at: d.deleted_at ?? null,
});

/** Рисунок с сервера: уровни Фибоначчи приводятся (пустой список и мусор — уровни по умолчанию), у других типов их нет. */
export const fromWire = (w: DrawingWire): Drawing =>
  cleanDrawingLevels({
    id: w.client_id,
    type: w.type,
    points: w.points,
    style: w.style,
    text: w.text ?? undefined,
    levels: w.levels ?? undefined,
    locked: w.locked,
    timeframe: w.timeframe,
    updated_at: w.updated_at,
    deleted_at: w.deleted_at,
  });

/**
 * Отказ сервера одному рисунку пакета (аудит DTS-4): постоянный — рисунок убирается из очереди, остальные записаны.
 * code: limit — лимит тарифа на инструмент; other_symbol — рисунок с этим id принадлежит другому инструменту (призрак
 * копии); unknown_symbol и invalid — инструмента нет или рисунок негодный.
 */
export type DrawingRejected = { client_id: string | null; symbol: string | null; status: number; code: string; detail: string };

/**
 * Рисунки инструмента. cursor — курсор сервера из прошлого ответа (время записи на сервере, аудит DTS-3); без него —
 * все рисунки. API прежней сборки параметр cursor не знает и отдаёт все рисунки без курсора в ответе.
 */
export const listDrawings = (symbol: string, cursor: number | null) =>
  api<{ symbol: string; items: DrawingWire[]; limit: number | null; sync: boolean; cursor?: number }>(`/v1/drawings?symbol=${symbol}${cursor === null ? "" : `&cursor=${cursor}`}`);
/** Пакетная запись; rejected нет у API прежней сборки (он отклонял весь пакет ошибкой). */
export const upsertDrawings = (items: DrawingWire[]) => api<{ items: DrawingWire[]; rejected?: DrawingRejected[] }>("/v1/drawings", { method: "PUT", json: items });

export type LayoutData = Record<string, unknown>;
export const getLayout = (name?: string) => api<{ name: string | null; data: LayoutData | null; updated_at: number }>(`/v1/chart/layout${name ? `?name=${encodeURIComponent(name)}` : ""}`);
export const putLayout = (data: LayoutData, updated_at: number, name: string | null = null) => api<{ data: LayoutData; updated_at: number }>("/v1/chart/layout", { method: "PUT", json: { name, data, updated_at } });
export const listLayouts = () => api<{ name: string; updated_at: number }[]>("/v1/chart/layouts");
export const deleteLayout = (name: string) => api<void>(`/v1/chart/layout?name=${encodeURIComponent(name)}`, { method: "DELETE" });

/** Офлайн-очередь: изменения, не доставленные на сервер (по client_id — последняя версия). */
const QUEUE = "pl-drawings-queue";

export function queueRead(): DrawingWire[] {
  try {
    return JSON.parse(localStorage.getItem(QUEUE) ?? "[]") as DrawingWire[];
  } catch {
    return [];
  }
}

export function queueWrite(items: DrawingWire[]): void {
  try {
    localStorage.setItem(QUEUE, JSON.stringify(items));
  } catch {
    /* приватный режим */
  }
}

export function queueAdd(items: DrawingWire[]): void {
  const q = new Map(queueRead().map((x) => [x.client_id, x]));
  for (const it of items) q.set(it.client_id, it);
  queueWrite([...q.values()]);
}

/**
 * Отправить очередь (до 200 рисунков всех инструментов). Ошибка запроса (сеть, 5xx, отказ всего пакета) — исключение,
 * очередь остаётся. Ответ — версии сервера и отказы по рисункам: принятые и отклонённые уходят из очереди (отказ
 * постоянный — повтор его не изменит, а остальную очередь он не держит). Версия, поставленная в очередь заново, пока
 * шёл запрос, остаётся до следующей отправки.
 */
export async function queueFlush(): Promise<{ items: DrawingWire[]; rejected: DrawingRejected[] }> {
  const batch = queueRead().slice(0, 200);
  if (batch.length === 0) return { items: [], rejected: [] };
  const r = await upsertDrawings(batch);
  const sent = new Map(batch.map((x) => [x.client_id, x.updated_at]));
  queueWrite(queueRead().filter((x) => sent.get(x.client_id) !== x.updated_at));
  return { items: r.items, rejected: r.rejected ?? [] };
}
