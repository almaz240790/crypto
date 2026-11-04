"use client";

import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SideTabId } from "../panels/sideTabs";

/**
 * Состояние интерфейса терминала (план 2B.9): открытый лист, панели, ширина панели объектов, тост.
 * Ничего не знает о данных графика и настройках; TerminalShell раздаёт его компонентам.
 */

export type SheetId = "indicators" | "layers" | "draw" | "found" | "alert" | "ask";

const OBJECTS_W_KEY = "pl-objects-w";
/** Открыта ли правая панель на широком экране (≥ 1280): shown | hidden, по умолчанию shown. */
const OBJECTS_KEY = "pl-objects";
export const OBJECTS_W_DEFAULT = 300;
const OBJECTS_W_MIN = 280;
const OBJECTS_W_MAX = 600;
/** Не шире 40 % окна: на 1280 панель оставляет графику не меньше 60 %. */
const OBJECTS_W_SHARE = 0.4;
const clampW = (w: number) => {
  const max = typeof window === "undefined" ? OBJECTS_W_MAX : Math.max(OBJECTS_W_MIN, Math.min(OBJECTS_W_MAX, window.innerWidth * OBJECTS_W_SHARE));
  return Math.round(Math.min(max, Math.max(OBJECTS_W_MIN, w)));
};
type Shown = "shown" | "hidden";

export const TOAST_MS = 2500;

export type ObjectsResize = {
  active: boolean;
  step: (delta: number) => void;
  start: (e: React.PointerEvent<HTMLElement>) => void;
};

/**
 * wide — окно не уже 1280 px: правая панель встроена в сетку и по умолчанию открыта (состояние в pl-objects).
 * Уже — панель выдвигается поверх графика, при загрузке закрыта и не запоминается.
 */
export function useTerminalUi(wide: boolean) {
  const [sheet, setSheet] = useState<SheetId | null>(null);
  const closeSheet = useCallback(() => setSheet(null), []);
  // карточка значений под перекрестием: на телефоне индикаторы свёрнуты, чтобы не закрывать график
  const [ohlcMore, setOhlcMore] = useState(false);
  const [bars, setBars] = useState<"shown" | "hidden">("shown");
  const [objectsPref, setObjectsPref] = useState<Shown>("shown");
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [panelTab, setPanelTab] = useState<SideTabId>("found");
  useEffect(() => {
    try {
      if (localStorage.getItem(OBJECTS_KEY) === "hidden") queueMicrotask(() => setObjectsPref("hidden"));
    } catch {
      /* приватный режим */
    }
  }, []);
  // переход через 1280 закрывает выдвинутую панель: на широком экране действует запомненное состояние
  const [wasWide, setWasWide] = useState(wide);
  if (wasWide !== wide) {
    setWasWide(wide);
    setOverlayOpen(false);
  }
  const objects: Shown = wide ? objectsPref : overlayOpen ? "shown" : "hidden";
  const setObjects = useCallback(
    (v: Shown) => {
      if (!wide) {
        setOverlayOpen(v === "shown");
        return;
      }
      setObjectsPref(v);
      try {
        localStorage.setItem(OBJECTS_KEY, v);
      } catch {
        /* приватный режим */
      }
    },
    [wide],
  );
  /** Открыть панель на вкладке (например, «Слои» из «Разметки»). */
  const showPanel = useCallback(
    (tab: SideTabId) => {
      setPanelTab(tab);
      setObjects("shown");
    },
    [setObjects],
  );

  // ширина панели объектов (десктоп): 280 – min(600, 40 % окна) px, хранится локально
  const [objW, setObjW] = useState(OBJECTS_W_DEFAULT);
  const [objDrag, setObjDrag] = useState(false);
  useEffect(() => {
    try {
      const v = Number(localStorage.getItem(OBJECTS_W_KEY));
      if (v) queueMicrotask(() => setObjW(clampW(v)));
    } catch {
      /* приватный режим */
    }
  }, []);
  const setObjWidth = useCallback((w: number) => {
    const v = clampW(w);
    setObjW(v);
    try {
      localStorage.setItem(OBJECTS_W_KEY, String(v));
    } catch {
      /* приватный режим */
    }
  }, []);
  // стабильный объект (memo): правая панель не перерисовывается из-за нового обработчика на каждом рендере
  const objResize: ObjectsResize = useMemo(
    () => ({
      active: objDrag,
      step: (delta: number) => setObjWidth(objW + delta),
      start: (e: React.PointerEvent<HTMLElement>) => {
        e.preventDefault();
        const startX = e.clientX;
        const startW = objW;
        setObjDrag(true);
        const move = (ev: PointerEvent) => setObjWidth(startW + (startX - ev.clientX));
        const up = () => {
          setObjDrag(false);
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      },
    }),
    [objDrag, objW, setObjWidth],
  );

  // тост: одна строка role=status, новая фраза заменяет прежнюю
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const say = useCallback((text: string, ms = TOAST_MS) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), ms);
  }, []);
  /** Однократное уведомление: показывается, если ключа ещё нет в localStorage (иначе — ничего). */
  const notifyOnce = useCallback(
    (key: string, text: string, ms: number) => {
      try {
        if (localStorage.getItem(key)) return;
        localStorage.setItem(key, "1");
      } catch {
        return;
      }
      queueMicrotask(() => say(text, ms));
    },
    [say],
  );
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  return { sheet, setSheet, closeSheet, ohlcMore, setOhlcMore, bars, setBars, objects, setObjects, panelOverlay: !wide, panelTab, setPanelTab, showPanel, objW, objResize, toast, say, notifyOnce };
}

export type TerminalUi = ReturnType<typeof useTerminalUi>;
