import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { useId } from "react";
import s from "./Field.module.css";

type FieldProps = {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
};

function Wrap({
  id,
  label,
  hint,
  error,
  children,
}: FieldProps & { id: string; children: ReactNode }) {
  return (
    <div className={s.field}>
      {label && (
        <label htmlFor={id} className={s.label}>
          {label}
        </label>
      )}
      {children}
      {error ? (
        <div className={s.error} role="alert">
          {error}
        </div>
      ) : hint ? (
        <div className={s.hint}>{hint}</div>
      ) : null}
    </div>
  );
}

export function Input({
  label,
  hint,
  error,
  mono = false,
  id: idProp,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & FieldProps & { mono?: boolean }) {
  const auto = useId();
  const id = idProp ?? auto;
  return (
    <Wrap id={id} label={label} hint={hint} error={error}>
      <input
        id={id}
        className={[s.control, mono ? s.mono : "", className ?? ""].join(" ").trim()}
        aria-invalid={error ? true : undefined}
        {...rest}
      />
    </Wrap>
  );
}

export function Select({
  label,
  hint,
  error,
  id: idProp,
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & FieldProps) {
  const auto = useId();
  const id = idProp ?? auto;
  return (
    <Wrap id={id} label={label} hint={hint} error={error}>
      <select
        id={id}
        className={[s.control, s.select, className ?? ""].join(" ").trim()}
        aria-invalid={error ? true : undefined}
        {...rest}
      >
        {children}
      </select>
    </Wrap>
  );
}

export function FieldRow({ children }: { children: ReactNode }) {
  return <div className={s.row}>{children}</div>;
}
