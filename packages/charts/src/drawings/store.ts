import { UNDO_STEPS, type Drawing } from "./types";

/** Состояние рисунков с отменой/повтором (50 шагов) — чистые функции без побочных эффектов. */
export type DrawingsState = {
  items: Drawing[];
  past: Drawing[][];
  future: Drawing[][];
  hidden: boolean;
  selectedId: string | null;
};

export function createState(items: Drawing[] = []): DrawingsState {
  return { items, past: [], future: [], hidden: false, selectedId: null };
}

function commit(state: DrawingsState, items: Drawing[]): DrawingsState {
  const past = [...state.past, state.items].slice(-UNDO_STEPS);
  return { ...state, items, past, future: [] };
}

export function addDrawing(state: DrawingsState, d: Drawing): DrawingsState {
  return { ...commit(state, [...state.items, d]), selectedId: d.id };
}

export function updateDrawing(state: DrawingsState, id: string, patch: Partial<Drawing>, record = true): DrawingsState {
  const items = state.items.map((d) => (d.id === id ? { ...d, ...patch, updated_at: Date.now() } : d));
  return record ? commit(state, items) : { ...state, items };
}

export function removeDrawing(state: DrawingsState, id: string): DrawingsState {
  const next = commit(state, state.items.filter((d) => d.id !== id));
  return { ...next, selectedId: state.selectedId === id ? null : state.selectedId };
}

export function clearDrawings(state: DrawingsState): DrawingsState {
  return { ...commit(state, []), selectedId: null };
}

export function toggleLock(state: DrawingsState, id: string): DrawingsState {
  const d = state.items.find((x) => x.id === id);
  return d ? updateDrawing(state, id, { locked: !d.locked }) : state;
}

export function select(state: DrawingsState, id: string | null): DrawingsState {
  return { ...state, selectedId: id };
}

export function setHidden(state: DrawingsState, hidden: boolean): DrawingsState {
  return { ...state, hidden };
}

export function undo(state: DrawingsState): DrawingsState {
  const prev = state.past[state.past.length - 1];
  if (!prev) return state;
  return { ...state, items: prev, past: state.past.slice(0, -1), future: [state.items, ...state.future].slice(0, UNDO_STEPS), selectedId: null };
}

export function redo(state: DrawingsState): DrawingsState {
  const next = state.future[0];
  if (!next) return state;
  return { ...state, items: next, past: [...state.past, state.items].slice(-UNDO_STEPS), future: state.future.slice(1), selectedId: null };
}

export const canUndo = (s: DrawingsState) => s.past.length > 0;
export const canRedo = (s: DrawingsState) => s.future.length > 0;

/** Рисунки, видимые на таймфрейме: без привязки или с этой привязкой. */
export function visibleOn(state: DrawingsState, timeframe: string): Drawing[] {
  if (state.hidden) return [];
  return state.items.filter((d) => d.timeframe === null || d.timeframe === timeframe);
}
