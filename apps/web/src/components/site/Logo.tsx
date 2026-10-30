import s from "./Logo.module.css";

/** Знак и надпись PlatformSol: квадрат с восходящей линией и солнцем, «Sol» фирменным цветом. */
export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className={s.logo}>
      <svg className={s.mark} width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
        <rect width="26" height="26" rx="7" className={s.markBg} />
        <circle cx="18.5" cy="8" r="3" className={s.sun} />
        <path d="M5 19.5 9.5 14l3.5 3 6-7.5" className={s.line} />
      </svg>
      {!compact && (
        <span className={s.word}>
          Platform<span className={s.sol}>Sol</span>
        </span>
      )}
    </span>
  );
}
