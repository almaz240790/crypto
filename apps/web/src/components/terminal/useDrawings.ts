"use client";

import {
  addDrawing,
  alive,
  canRedo,
  canUndo,
  clearDrawings,
  createState,
  mergeRemote,
  redo,
  removeDrawing,
  select,
  setHidden,
  toggleLock,
  undo,
  updateDrawing,
  type Drawing,
  type DrawingType,
  type DrawingsState,
  type Point,
} from "@platform/charts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fromWire, listDrawings, queueAdd, queueFlush, toWire } from "@/lib/drawings";

const KEY = (symbol: string) => `pl-drawings:${symbol}`;
const SYNC_AT = (symbol: string) => `pl-drawings-sync:${symbol}`;
/** Лимит без входа (Free); с входом сервер отдаёт лимит тарифа. */
export const DRAWINGS_LIMIT = 10;

function load(symbol: string): Drawing[] {
  try {
    const raw = localStorage.getItem(KEY(symbol));
    return raw ? (JSON.parse(raw) as Drawing[]) : [];
  } catch {
    return [];
  }
}

/**
 * Рисунки инструмента: состояние с undo/redo, инструмент, магнит, localStorage; с входом —
 * синхронизация с сервером (оптимистичная запись, офлайн-очередь, последняя запись побеждает).
 */
export function useDrawings(symbol: string, authed: boolean) {
  const [state, setState] = useState<DrawingsState>(() => createState());
  const [tool, setTool] = useState<DrawingType | null>(null);
  const [magnet, setMagnet] = useState(true);
  const [draft, setDraft] = useState<Drawing | null>(null);
  const [limit, setLimit] = useState<number | null>(DRAWINGS_LIMIT);
  const [sync, setSync] = useState<"off" | "ok" | "queued" | "error">("off");
  const [limitHit, setLimitHit] = useState(false);
  const loaded = useRef<string | null>(null);
  const prevItems = useRef<Drawing[]>([]);

  const flush = useCallback(async () => {
    if (!authed) return;
    try {
      const answered = await queueFlush();
      if (answered.length) {
        const remote = answered.map(fromWire);
        setState((s) => mergeRemote(s, remote));
      }
      setSync("ok");
    } catch {
      setSync("queued");
    }
  }, [authed]);

  // загрузка: локально сразу, затем слияние с сервером
  useEffect(() => {
    let dead = false;
    const local = load(symbol);
    queueMicrotask(() => {
      setState(createState(local));
      prevItems.current = local;
      loaded.current = symbol;
      setTool(null);
      setDraft(null);
      setLimit(authed ? null : DRAWINGS_LIMIT);
    });
    if (!authed) return;
    const since = Number(localStorage.getItem(SYNC_AT(symbol)) ?? 0) || 0;
    listDrawings(symbol, since)
      .then((r) => {
        if (dead) return;
        setLimit(r.limit);
        if (!r.sync) {
          setSync("off");
          return;
        }
        const remote = r.items.map(fromWire);
        setState((s) => {
          const merged = mergeRemote(s, remote);
          prevItems.current = merged.items;
          // всё локальное, чего на сервере нет или что новее — в очередь
          const serverById = new Map(remote.map((d) => [d.id, d.updated_at]));
          const pending = merged.items.filter((d) => (serverById.get(d.id) ?? -1) < d.updated_at);
          if (pending.length) queueAdd(pending.map((d) => toWire(d, symbol)));
          return merged;
        });
        const maxUpd = Math.max(since, ...r.items.map((i) => i.updated_at));
        localStorage.setItem(SYNC_AT(symbol), String(maxUpd));
        setSync("ok");
        void flush();
      })
      .catch(() => !dead && setSync("error"));
    return () => {
      dead = true;
    };
  }, [symbol, authed, flush]);

  // сохранение локально + постановка изменений в очередь (оптимистично, с задержкой 600 мс)
  useEffect(() => {
    if (loaded.current !== symbol) return;
    try {
      localStorage.setItem(KEY(symbol), JSON.stringify(state.items));
    } catch {
      /* приватный режим */
    }
    if (!authed) return;
    const prev = new Map(prevItems.current.map((d) => [d.id, d]));
    const changed = state.items.filter((d) => prev.get(d.id) !== d && (prev.get(d.id)?.updated_at ?? -1) !== d.updated_at);
    prevItems.current = state.items;
    if (changed.length === 0) return;
    queueAdd(changed.map((d) => toWire(d, symbol)));
    setSync("queued");
    const t = setTimeout(() => void flush(), 600);
    return () => clearTimeout(t);
  }, [state.items, symbol, authed, flush]);

  useEffect(() => {
    if (!authed) return;
    const on = () => void flush();
    window.addEventListener("online", on);
    return () => window.removeEventListener("online", on);
  }, [authed, flush]);

  const actions = useMemo(
    () => ({
      create: (d: Drawing) =>
        setState((s) => {
          if (limit !== null && alive(s).length >= limit) {
            setLimitHit(true);
            return s;
          }
          return addDrawing(s, d);
        }),
      move: (id: string, points: Point[], final: boolean) => setState((s) => updateDrawing(s, id, { points }, final)),
      select: (id: string | null) => setState((s) => select(s, id)),
      remove: (id: string) => setState((s) => removeDrawing(s, id)),
      clear: () => setState((s) => clearDrawings(s)),
      lock: (id: string) => setState((s) => toggleLock(s, id)),
      patch: (id: string, p: Partial<Drawing>) => setState((s) => updateDrawing(s, id, p)),
      hide: (v: boolean) => setState((s) => setHidden(s, v)),
      undo: () => setState((s) => undo(s)),
      redo: () => setState((s) => redo(s)),
    }),
    [limit],
  );

  const selected = state.items.find((d) => d.id === state.selectedId && !d.deleted_at) ?? null;
  const dismissLimit = useCallback(() => setLimitHit(false), []);
  return { state, items: alive(state), selected, tool, setTool, magnet, setMagnet, draft, setDraft, actions, canUndo: canUndo(state), canRedo: canRedo(state), limit, limitHit, dismissLimit, sync };
}
