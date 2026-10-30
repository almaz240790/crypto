"use client";

import { Children, useEffect, useRef, useState, type ReactNode } from "react";

/** Список блока «доверие»: на телефоне — листалка с точками (стили — в page.module.css), на компьютере — сетка 2×2. */
export function TrustCarousel({ children, dotsClassName, labelledBy }: { children: ReactNode; dotsClassName: string; labelledBy: string }) {
  const ref = useRef<HTMLUListElement>(null);
  const [active, setActive] = useState(0);
  // в фокус по Tab — только когда список листается (телефон), а не сетка 2×2
  const [scrollable, setScrollable] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setScrollable(el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const count = Children.count(children);
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setActive(max > 0 ? Math.round((el.scrollLeft / max) * (count - 1)) : 0);
  };
  return (
    <>
      <ul ref={ref} onScroll={onScroll} tabIndex={scrollable ? 0 : undefined} aria-labelledby={labelledBy}>
        {children}
      </ul>
      <div className={dotsClassName} aria-hidden="true">
        {Array.from({ length: count }, (_, i) => (
          <i key={i} data-active={i === active || undefined} />
        ))}
      </div>
    </>
  );
}
