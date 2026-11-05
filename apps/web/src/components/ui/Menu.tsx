"use client";

import { useCallback, useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { navKey, rovingIndex, typeaheadIndex } from "./keyboard";
import type { Align } from "./placement";
import { usePopupBehaviour } from "./Popover";
import s from "./Menu.module.css";

export type MenuItemSpec =
  | { type?: "item"; id: string; label: string; onSelect?: () => void; disabled?: boolean; icon?: ReactNode; hint?: ReactNode }
  | { type: "radio"; id: string; label: string; checked: boolean; onSelect?: () => void; disabled?: boolean; hint?: ReactNode }
  | { type: "checkbox"; id: string; label: string; checked: boolean; onSelect?: () => void; disabled?: boolean; hint?: ReactNode }
  | { type: "separator"; id: string }
  | { type: "group"; id: string; label: string };

/** Атрибуты кнопки, открывающей меню: передаются в trigger и раскладываются на <button>. */
export type MenuTriggerProps = {
  ref: Ref<HTMLButtonElement>;
  id: string;
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
  "aria-controls": string | undefined;
  onClick: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
};

export type MenuProps = {
  /** Кнопка меню: получает атрибуты и обработчики (Button, IconButton или своя). */
  trigger: (p: MenuTriggerProps) => ReactNode;
  items: readonly MenuItemSpec[];
  /** Имя меню, если подписи кнопки мало (по умолчанию — подпись кнопки через aria-labelledby). */
  label?: string;
  align?: Align;
  minWidth?: number;
  /** Предел ширины: длинные пояснения пунктов переносятся, а не растягивают меню на пол-экрана. */
  maxWidth?: number;
  className?: string;
};

const TYPEAHEAD_MS = 500;
const focusable = (it: MenuItemSpec) => it.type !== "separator" && it.type !== "group";

/**
 * Меню дизайн-системы (план 2B.9, шаблон WAI-ARIA «menu button»): кнопка с aria-haspopup="menu",
 * пункты menuitem / menuitemradio / menuitemcheckbox. Стрелки ↑/↓ по кругу, Home/End, поиск по первым
 * буквам, Enter/Пробел — выбор, Esc — закрыть и вернуть фокус на кнопку, Tab — закрыть.
 * Недоступный пункт фокусируется, но не выбирается (aria-disabled), как рекомендует WAI-ARIA.
 */
export function Menu({ trigger, items, label, align = "start", minWidth, maxWidth, className }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  // кнопка меню — состоянием (callback ref): она же якорь окна и цель возврата фокуса
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const search = useRef({ text: "", at: 0 });
  const baseId = useId();
  const menuId = `${baseId}-menu`;
  const triggerId = `${baseId}-button`;
  const skip = useCallback((i: number) => !items[i] || !focusable(items[i]!), [items]);

  const close = useCallback(() => {
    setOpen(false);
    setActive(-1);
  }, []);
  const openAt = (nav: "first" | "last") => {
    setOpen(true);
    setActive(rovingIndex(-1, nav, items.length, skip));
  };
  const focusTrigger = () => anchor?.focus({ preventScroll: true });
  // фокус — на активный пункт (после открытия и при каждом перемещении)
  useEffect(() => {
    if (open && active >= 0) itemRefs.current[active]?.focus({ preventScroll: true });
  }, [open, active]);
  const noFocus = useCallback(() => {}, []);
  usePopupBehaviour(listRef, anchor, open, align, close, noFocus);

  const select = (it: MenuItemSpec) => {
    if (!focusable(it) || ("disabled" in it && it.disabled)) return;
    close();
    focusTrigger();
    if ("onSelect" in it) it.onSelect?.();
  };

  const onTriggerKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      openAt(e.key === "ArrowDown" ? "first" : "last");
    }
  };
  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const nav = navKey(e.key, "vertical");
    if (nav) {
      e.preventDefault();
      setActive((cur) => rovingIndex(cur, nav, items.length, skip));
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      focusTrigger();
      return;
    }
    if (e.key === "Tab") {
      close();
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== " ") {
      const now = e.timeStamp;
      const q = now - search.current.at < TYPEAHEAD_MS ? search.current.text + e.key : e.key;
      search.current = { text: q, at: now };
      const labels = items.map((it) => ("label" in it && focusable(it) ? it.label : ""));
      const j = typeaheadIndex(labels, q, q.length > 1 ? active - 1 : active, skip);
      if (j >= 0) setActive(j);
    }
  };
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null;
    if (next && !e.currentTarget.contains(next) && !anchor?.contains(next)) close();
  };

  const triggerProps: MenuTriggerProps = {
    ref: setAnchor,
    id: triggerId,
    "aria-haspopup": "menu",
    "aria-expanded": open,
    "aria-controls": open ? menuId : undefined,
    onClick: () => (open ? close() : openAt("first")),
    onKeyDown: onTriggerKey,
  };

  return (
    <>
      {trigger(triggerProps)}
      {open && (
        <div ref={listRef} id={menuId} role="menu" aria-label={label} aria-labelledby={label ? undefined : triggerId} aria-orientation="vertical" className={[s.menu, className ?? ""].join(" ").trim()} style={{ minWidth, maxWidth: maxWidth === undefined ? undefined : `min(${maxWidth}px, calc(100vw - 16px))` }} onKeyDown={onListKey} onBlur={onBlur}>
          {items.map((it, i) => {
            if (it.type === "separator") return <div key={it.id} role="separator" className={s.sep} />;
            if (it.type === "group") {
              return (
                <div key={it.id} role="presentation" className={s.group}>
                  {it.label}
                </div>
              );
            }
            const role = it.type === "radio" ? "menuitemradio" : it.type === "checkbox" ? "menuitemcheckbox" : "menuitem";
            const checked = it.type === "radio" || it.type === "checkbox" ? it.checked : undefined;
            return (
              <button
                key={it.id}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                type="button"
                role={role}
                tabIndex={i === active ? 0 : -1}
                aria-checked={checked}
                aria-disabled={it.disabled || undefined}
                className={s.item}
                onClick={() => select(it)}
                onMouseMove={() => {
                  if (active !== i) setActive(i);
                }}
              >
                <span className={s.mark} aria-hidden="true">
                  {checked === undefined ? (it.type === undefined || it.type === "item" ? it.icon : null) : checked ? (it.type === "radio" ? "●" : "✓") : ""}
                </span>
                <span className={s.text}>
                  <span>{it.label}</span>
                  {it.hint && <span className={s.hint}>{it.hint}</span>}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
