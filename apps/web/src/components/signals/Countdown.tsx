"use client";

import { useEffect, useState } from "react";

function fmt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/** Обратный отсчёт до закрытия следующей свечи H4; по нулю вызывает onZero (перезапрос ленты). */
export function Countdown({ until, onZero }: { until: string | null; onZero?: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const target = until ? new Date(until).getTime() : null;
  const left = target === null ? null : target - now;
  useEffect(() => {
    if (left !== null && left <= 0 && left > -1500) onZero?.();
  }, [left, onZero]);
  return (
    <span className="num" aria-label="до закрытия свечи H4">
      {left === null ? "—" : fmt(left)}
    </span>
  );
}
