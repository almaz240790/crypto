"use client";

import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Состояние интерфейса терминала (план 2B.9): открытый лист, панели, ширина панели объектов, тост.
 * Ничего не знает о данных графика и настройках; TerminalShell раздаёт его компонентам.
 */

export type SheetId = "indicators" | "layers" | "draw" | "found" | "alert" | "ask";

const OBJECTS_W_KEY = "pl-objects-w";
export const OBJECTS_W_DEFAULT = 300;
const OBJECTS_W_MIN = 240;
const OBJECTS_W_MAX = 600;
const clampW = (w: number) => Math.round(Math.min(OBJECTS_W_MAX, Math.max(OBJECTS_W_MIN, w)));

export const TOAST_MS = 2500;

export type ObjectsResize = {
  active: boolean;
  step: (delta: number) => void;
  start: (e: React.PointerEvent<HTMLElement>) => void;
};

export function useTerminalUi() {
  const [sheet, setSheet] = useState<SheetId | null>(null);
  const closeSheet = useCallback(() => setSheet(null), []);
  // карточка значений под перекрестием: на телефоне индикаторы свёрнуты, чтобы не закрывать график
  const [ohlcMore, setOhlcMore] = useState(false);
  const [bars, setBars] = useState<"shown" | "hidden">("shown");
  const [objects, setObjects] = useState<"shown" | "hidden">("shown");

  // ширина панели объектов (десктоп): 240–600 px, хранится локально
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
  const objResize: ObjectsResize = {
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
  };

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

  return { sheet, setSheet, closeSheet, ohlcMore, setOhlcMore, bars, setBars, objects, setObjects, objW, objResize, toast, say, notifyOnce };
}

export type TerminalUi = ReturnType<typeof useTerminalUi>;
