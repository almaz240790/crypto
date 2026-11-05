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

/** small — 28 px и 13 px (шапка ячейки мультичарта); под pointer: coarse — не ниже 44 px. */
export function Select({
  label,
  hint,
  error,
  id: idProp,
  className,
  small = false,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & FieldProps & { small?: boolean }) {
  const auto = useId();
  const id = idProp ?? auto;
  return (
    <Wrap id={id} label={label} hint={hint} error={error}>
      <select
        id={id}
        className={[s.control, s.select, small ? s.small : "", className ?? ""].join(" ").trim()}
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
