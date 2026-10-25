import type { ReactNode } from "react";
import s from "./EmptyState.module.css";

/** Пустое состояние: одна строка текста и действие, без иллюстраций (план 5.5). */
export function EmptyState({ text, action }: { text: ReactNode; action?: ReactNode }) {
  return (
    <div className={s.empty}>
      <span>{text}</span>
      {action}
    </div>
  );
}
