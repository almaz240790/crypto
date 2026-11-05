import type { ReactNode } from "react";
import s from "./Tooltip.module.css";

/**
 * Текстовый тултип без JS: показывается по hover и фокусу. Текст-триггер подчёркнут пунктиром («термин»);
 * с label — триггер-иконка («ⓘ»): без подчёркивания, с именем label и целью 28 × 28 (под пальцем — 44).
 */
export function Tooltip({ text, label, align = "left", children }: { text: ReactNode; label?: string; align?: "left" | "right"; children: ReactNode }) {
  return (
    <span className={s.host} tabIndex={0} data-icon={label ? "" : undefined} data-align={align === "right" ? "right" : undefined} role={label ? "img" : undefined} aria-label={label}>
      {children}
      <span role="tooltip" className={s.tip}>
        {text}
      </span>
    </span>
  );
}
