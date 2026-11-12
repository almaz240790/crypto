import { UNDO_STEPS, type Drawing, type Point } from "./types";

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

/**
 * Конец перетаскивания рисунка: промежуточные положения шли без записи в историю (updateDrawing, record = false),
 * поэтому шаг отмены пишется от положения до перетаскивания (origin) — отмена возвращает рисунок туда, откуда его
 * взяли, а не в последнее промежуточное положение.
 */
export function commitMove(state: DrawingsState, id: string, points: Point[], origin: Point[]): DrawingsState {
  const before = { ...state, items: state.items.map((d) => (d.id === id ? { ...d, points: origin } : d)) };
  return updateDrawing(before, id, { points }, true);
}

/** Удаление — мягкое: остаётся запись с ``deleted_at`` для синхронизации. */
export function removeDrawing(state: DrawingsState, id: string): DrawingsState {
  const now = Date.now();
  const next = commit(state, state.items.map((d) => (d.id === id ? { ...d, deleted_at: now, updated_at: now } : d)));
  return { ...next, selectedId: state.selectedId === id ? null : state.selectedId };
}

export function clearDrawings(state: DrawingsState): DrawingsState {
  const now = Date.now();
  return { ...commit(state, state.items.map((d) => (d.deleted_at ? d : { ...d, deleted_at: now, updated_at: now }))), selectedId: null };
}

/** Живые (не удалённые) рисунки. */
export function alive(state: DrawingsState): Drawing[] {
  return state.items.filter((d) => !d.deleted_at);
}

/**
 * Применить версии с сервера: последняя запись побеждает по updated_at, при равенстве — удаление. Победившая версия
 * попадает и в снимки истории, где рисунок был тем же, что сейчас (или его не было): отмена своего шага не удаляет
 * рисунок с другого устройства и не откатывает чужую правку или удаление (отмена — новая версия, см. restore).
 */
export function mergeRemote(state: DrawingsState, remote: Drawing[]): DrawingsState {
  const byId = new Map(state.items.map((d) => [d.id, d]));
  const won = new Map<string, { was: Drawing | undefined; now: Drawing }>();
  for (const r of remote) {
    const local = byId.get(r.id);
    const next = resolve(local, r);
    if (next !== local) won.set(r.id, { was: local, now: next });
    byId.set(r.id, next);
  }
  const items = [...byId.values()].sort((a, b) => a.updated_at - b.updated_at);
  if (won.size === 0) return { ...state, items };
  const rebase = (snap: Drawing[]) => {
    const out = snap.map((d) => {
      const w = won.get(d.id);
      return w && w.was === d ? w.now : d;
    });
    for (const [id, w] of won) if (!w.was && !snap.some((d) => d.id === id)) out.push(w.now);
    return out;
  };
  return { ...state, items, past: state.past.map(rebase), future: state.future.map(rebase) };
}

export function resolve(local: Drawing | undefined, remote: Drawing): Drawing {
  if (!local) return remote;
  if (remote.updated_at > local.updated_at) return remote;
  if (remote.updated_at < local.updated_at) return local;
  return remote.deleted_at ? remote : local;
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

/**
 * Снимок истории как новая версия рисунков (аудит FI-1, DTS-2). Синхронизация — последняя запись побеждает по
 * updated_at: снимок со старыми метками сервер и слияние на клиенте откатили бы назад, а выброшенный рисунок (отмена
 * создания) до сервера не дошёл бы вовсе. Поэтому рисунок, отличный от текущего, получает новый updated_at (позже
 * текущей версии, даже в ту же миллисекунду); рисунок, которого в снимке нет, остаётся удалённым (deleted_at), а
 * повтор возвращает его живым новой версией. Нетронутые рисунки (тот же объект в снимке и сейчас) остаются как есть:
 * их синхронизировать не нужно.
 */
function restore(current: Drawing[], snapshot: Drawing[]): Drawing[] {
  const now = Date.now();
  const cur = new Map(current.map((d) => [d.id, d]));
  const stamp = (was: Drawing | undefined) => Math.max(now, (was?.updated_at ?? 0) + 1);
  const out = snapshot.map((d) => {
    const c = cur.get(d.id);
    return c === d ? c : { ...d, updated_at: stamp(c) };
  });
  const kept = new Set(snapshot.map((d) => d.id));
  for (const c of current) {
    if (kept.has(c.id)) continue;
    const t = stamp(c);
    out.push(c.deleted_at ? c : { ...c, deleted_at: t, updated_at: t });
  }
  return out;
}

export function undo(state: DrawingsState): DrawingsState {
  const prev = state.past[state.past.length - 1];
  if (!prev) return state;
  return { ...state, items: restore(state.items, prev), past: state.past.slice(0, -1), future: [state.items, ...state.future].slice(0, UNDO_STEPS), selectedId: null };
}

export function redo(state: DrawingsState): DrawingsState {
  const next = state.future[0];
  if (!next) return state;
  return { ...state, items: restore(state.items, next), past: [...state.past, state.items].slice(-UNDO_STEPS), future: state.future.slice(1), selectedId: null };
}

export const canUndo = (s: DrawingsState) => s.past.length > 0;
export const canRedo = (s: DrawingsState) => s.future.length > 0;

/** Рисунки, видимые на таймфрейме: без привязки или с этой привязкой. */
export function visibleOn(state: DrawingsState, timeframe: string): Drawing[] {
  if (state.hidden) return [];
  return state.items.filter((d) => !d.deleted_at && (d.timeframe === null || d.timeframe === timeframe));
}
