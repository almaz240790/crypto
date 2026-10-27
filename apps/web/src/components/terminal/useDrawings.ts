"use client";

import {
  addDrawing,
  canRedo,
  canUndo,
  clearDrawings,
  createState,
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

const KEY = (symbol: string) => `pl-drawings:${symbol}`;
/** Лимит на инструмент до появления серверной синхронизации и тарифных лимитов (2B.7, раздел 4). */
export const DRAWINGS_LIMIT = 100;

function load(symbol: string): Drawing[] {
  try {
    const raw = localStorage.getItem(KEY(symbol));
    return raw ? (JSON.parse(raw) as Drawing[]) : [];
  } catch {
    return [];
  }
}

/** Рисунки инструмента: состояние с undo/redo, инструмент, магнит, сохранение в localStorage. */
export function useDrawings(symbol: string) {
  const [state, setState] = useState<DrawingsState>(() => createState());
  const [tool, setTool] = useState<DrawingType | null>(null);
  const [magnet, setMagnet] = useState(true);
  const [draft, setDraft] = useState<Drawing | null>(null);
  const [limitHit, setLimitHit] = useState(false);
  const loaded = useRef<string | null>(null);

  useEffect(() => {
    queueMicrotask(() => {
      setState(createState(load(symbol)));
      loaded.current = symbol;
      setTool(null);
      setDraft(null);
    });
  }, [symbol]);

  useEffect(() => {
    if (loaded.current !== symbol) return;
    try {
      localStorage.setItem(KEY(symbol), JSON.stringify(state.items));
    } catch {
      /* приватный режим */
    }
  }, [state.items, symbol]);

  const actions = useMemo(
    () => ({
      create: (d: Drawing) =>
        setState((s) => {
          if (s.items.length >= DRAWINGS_LIMIT) {
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
    [],
  );

  const selected = state.items.find((d) => d.id === state.selectedId) ?? null;
  const dismissLimit = useCallback(() => setLimitHit(false), []);
  return { state, selected, tool, setTool, magnet, setMagnet, draft, setDraft, actions, canUndo: canUndo(state), canRedo: canRedo(state), limitHit, dismissLimit };
}
