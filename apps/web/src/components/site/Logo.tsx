import s from "./Logo.module.css";

/** Знак PlatformSol: кольцо с точкой — «солнце» (Sol) и одновременно метка цены на графике (ADR-0006). */
export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className={s.logo}>
      <svg className={s.mark} width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="10" className={s.ring} />
        <circle cx="12" cy="12" r="4.5" className={s.dot} />
      </svg>
      {!compact && <span className={s.word}>PlatformSol</span>}
    </span>
  );
}
