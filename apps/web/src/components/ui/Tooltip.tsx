import type { ReactNode } from "react";
import s from "./Tooltip.module.css";

/** Текстовый тултип без JS: показывается по hover и фокусу. */
export function Tooltip({ text, children }: { text: ReactNode; children: ReactNode }) {
  return (
    <span className={s.host} tabIndex={0}>
      {children}
      <span role="tooltip" className={s.tip}>
        {text}
      </span>
    </span>
  );
}
