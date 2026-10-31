"use client";

import type { ChartState, ChartStore, LegendEntry } from "@platform/charts";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useT } from "@/i18n/client";
import { useChartStore } from "./useChartStore";
import c from "./chart.module.css";

const selectLegend = (s: ChartState) => s.legend;

/**
 * Легенда «?» (план 2B.2, §9): кнопка в левом верхнем углу панели цены и окно «Что на графике» — по строке
 * на каждый вид разметки, который сейчас на графике (scene.legend), и две постоянные: «Цена» и «Выделение».
 * Слово и пояснение — из chartText (t()), образец — цветом тона (--chart-*). Закрывается по Esc и клику снаружи.
 */
export function LegendChip({ store }: { store: ChartStore }) {
  const legend = useChartStore(selectLegend, store);
  const t = useT();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [open]);

  return (
    <div ref={box} className={c.legendBox}>
      <button type="button" className={c.legendChip} aria-label={t("что на графике")} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}>
        ?
      </button>
      {open && (
        <div id={id} role="dialog" aria-label={t("Что на графике")} className={c.legendDialog}>
          <strong className={c.legendHead}>{t("Что на графике")}</strong>
          <ul className={c.legendList}>
            {legend.map((e) => (
              <li key={e.key} className={c.legendRow} data-key={e.key}>
                <Sample entry={e} />
                <span className={c.legendWord}>{e.text}</span>
                <span className={c.legendExplain}>{e.explain}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Образец вида: линия, пунктир, коробка, значок, тепловая полоса — цветом тона через currentColor. */
function Sample({ entry }: { entry: LegendEntry }) {
  const color = { color: `var(--chart-${entry.tone})` };
  const svg = (children: ReactNode) => (
    <svg className={c.legendSample} style={color} width="24" height="14" viewBox="0 0 24 14" aria-hidden="true">
      {children}
    </svg>
  );
  switch (entry.mark) {
    case "price":
      return svg(<rect x="2" y="2" width="20" height="10" rx="2" fill="currentColor" />);
    case "line":
      return svg(<line x1="1" y1="7" x2="23" y2="7" stroke="currentColor" strokeWidth="1.5" />);
    case "dashed":
      return svg(<line x1="1" y1="7" x2="23" y2="7" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 3" />);
    case "dotted":
      return svg(<line x1="1" y1="7" x2="23" y2="7" stroke="currentColor" strokeWidth="1.5" strokeDasharray="1 3" />);
    case "box":
      return svg(<rect x="2" y="2" width="20" height="10" fill="currentColor" fillOpacity="0.18" stroke="currentColor" strokeWidth="1" />);
    case "heat":
      return svg(
        <>
          <rect x="10" y="1" width="13" height="3" fill="currentColor" fillOpacity="0.35" />
          <rect x="4" y="5.5" width="19" height="3" fill="currentColor" fillOpacity="0.8" />
          <rect x="14" y="10" width="9" height="3" fill="currentColor" fillOpacity="0.2" />
        </>,
      );
    case "glyph":
      return svg(entry.key === "sweep" ? <circle cx="12" cy="7" r="4" fill="none" stroke="currentColor" strokeWidth="1.5" /> : <path d="M12 2 L17 11 L7 11 Z" fill="currentColor" />);
    default:
      // выделение: ореол и линия толщиной 2
      return svg(
        <>
          <line x1="1" y1="7" x2="23" y2="7" stroke="currentColor" strokeWidth="6" strokeOpacity="0.25" />
          <line x1="1" y1="7" x2="23" y2="7" stroke="currentColor" strokeWidth="2" />
        </>,
      );
  }
}
