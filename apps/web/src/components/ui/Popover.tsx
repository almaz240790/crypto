"use client";

import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { placePopup, type Align } from "./placement";
import s from "./Popover.module.css";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type PopoverProps = {
  open: boolean;
  onClose: () => void;
  /** Якорь: под ним открывается окно, на него возвращается фокус после закрытия. */
  anchor: HTMLElement | null;
  /** Имя окна (aria-label): «Вид», «Сводка», «Минутные таймфреймы». */
  label: string;
  id?: string;
  /** Выравнивание по якорю: start — по левому краю, end — по правому. */
  align?: Align;
  /** Ширина окна (px или CSS-значение). */
  width?: number | string;
  /** Фокус при открытии: первый фокусируемый элемент (по умолчанию) или само окно. */
  initialFocus?: "first" | "dialog";
  className?: string;
  children: ReactNode;
};

/**
 * Поставить окно у якоря (position: fixed) — прямо в style, без лишнего рендера. max-height не сбрасывается:
 * scrollHeight (overflow: auto) и так — полная высота содержимого, а сброс обнулял бы прокрутку окна.
 */
function position(el: HTMLElement, anchor: HTMLElement, align: Align) {
  const a = anchor.getBoundingClientRect();
  const scrolled = el.scrollTop;
  const p = placePopup({ left: a.left, top: a.top, width: a.width, height: a.height }, { width: el.offsetWidth, height: el.scrollHeight }, { width: window.innerWidth, height: window.innerHeight }, { align });
  el.style.left = `${p.left}px`;
  el.style.top = `${p.top}px`;
  el.style.maxHeight = `${p.maxHeight}px`;
  el.dataset.side = p.side;
  if (el.scrollTop !== scrolled) el.scrollTop = scrolled;
}

/**
 * Следит за открытым окном: позиция при прокрутке страницы (не самого окна), ресайзе и смене размера
 * содержимого; закрытие по клику снаружи (кроме якоря — его клик сам переключает окно). Перед закрытием
 * снимается фокус с поля внутри окна: его onBlur (применить введённое) успевает, пока поле на месте.
 * Возвращает фокус на якорь при закрытии, если он оставался внутри окна (или потерялся).
 */
export function usePopupBehaviour(ref: { current: HTMLElement | null }, anchor: HTMLElement | null, open: boolean, align: Align, onClose: () => void, focusOnOpen: (el: HTMLElement) => void) {
  const closeRef = useRef(onClose);
  const focusRef = useRef(focusOnOpen);
  useLayoutEffect(() => {
    closeRef.current = onClose;
    focusRef.current = focusOnOpen;
  });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !el || !anchor) return;
    const place = () => position(el, anchor, align);
    // прокрутка внутри самого окна (колесо, Tab к нижнему полю) — не повод его переставлять
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && el.contains(e.target)) return;
      place();
    };
    place();
    focusRef.current(el);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null;
    ro?.observe(el);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", onScroll, true);
    const outside = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (el.contains(t) || anchor.contains(t))) return;
      // клик снаружи размонтирует окно раньше, чем браузер уведёт фокус: blur — сейчас, пока поле в DOM
      const active = document.activeElement;
      if (active instanceof HTMLElement && el.contains(active)) active.blur();
      closeRef.current();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("pointerdown", outside, true);
      const active = document.activeElement;
      if (!active || active === document.body || el.contains(active)) anchor.focus({ preventScroll: true });
    };
  }, [ref, anchor, open, align]);
}

/**
 * Неблокирующее всплывающее окно (план 2B.9): role="dialog" с именем, под якорем с переворотом вверх
 * и прижатием к окну, position: fixed, z-index --z-popover. Закрывается по Esc (событие дальше не
 * идёт — Esc не снимает заодно инструмент рисования), по клику снаружи и при уходе фокуса наружу.
 * Рендерится на месте (не в портале): остаётся внутри полноэкранного режима и в порядке Tab за якорем.
 */
export function Popover({ open, onClose, anchor, label, id, align = "start", width, initialFocus = "first", className, children }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const focusOnOpen = useCallback(
    (el: HTMLElement) => {
      const first = initialFocus === "first" ? el.querySelector<HTMLElement>(FOCUSABLE) : null;
      (first ?? el).focus({ preventScroll: true });
    },
    [initialFocus],
  );
  usePopupBehaviour(ref, anchor, open, align, onClose, focusOnOpen);
  if (!open) return null;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    onClose();
  };
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null;
    if (next && !e.currentTarget.contains(next) && !anchor?.contains(next)) onClose();
  };
  const style: CSSProperties = { width };
  return (
    <div ref={ref} id={id} role="dialog" aria-label={label} tabIndex={-1} className={[s.popover, className ?? ""].join(" ").trim()} style={style} onKeyDown={onKeyDown} onBlur={onBlur}>
      {children}
    </div>
  );
}

/** Состояние окна у кнопки: open, якорь и атрибуты кнопки (aria-haspopup="dialog", aria-expanded, aria-controls). */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const id = useId();
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback((el: HTMLElement) => {
    setAnchor(el);
    setOpen((o) => !o);
  }, []);
  // одна ссылка, пока окно не открылось или не закрылось: владельцы в memo не перерисовываются зря
  return useMemo(() => {
    const triggerProps = {
      "aria-haspopup": "dialog" as const,
      "aria-expanded": open,
      "aria-controls": open ? id : undefined,
      onClick: (e: MouseEvent<HTMLElement>) => toggle(e.currentTarget),
    };
    return { open, anchor, id, close, toggle, triggerProps };
  }, [open, anchor, id, close, toggle]);
}
