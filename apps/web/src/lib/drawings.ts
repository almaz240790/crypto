"use client";

/** Синхронизация рисунков и раскладок терминала (план 2A.5, 2B.7). */
import type { Drawing } from "@platform/charts";
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

export const fromWire = (w: DrawingWire): Drawing => ({
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

export const listDrawings = (symbol: string, since = 0) => api<{ symbol: string; items: DrawingWire[]; limit: number | null; sync: boolean }>(`/v1/drawings?symbol=${symbol}&since=${since}`);
export const upsertDrawings = (items: DrawingWire[]) => api<{ items: DrawingWire[] }>("/v1/drawings", { method: "PUT", json: items });

export type LayoutData = Record<string, unknown>;
export const getLayout = () => api<{ name: string | null; data: LayoutData | null; updated_at: number }>("/v1/chart/layout");
export const putLayout = (data: LayoutData, updated_at: number) => api<{ data: LayoutData; updated_at: number }>("/v1/chart/layout", { method: "PUT", json: { name: null, data, updated_at } });

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

/** Отправить очередь; при ошибке сети очередь остаётся. Возвращает ответы сервера. */
export async function queueFlush(): Promise<DrawingWire[]> {
  const q = queueRead();
  if (q.length === 0) return [];
  const r = await upsertDrawings(q.slice(0, 200));
  const sent = new Set(q.slice(0, 200).map((x) => x.client_id));
  queueWrite(q.filter((x) => !sent.has(x.client_id)));
  return r.items;
}
