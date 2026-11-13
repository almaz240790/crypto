"use client";

import type { ChartState, ChartStore, IndicatorValue } from "@platform/charts";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useT } from "@/i18n/client";
import { indicatorText } from "../chart/indicatorText";
import { useChartStore } from "../chart/useChartStore";
import { CROSS_FIT_MAX, CROSS_SMALL, CROSS_TIGHT, crossFitKey, crossText } from "./crossText";
import s from "../terminal.module.css";

const selectCross = (st: ChartState) => st.crosshair;

/**
 * Значения свечи под перекрестием на телефоне (план 2A.7; ADR-0009, дополнение 2026-11-13: жалоба владельца «Мешает …
 * с верху»). Не карточка поверх верхних свечей, а строка состояния над графиком: на время перекрестия — вместо цены и
 * тренда, той же высоты (её содержимое остаётся в потоке невидимым), график не сдвигается. Две строки (уже 640 px): дата
 * UTC, O, H и пометка «не закрыта»; L, C с изменением, V; шире — одна строка. Справа — «индикаторы (n)» (список значений
 * под строкой, поверх графика, только по нажатию) и «×» (убирает перекрестие). Не влезает — сжимается по шагам
 * (crossText), но не переносится. Лист: читает перекрестие из хранилища графика — оболочка при движении пальца не
 * перерисовывается; монтируется на время перекрестия (PhoneStrip), поэтому список закрывается вместе с ним.
 */
export const CrosshairStrip = memo(function CrosshairStrip({ store, tick, onClose }: { store: ChartStore; tick: string | null; onClose: () => void }) {
  const t = useT();
  const cross = useChartStore(selectCross, store);
  const [more, setMore] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const n = cross?.values.length ?? 0;
  const level = useFitLevel(ref, cross ? crossFitKey(cross.candle, tick, n) : "", !!cross);
  if (!cross) return null;
  const k = cross.candle;
  const x = crossText(k, tick, level);
  const fmtV = (v: IndicatorValue) => indicatorText(v, tick);
  return (
    <div ref={ref} className={s.cross} data-testid="ohlc" data-tight={level >= CROSS_TIGHT || undefined} data-small={level >= CROSS_SMALL || undefined} data-max={level === CROSS_FIT_MAX || undefined} data-level={level}>
      <div className={s.crossData} data-fit>
        <div className={s.crossRow} data-fit>
          <span>{x.date}</span>
          <span>
            O <strong>{x.open}</strong>
          </span>
          <span>
            H <strong>{x.high}</strong>
          </span>
          {k.open_ && (
            <span className={s.crossNote} title={t("свеча не закрыта")}>
              {level >= CROSS_TIGHT ? t("не закрыта") : t("свеча не закрыта")}
            </span>
          )}
        </div>
        <div className={s.crossRow} data-fit>
          <span>
            L <strong>{x.low}</strong>
          </span>
          <span className={x.up ? "up" : "down"}>
            C <strong>{x.close}</strong>
            {x.change !== null && ` ${x.change}`}
          </span>
          <span>
            V <strong>{x.volume}</strong>
          </span>
        </div>
      </div>
      {n > 0 && (
        <button type="button" className={s.crossMore} aria-label={t("индикаторы ({n})", { n })} aria-expanded={more} onClick={() => setMore((m) => !m)}>
          <span>{level >= CROSS_TIGHT ? t("инд.") : t("индикаторы")}</span>
          <span>({n})</span>
        </button>
      )}
      <button type="button" className={s.crossClose} aria-label={t("убрать перекрестие")} title={t("убрать перекрестие")} onClick={onClose}>
        ×
      </button>
      {more && n > 0 && (
        <div className={s.crossList} data-testid="ohlc-values">
          {cross.values.map((v) => (
            <span key={v.key}>
              <span style={{ color: v.color }}>{v.label}</span> <strong>{fmtV(v)}</strong>
            </span>
          ))}
        </div>
      )}
    </div>
  );
});

/** Текст строки шире своего места (части с data-fit обрезаются, а не переносятся). */
const overflows = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>("[data-fit]")].some((x) => x.scrollWidth > x.clientWidth + 1);

/**
 * Шаг сжатия строки (crossText): с полного вида — следующий, пока строка шире своего места (до CROSS_FIT_MAX). Замер —
 * в layout-эффекте, до отрисовки: обрезанная строка не мелькает. Заново — когда сменились длина текстов (key) или
 * ширина строки (поворот телефона); при движении пальца по свечам с той же длиной цен — ничего не меряется.
 */
function useFitLevel(ref: RefObject<HTMLElement | null>, key: string, on: boolean): number {
  const [width, setWidth] = useState(0);
  const k = `${width}|${key}`;
  const [fit, setFit] = useState({ k: "", level: 0 });
  const level = fit.k === k ? fit.level : 0;
  const step = useCallback(
    (at: number) => {
      const el = ref.current;
      if (!el) return;
      const over = at < CROSS_FIT_MAX && overflows(el);
      setFit((f) => (over ? { k, level: at + 1 } : f.k === k && f.level === at ? f : { k, level: at }));
    },
    [ref, k],
  );
  // после отрисовки нового вида (другой ключ или шаг) — замер; шире места — следующий шаг, до показа на экране
  useLayoutEffect(() => step(level), [step, level]);
  useEffect(() => {
    const el = ref.current;
    if (!on || !el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, on]);
  return level;
}
