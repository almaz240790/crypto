import type { ReactNode } from "react";
import s from "./Panel.module.css";

export function Panel({
  title,
  actions,
  footer,
  flush = false,
  children,
  className,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  /** Без внутренних отступов — для таблиц. */
  flush?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={[s.panel, className ?? ""].join(" ")}>
      {(title || actions) && (
        <header className={s.head}>
          <div className={s.title}>{title}</div>
          {actions && <div className={s.actions}>{actions}</div>}
        </header>
      )}
      <div className={flush ? s.flush : s.body}>{children}</div>
      {footer && <footer className={s.foot}>{footer}</footer>}
    </section>
  );
}
