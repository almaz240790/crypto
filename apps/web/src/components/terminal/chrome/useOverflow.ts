"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocale } from "@/i18n/client";
import { NO_FIT, fitByPriority, sameFit, type Fit, type ItemWidth, type ShedStep } from "./fitByPriority";

/**
 * Строка с приоритетами (план 2B.9): шапка и тулбар терминала. Контейнер — ref; его прямые дети с
 * data-overflow-item="id" — элементы строки (flex: none), остальные дети — распорки. Внутри элемента части с
 * data-ov-extra исчезают в компактном виде (иконка без подписи) — так компактная ширина считается из полной.
 *
 * Ширины замеряются один раз за ключ: при монтировании, после загрузки шрифтов (document.fonts.ready),
 * при смене языка и measureKey (счётчики, имя пресета, длина строки цены). Замер идёт в layout-эффекте
 * (все элементы в полном виде), подгонка — сразу за ним, до отрисовки, поэтому мигания нет. При ресайзе
 * ширины не перемеряются: ResizeObserver только пересчитывает подгонку. Раз в секунду ничего не меряется.
 */
export function useOverflow<E extends HTMLElement = HTMLDivElement>(shed: readonly ShedStep[], measureKey: string) {
  const ref = useRef<E>(null);
  const widths = useRef<Record<string, ItemWidth> | null>(null);
  const shedRef = useRef(shed);
  const { locale } = useLocale();
  const [fontsRev, setFontsRev] = useState(0);
  const key = `${measureKey}|${locale}|${fontsRev}`;
  const [state, setState] = useState<{ key: string; fit: Fit } | null>(null);
  const stateKey = useRef<string | null>(null);
  const measuring = state?.key !== key;

  useLayoutEffect(() => {
    shedRef.current = shed;
    stateKey.current = state?.key ?? null;
  });

  const refit = useCallback((k: string) => {
    const el = ref.current;
    if (!el || !widths.current) return;
    const f = fitByPriority(widths.current, shedRef.current, available(el), gapOf(el));
    setState((prev) => (prev && prev.key === k && sameFit(prev.fit, f) ? prev : { key: k, fit: f }));
  }, []);

  // замер: все элементы сейчас в полном виде (measuring), подгонка — до отрисовки
  useLayoutEffect(() => {
    if (!measuring || !ref.current) return;
    widths.current = measure(ref.current);
    refit(key);
  }, [measuring, key, refit]);

  // ресайз: только пересчёт подгонки по уже замеренным ширинам (во время замера — ничего)
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (stateKey.current) refit(stateKey.current);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [refit]);

  useEffect(() => {
    let alive = true;
    document.fonts?.ready.then(() => alive && setFontsRev(1));
    return () => {
      alive = false;
    };
  }, []);

  const fit = measuring || !state ? NO_FIT : state.fit;
  return { ref, fit, measuring };
}

/** Атрибуты элемента строки: id, компактный вид, спрятан. */
export function overflowItem(id: string, fit: { compact: ReadonlySet<string>; hidden: ReadonlySet<string> }) {
  return {
    "data-overflow-item": id,
    "data-compact": fit.compact.has(id) || undefined,
    "data-ov-hidden": fit.hidden.has(id) || undefined,
  };
}

const px = (v: string) => Number.parseFloat(v) || 0;
const gapOf = (el: HTMLElement) => px(getComputedStyle(el).columnGap);

/** Ширина под элементы: без внутренних отступов и промежутков у распорок (детей без data-overflow-item). */
function available(el: HTMLElement): number {
  const cs = getComputedStyle(el);
  const spacers = [...el.children].filter((c) => !(c as HTMLElement).dataset.overflowItem && getComputedStyle(c).display !== "none" && getComputedStyle(c).position !== "absolute").length;
  return el.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight) - gapOf(el) * spacers;
}

function measure(el: HTMLElement): Record<string, ItemWidth> {
  const out: Record<string, ItemWidth> = {};
  for (const child of el.children) {
    const item = child as HTMLElement;
    const id = item.dataset.overflowItem;
    if (!id) continue;
    const full = item.getBoundingClientRect().width;
    const extras = [...item.querySelectorAll<HTMLElement>("[data-ov-extra]")];
    if (!extras.length) {
      out[id] = { full };
      continue;
    }
    // у каждой исчезающей части уходит и промежуток flex-родителя рядом с ней
    const saved = extras.reduce((s, x) => s + x.getBoundingClientRect().width + (x.parentElement ? gapOf(x.parentElement) : 0), 0);
    out[id] = { full, compact: Math.max(0, full - saved) };
  }
  return out;
}
