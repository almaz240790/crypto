"use client";

import {
  addDrawing,
  alive,
  canRedo,
  canUndo,
  changedFibLevels,
  cleanDrawingLevels,
  clearDrawings,
  commitMove,
  createState,
  mergeRemote,
  normalizeFibLevels,
  redo,
  removeDrawing,
  sameFibLevels,
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
/** «Рисовать серию» — настройка устройства (не синхронизируется): инструмент не снимается после рисунка. */
export const SERIES_KEY = "pl-draw-series";
/**
 * Курсор чтения с сервера (аудит DTS-3): время записи на сервере из прошлого ответа, а не updated_at клиента — иначе
 * рисунок, нарисованный офлайн раньше уже прочитанных, на это устройство не приходил. Прежний ключ
 * pl-drawings-sync:<инструмент> (updated_at) не читается.
 */
const CURSOR = (symbol: string) => `pl-drawings-cursor:${symbol}`;
/** Лимит без входа (Free); с входом сервер отдаёт лимит тарифа. */
export const DRAWINGS_LIMIT = 10;

/**
 * Сервер не принял рисунки (аудит DTS-4): limit — лимит тарифа на инструмент symbol, invalid — прочие отказы. Рисунок
 * остаётся только на устройстве; очередь его больше не держит.
 */
export type DrawingsRefused = { code: "limit" | "invalid"; symbol: string; n: number };

function readCursor(symbol: string): number | null {
  try {
    const raw = localStorage.getItem(CURSOR(symbol));
    return raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
  } catch {
    return null;
  }
}

/** Убрать рисунки из памяти другого инструмента (призрак копии, которого сервер там не знает). */
function dropStored(symbol: string, ids: Set<string>): void {
  try {
    const list = load(symbol);
    if (list.some((d) => ids.has(d.id))) localStorage.setItem(KEY(symbol), JSON.stringify(list.filter((d) => !ids.has(d.id))));
  } catch {
    /* приватный режим */
  }
}

/** Рисунки из localStorage; уровни Фибоначчи приводятся (пустой список и мусор — уровни по умолчанию). */
function load(symbol: string): Drawing[] {
  try {
    const raw = localStorage.getItem(KEY(symbol));
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? (list as Drawing[]).map(cleanDrawingLevels) : [];
  } catch {
    return [];
  }
}

/**
 * Рисунки инструмента: состояние с undo/redo, инструмент, магнит, «серия», localStorage; с входом —
 * синхронизация с сервером (оптимистичная запись, офлайн-очередь, последняя запись побеждает).
 * Инструмент — на один рисунок (ADR-0009, «Рисование»): после рисунка контроллер снимает его, если «серия» выключена.
 *
 * onFibLevels — пользователь изменил уровни Фибоначчи: правкой в карточке (в том числе «стандартные»), отменой или
 * повтором такой правки. Хозяин запоминает набор для новых рисунков (настройки терминала); слияние с сервером и копия
 * на другой инструмент его не вызывают. onRefused — сервер не принял рисунки (лимит тарифа и др.): хозяин коротко
 * сообщает об этом.
 *
 * Очередь синхронизации общая для всех инструментов: из ответа сервера в состояние попадают только рисунки открытого
 * инструмента (аудит FI-2, DTS-1) — копия на другой инструмент и правки, оставшиеся в очереди до смены инструмента,
 * в чужой график не переезжают.
 */
export function useDrawings(symbol: string, authed: boolean, onFibLevels?: (levels: number[]) => void, onRefused?: (r: DrawingsRefused) => void) {
  const [state, setState] = useState<DrawingsState>(() => createState());
  const [tool, setTool] = useState<DrawingType | null>(null);
  const [magnet, setMagnet] = useState(true);
  const [series, setSeriesState] = useState(false);
  /** Поставлено точек начатого рисунка (0 — не начат): подсказка шага в чипе режима рисования. */
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Drawing | null>(null);
  const [limit, setLimit] = useState<number | null>(DRAWINGS_LIMIT);
  const [sync, setSync] = useState<"off" | "ok" | "queued" | "error">("off");
  const [limitHit, setLimitHit] = useState(false);
  const loaded = useRef<string | null>(null);
  const prevItems = useRef<Drawing[]>([]);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const onFibLevelsRef = useRef(onFibLevels);
  useEffect(() => {
    onFibLevelsRef.current = onFibLevels;
  }, [onFibLevels]);
  const onRefusedRef = useRef(onRefused);
  useEffect(() => {
    onRefusedRef.current = onRefused;
  }, [onRefused]);

  // «серия» — из памяти устройства после монтирования (на сервере её нет: без расхождения при гидратации)
  useEffect(() => {
    queueMicrotask(() => {
      try {
        setSeriesState(localStorage.getItem(SERIES_KEY) === "1");
      } catch {
        /* приватный режим */
      }
    });
  }, []);
  const setSeries = useCallback((v: boolean) => {
    setSeriesState(v);
    try {
      localStorage.setItem(SERIES_KEY, v ? "1" : "0");
    } catch {
      /* приватный режим */
    }
  }, []);

  const flush = useCallback(async () => {
    if (!authed) return;
    try {
      const { items, rejected } = await queueFlush();
      // инструмент, чьи рисунки сейчас в состоянии, — на момент ответа (замыкание могло остаться от прежнего)
      const open = loaded.current;
      const remote = items.filter((w) => w.symbol.toUpperCase() === open).map(fromWire);
      // призрак копии прежней сборки: рисунок с этим id принадлежит другому инструменту — убрать там, где он лишний
      const purge = new Set<string>();
      for (const x of rejected) {
        if (x.code !== "other_symbol" || !x.client_id || !x.symbol) continue;
        if (x.symbol === open) purge.add(x.client_id);
        else dropStored(x.symbol, new Set([x.client_id]));
      }
      // призрак убирается и из истории шагов: отмена его не возвращает
      const drop = (list: Drawing[]) => list.filter((d) => !purge.has(d.id));
      const clean = (s: DrawingsState) => (purge.size ? { ...s, items: drop(s.items), past: s.past.map(drop), future: s.future.map(drop) } : s);
      if (remote.length || purge.size) setState((s) => mergeRemote(clean(s), remote));
      // остальные отказы постоянны (лимит тарифа, негодный рисунок): рисунок остаётся только на устройстве
      const limited = rejected.filter((x) => x.code === "limit");
      const invalid = rejected.filter((x) => x.code !== "limit" && x.code !== "other_symbol");
      if (limited.length) onRefusedRef.current?.({ code: "limit", symbol: limited[0]!.symbol ?? "", n: limited.length });
      if (invalid.length) onRefusedRef.current?.({ code: "invalid", symbol: invalid[0]!.symbol ?? "", n: invalid.length });
      setSync("ok");
    } catch {
      setSync("queued");
    }
  }, [authed]);
  // отложенная отправка очереди — таймер в ref: его переставляет только новая правка. Ответ синхронизации и другие
  // изменения без правок его не сбрасывают — иначе рисунок, сделанный, пока шёл запрос, ждал бы следующего повода.
  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(flushTimer.current), []);

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
      setStep(0);
      setLimit(authed ? null : DRAWINGS_LIMIT);
    });
    if (!authed) return;
    listDrawings(symbol, readCursor(symbol))
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
        // API прежней сборки курсора не отдаёт: следующая загрузка снова прочитает всё
        if (typeof r.cursor === "number") {
          try {
            localStorage.setItem(CURSOR(symbol), String(r.cursor));
          } catch {
            /* приватный режим */
          }
        }
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
    clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(() => void flushRef.current(), 600);
  }, [state.items, symbol, authed]);

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
      // перетаскивание: промежуточные положения — без шага отмены; конец — один шаг от положения до перетаскивания
      move: (id: string, points: Point[], final: boolean, origin?: Point[]) => setState((s) => (final && origin ? commitMove(s, id, points, origin) : updateDrawing(s, id, { points }, final))),
      select: (id: string | null) => setState((s) => select(s, id)),
      remove: (id: string) => setState((s) => removeDrawing(s, id)),
      clear: () => setState((s) => clearDrawings(s)),
      lock: (id: string) => setState((s) => toggleLock(s, id)),
      patch: (id: string, p: Partial<Drawing>) => {
        // уровни Фибоначчи хранятся приведёнными; выбранный набор — он же у следующего рисунка
        const levels = p.levels ? normalizeFibLevels(p.levels) : null;
        // тот же набор («стандартные» у рисунка со стандартными уровнями) — без пустого шага отмены и синхронизации
        const cur = levels && Object.keys(p).length === 1 ? stateRef.current.items.find((d) => d.id === id) : undefined;
        if (!cur || !sameFibLevels(cur.levels, levels)) setState((s) => updateDrawing(s, id, levels ? { ...p, levels } : p));
        if (levels) onFibLevelsRef.current?.(levels);
      },
      hide: (v: boolean) => setState((s) => setHidden(s, v)),
      // отмена и повтор правки уровней возвращают и набор для новых Фибоначчи: он — то, что пользователь видит у рисунка
      undo: () => {
        const levels = changedFibLevels(stateRef.current.items, undo(stateRef.current).items);
        setState((s) => undo(s));
        if (levels) onFibLevelsRef.current?.(levels);
      },
      redo: () => {
        const levels = changedFibLevels(stateRef.current.items, redo(stateRef.current).items);
        setState((s) => redo(s));
        if (levels) onFibLevelsRef.current?.(levels);
      },
      /**
       * Копия на другой инструмент (план 2A.5): время как есть, цены умножаются на ratio. "limit" — у цели уже лимит
       * рисунков (по памяти устройства; с входом сервер проверяет ещё раз и при отказе вызывает onRefused).
       */
      copyTo: (id: string, target: string, ratio: number): Drawing | "limit" | null => {
        const src = stateRef.current.items.find((d) => d.id === id && !d.deleted_at);
        if (!src || target === symbol) return null;
        const there = load(target);
        if (limit !== null && there.filter((d) => !d.deleted_at).length >= limit) return "limit";
        const copy: Drawing = {
          ...src,
          id: `d_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
          points: src.points.map((pt) => ({ ...pt, price: pt.price * ratio })),
          locked: false,
          updated_at: Date.now(),
          deleted_at: null,
        };
        try {
          localStorage.setItem(KEY(target), JSON.stringify([...there, copy]));
        } catch {
          /* приватный режим */
        }
        if (authed) {
          // ответ про копию — рисунок цели: flush в состояние этого инструмента его не сливает
          queueAdd([toWire(copy, target)]);
          void flush();
        }
        return copy;
      },
    }),
    [limit, symbol, authed, flush],
  );

  const selected = state.items.find((d) => d.id === state.selectedId && !d.deleted_at) ?? null;
  const dismissLimit = useCallback(() => setLimitHit(false), []);
  // одна ссылка на список, пока состояние то же: правая панель (memo) не перерисовывается на каждом тике
  const items = useMemo(() => alive(state), [state]);
  return { state, items, selected, tool, setTool, magnet, setMagnet, series, setSeries, step, setStep, draft, setDraft, actions, canUndo: canUndo(state), canRedo: canRedo(state), limit, limitHit, dismissLimit, sync };
}
