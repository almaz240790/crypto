import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";
import s from "./Table.module.css";

export function Table({
  children,
  clickable = false,
  compact = false,
  stack = true,
  className,
  ...rest
}: HTMLAttributes<HTMLTableElement> & {
  children: ReactNode;
  clickable?: boolean;
  compact?: boolean;
  /** На узких экранах превращать строки в двухстрочный список. */
  stack?: boolean;
}) {
  const cls = [
    s.table,
    clickable ? s.clickable : "",
    compact ? s.compact : "",
    stack ? s.stack : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={s.wrap}>
      <table className={cls} {...rest}>
        {children}
      </table>
    </div>
  );
}

type MobileRole = "hidden" | "secondary" | "right";

export function Th({
  num = false,
  className,
  children,
  ...rest
}: ThHTMLAttributes<HTMLTableCellElement> & { num?: boolean }) {
  return (
    <th className={[num ? s.num : "", className ?? ""].join(" ").trim()} scope="col" {...rest}>
      {children}
    </th>
  );
}

export function Td({
  num = false,
  mobile,
  className,
  children,
  ...rest
}: TdHTMLAttributes<HTMLTableCellElement> & { num?: boolean; mobile?: MobileRole }) {
  return (
    <td
      className={[num ? s.num : "", className ?? ""].join(" ").trim()}
      data-mobile={mobile}
      {...rest}
    >
      {children}
    </td>
  );
}
