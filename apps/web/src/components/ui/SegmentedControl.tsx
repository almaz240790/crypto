"use client";

import Link from "next/link";
import { useRef, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { navKey, rovingIndex } from "./keyboard";
import s from "./SegmentedControl.module.css";

export type SegmentItem<V extends string = string> = {
  value: V;
  /** Видимая подпись (текст, иконка, счётчик). */
  label: ReactNode;
  /** Доступное имя, если оно длиннее видимого текста («Найдено (3)»); видимый текст должен входить в него. */
  ariaLabel?: string;
  title?: string;
  disabled?: boolean;
  /** Режим links: адрес сегмента. Без адреса сегмент — кнопка (например, закрытый таймфрейм с popover). */
  href?: string;
  /** Дополнительные атрибуты сегмента: data-*, aria-haspopup, aria-expanded. */
  attrs?: Record<string, string | boolean | undefined>;
};

export type SegmentedControlProps<V extends string> = {
  /**
   * links — навигация ссылками (aria-current="page"), toggle — кнопки-переключатели (aria-pressed),
   * tabs — вкладки (role=tablist, стрелки ←/→, Home/End; выбор при переходе).
   */
  mode: "links" | "toggle" | "tabs";
  items: readonly SegmentItem<V>[];
  /** Активный сегмент; null — ни одного. */
  value: V | null;
  /** Выбор сегмента-кнопки (toggle, tabs и сегменты links без адреса); el — сам сегмент (якорь popover). */
  onSelect?: (value: V, el: HTMLElement) => void;
  /** Имя группы (aria-label). */
  label: string;
  /** sm 28, md 32, touch 44 px; под pointer: coarse каждый сегмент не меньше 44 × 44. */
  size?: "sm" | "md" | "touch";
  /** boxed — сегменты в рамке; underline — вкладки без рамки, активная отмечена полосой. */
  variant?: "boxed" | "underline";
  /** Сегменты равной ширины на всю ширину контейнера (ряд таймфреймов телефона). */
  stretch?: boolean;
  /** tabs: префикс id вкладок; panelId — id панели для aria-controls. */
  idBase?: string;
  panelId?: (value: V) => string;
  className?: string;
  /** Корневой элемент группы (замер ширины сегментов — вкладки правой панели сворачиваются в иконки). */
  rootRef?: Ref<HTMLDivElement>;
};

/**
 * Сегментированный переключатель дизайн-системы (план 2B.9): таймфреймы, «2 | 4» графика,
 * разделы «Найдено». Активный сегмент — фон --row-hover и полоса --accent 2 px снизу (в светлой теме
 * --surface-raised совпадает с --surface, поэтому он для выделения не годится).
 */
export function SegmentedControl<V extends string>(props: SegmentedControlProps<V>) {
  const { mode, items, value, onSelect, label, size = "md", variant = "boxed", stretch, idBase, panelId, className, rootRef } = props;
  const refs = useRef<(HTMLElement | null)[]>([]);
  const cls = [s.group, size !== "md" ? s[size] : "", variant === "underline" ? s.underline : "", stretch ? s.stretch : "", className ?? ""].filter(Boolean).join(" ");
  const activeIndex = items.findIndex((x) => x.value === value);
  // вкладки: в порядке Tab одна — активная (или первая доступная, если активной нет)
  const tabStop = activeIndex >= 0 && !items[activeIndex]!.disabled ? activeIndex : rovingIndex(-1, "first", items.length, (i) => !!items[i]!.disabled);

  const onTabKey = (e: KeyboardEvent<HTMLElement>, i: number) => {
    const nav = navKey(e.key, "horizontal");
    if (!nav) return;
    const j = rovingIndex(i, nav, items.length, (k) => !!items[k]!.disabled);
    const el = refs.current[j];
    if (j < 0 || !el) return;
    e.preventDefault();
    el.focus();
    onSelect?.(items[j]!.value, el);
  };

  const body = items.map((it, i) => {
    const active = it.value === value;
    const common = {
      className: s.seg,
      "aria-label": it.ariaLabel,
      title: it.title,
      ref: (el: HTMLElement | null) => {
        refs.current[i] = el;
      },
    };
    if (mode === "links" && it.href !== undefined) {
      return (
        <Link key={it.value} href={it.href} prefetch={false} aria-current={active ? "page" : undefined} aria-disabled={it.disabled || undefined} {...common} {...it.attrs}>
          {it.label}
        </Link>
      );
    }
    const click = (e: { currentTarget: HTMLElement }) => onSelect?.(it.value, e.currentTarget);
    if (mode === "tabs") {
      return (
        <button
          key={it.value}
          type="button"
          role="tab"
          id={idBase ? `${idBase}-tab-${it.value}` : undefined}
          aria-selected={active}
          aria-controls={panelId?.(it.value)}
          tabIndex={i === tabStop ? 0 : -1}
          disabled={it.disabled}
          onClick={click}
          onKeyDown={(e) => onTabKey(e, i)}
          {...common}
          {...it.attrs}
        >
          {it.label}
        </button>
      );
    }
    return (
      <button key={it.value} type="button" aria-pressed={mode === "toggle" ? active : undefined} disabled={it.disabled} onClick={click} {...common} {...it.attrs}>
        {it.label}
      </button>
    );
  });

  if (mode === "links") {
    return (
      <nav aria-label={label} className={cls}>
        {body}
      </nav>
    );
  }
  if (mode === "tabs") {
    return (
      <div ref={rootRef} role="tablist" aria-label={label} aria-orientation="horizontal" className={cls}>
        {body}
      </div>
    );
  }
  return (
    <div ref={rootRef} role="group" aria-label={label} className={cls}>
      {body}
    </div>
  );
}
