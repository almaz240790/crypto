import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import s from "./Button.module.css";

type Variant = "default" | "primary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

type Common = {
  variant?: Variant;
  size?: Size;
  block?: boolean;
  children: ReactNode;
  className?: string;
};

type AsButton = Common & ButtonHTMLAttributes<HTMLButtonElement> & { href?: undefined };
type AsLink = Common & { href: string; target?: string; rel?: string };

export type ButtonProps = AsButton | AsLink;

function cls(p: Common) {
  return [
    s.btn,
    p.variant && p.variant !== "default" ? s[p.variant] : "",
    p.size && p.size !== "md" ? s[p.size] : "",
    p.block ? s.block : "",
    p.className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function Button(props: ButtonProps) {
  if (props.href !== undefined) {
    const { href, target, rel, children } = props;
    return (
      <Link href={href} target={target} rel={rel} className={cls(props)}>
        {children}
      </Link>
    );
  }
  const { variant, size, block, className, children, type, ...rest } = props;
  void variant;
  void size;
  void block;
  void className;
  return (
    <button type={type ?? "button"} className={cls(props)} {...rest}>
      {children}
    </button>
  );
}
