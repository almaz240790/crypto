import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import s from "./IconButton.module.css";

type Size = "xs" | "sm" | "md";

type Common = {
  /** Доступное имя: aria-label и подсказка title (если title не задан отдельно). Обязательно. */
  label: string;
  /** Подсказка, если она длиннее имени («Снимок PNG с водяным знаком»). */
  title?: string;
  /** Нажатое состояние (переключатель): aria-pressed. */
  pressed?: boolean;
  /** xs 20, sm 28, md 32 px; под pointer: coarse — не меньше 44 px. */
  size?: Size;
  /** Иконка (svg, aria-hidden) или короткий знак. */
  children: ReactNode;
  className?: string;
};

type AsButton = Common & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "aria-pressed" | "title" | "children"> & { href?: undefined; ref?: Ref<HTMLButtonElement> };
/** Ссылка: без нажатого состояния (у ссылки нет aria-pressed). */
type AsLink = Omit<Common, "pressed"> & { href: string; prefetch?: boolean; pressed?: undefined; ref?: Ref<HTMLAnchorElement> };

export type IconButtonProps = AsButton | AsLink;

function cls(p: Common) {
  return [s.btn, p.size && p.size !== "md" ? s[p.size] : "", p.className ?? ""].filter(Boolean).join(" ");
}

/**
 * Кнопка-иконка дизайн-системы (план 2B.9): имя обязательно (aria-label и title), нажатое состояние —
 * фон --row-hover и полоса --accent снизу, недоступная — цвет --text-3 без прозрачности.
 * С href — ссылка того же вида (prefetch выключен по умолчанию).
 */
export function IconButton(props: IconButtonProps) {
  if (props.href !== undefined) {
    const { href, prefetch, label, title, children, ref } = props;
    return (
      <Link href={href} prefetch={prefetch ?? false} className={cls(props)} aria-label={label} title={title ?? label} ref={ref}>
        {children}
      </Link>
    );
  }
  const { label, title, pressed, size, className, children, type, ...rest } = props;
  void size;
  void className;
  return (
    <button type={type ?? "button"} className={cls(props)} aria-label={label} title={title ?? label} aria-pressed={pressed} {...rest}>
      {children}
    </button>
  );
}
