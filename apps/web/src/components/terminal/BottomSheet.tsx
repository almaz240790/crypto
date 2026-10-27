"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import s from "./terminal.module.css";

/**
 * Нижний лист (план 2A.7): высота 50 % экрана, тянется за «ручку» до 90 %, закрывается свайпом вниз.
 * Внутри — списки и формы с полями 44 px, без вложенных модалок.
 */
export function BottomSheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const [pct, setPct] = useState(50);
  const pctRef = useRef(50);
  const drag = useRef<{ y: number; start: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onDown = (e: React.PointerEvent) => {
    drag.current = { y: e.clientY, start: pct };
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* синтетические события без активного указателя */
    }
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const h = ref.current?.parentElement?.clientHeight ?? window.innerHeight;
    const next = Math.max(15, Math.min(90, drag.current.start - ((e.clientY - drag.current.y) / h) * 100));
    pctRef.current = next;
    setPct(next);
  };
  const onUp = () => {
    if (!drag.current) return;
    drag.current = null;
    // move и up могут прийти в одном такте — берём последнее значение из ref, не из замыкания
    const cur = pctRef.current;
    if (cur < 30) onClose();
    else {
      pctRef.current = cur > 70 ? 90 : 50;
      setPct(pctRef.current);
    }
  };

  return (
    <div ref={ref} className={s.sheet} role="dialog" aria-label={title} style={{ height: `${pct}%` }} data-height={pct}>
      <div className={s.handle} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} aria-label="ручка листа" role="separator" aria-orientation="horizontal" />
      <div className={s.sheetHead}>
        <strong>{title}</strong>
        <button type="button" className={s.chip} onClick={onClose}>
          Готово
        </button>
      </div>
      <div className={s.sheetBody}>{children}</div>
    </div>
  );
}
