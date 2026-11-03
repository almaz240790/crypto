"use client";

import { formatSignedPercent, formatUsd, type ChartState, type ChartStore, type HoverSnapshot, type SceneText } from "@platform/charts";
import { useLayoutEffect, useRef } from "react";
import { useT } from "@/i18n/client";
import { chartText } from "./chartText";
import { useChartStore } from "./useChartStore";
import c from "./chart.module.css";

/** Отступ подсказки от курсора и от краёв области свечей, CSS px. */
const OFFSET = 12;
const EDGE = 4;

const selectHover = (s: ChartState) => s.hover;

/**
 * Подсказка объекта разметки (план 2B.2, §10.3): DOM-лист, читает только store.hover — график и страница
 * не перерисовываются. Мышь — у курсора (+12, +12), у правого и нижнего края разворачивается, на ценовую
 * шкалу не заходит. Палец (pointer: coarse) — тап закрепляет карточку внизу колонки графика (план 2A.7),
 * крестик или тап мимо открепляет. Цена — по шагу инструмента; строки не мельче 12 px.
 */
export function ObjectTooltip({ store, coarse }: { store: ChartStore; coarse: boolean }) {
  const hover = useChartStore(selectHover, store);
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const docked = !!hover && (hover.pinned || coarse);

  // положение — до отрисовки, по измеренному размеру: без мерцания и без лишнего состояния React
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !hover) return;
    if (docked) {
      el.style.left = "";
      el.style.top = "";
      return;
    }
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const { width, height } = hover.plot;
    let left = hover.x + OFFSET;
    if (left + w > width - EDGE) left = hover.x - OFFSET - w;
    left = Math.max(EDGE, Math.min(left, width - EDGE - w));
    let top = hover.y + OFFSET;
    if (top + h > height - EDGE) top = hover.y - OFFSET - h;
    top = Math.max(EDGE, top);
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }, [hover, docked]);

  if (!hover) return null;
  const text = chartText(t);
  const lines = rows(hover, text);
  return (
    <div ref={ref} role="tooltip" data-testid="object-tooltip" data-docked={docked || undefined} data-pinned={hover.pinned || undefined} className={c.tooltip}>
      <div className={c.tipTitle} style={{ color: `var(--chart-${hover.tone})` }}>
        {hover.info.title}
      </div>
      {hover.info.subtitle && <div className={c.tipSub}>{hover.info.subtitle}</div>}
      {hover.priceText && <div className={c.tipPrice}>{hover.priceText}</div>}
      {lines.map((l) => (
        <div key={l} className={c.tipSub}>
          {l}
        </div>
      ))}
      {hover.info.amountUsd !== undefined && (
        <div className={c.tipPrice}>
          {text.fill(text["hover.amount"], { amount: formatUsd(hover.info.amountUsd) })}
          {hover.info.estimate && <span className={c.tipTag}>{text["liq.estimate"]}</span>}
        </div>
      )}
      {hover.info.detail && <div className={c.tipSub}>{hover.info.detail}</div>}
      {hover.info.note && <div className={c.tipNote}>{hover.info.note}</div>}
      {hover.pinned && (
        <button type="button" className={c.tipClose} aria-label={t("закрыть подсказку")} onClick={() => store.select(null)}>
          ×
        </button>
      )}
    </div>
  );
}

/** Расстояние до цены и касания: «+1.24 % от цены», «цена в зоне», «касаний: 4». */
function rows(h: HoverSnapshot, text: SceneText): string[] {
  const out: string[] = [];
  if (h.distancePct !== null) {
    const inside = h.info.priceTo !== undefined && h.distancePct === 0;
    out.push(inside ? text["hover.inside"] : text.fill(text["hover.distance"], { pct: formatSignedPercent(h.distancePct, 2) }));
  }
  if (h.info.touches !== undefined) out.push(text.fill(text["hover.touches"], { n: h.info.touches }));
  return out;
}
