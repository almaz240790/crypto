"use client";

import type { ChartState, ChartStore, IndicatorValue } from "@platform/charts";
import { memo, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useT } from "@/i18n/client";
import { indicatorText } from "../chart/indicatorText";
import { useChartStore } from "../chart/useChartStore";
import { CROSS_FULL, CROSS_SMALL, CROSS_TIGHT, CROSS_TINY, crossFitKey, crossText, nextCrossFit, type CrossFit, type CrossPart } from "./crossText";
import s from "../terminal.module.css";

const selectCross = (st: ChartState) => st.crosshair;

/**
 * Значения свечи под перекрестием на телефоне (план 2A.7; ADR-0009, дополнение 2026-11-13: жалоба владельца «Мешает …
 * с верху»). Не карточка поверх верхних свечей, а строка состояния над графиком: на время перекрестия — вместо цены и
 * тренда, той же высоты (её содержимое остаётся в потоке невидимым), график не сдвигается. Две строки (уже 640 px): дата
 * UTC, O, H и пометка «не закрыта»; L, C с изменением, V; шире — одна строка. Справа — «индикаторы (n)» (список значений
 * под строкой, поверх графика, только по нажатию) и «×» (убирает перекрестие). Не влезает — сжимается по шагам
 * (crossText: общие шаги, потом уступают части той строки, что не влезла), но не переносится и не обрезается: цены
 * и время видны всегда, пометка «не закрыта» — словами или точкой. Лист: читает перекрестие из хранилища графика —
 * оболочка при движении пальца не перерисовывается; монтируется на время перекрестия (PhoneStrip), поэтому список
 * закрывается вместе с ним.
 */
export const CrosshairStrip = memo(function CrosshairStrip({ store, tick, onClose }: { store: ChartStore; tick: string | null; onClose: () => void }) {
  const t = useT();
  const cross = useChartStore(selectCross, store);
  const [more, setMore] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const n = cross?.values.length ?? 0;
  const fit = useCrossFit(ref, cross ? crossFitKey(cross.candle, tick, n) : "", !!cross);
  if (!cross) return null;
  const { level } = fit;
  const x = crossText(cross.candle, tick, fit);
  const fmtV = (v: IndicatorValue) => indicatorText(v, tick);
  const noteTitle = t("свеча не закрыта");
  return (
    <div
      ref={ref}
      className={s.cross}
      data-testid="ohlc"
      data-tight={level >= CROSS_TIGHT || undefined}
      data-small={level >= CROSS_SMALL || undefined}
      data-tiny={level >= CROSS_TINY || undefined}
      data-level={level}
      data-shed={fit.shed.join(" ") || undefined}
    >
      <div className={s.crossData} data-fit>
        <div className={s.crossRow} data-fit>
          <span>{x.date}</span>
          <span>
            O <strong>{x.open}</strong>
          </span>
          <span>
            H <strong>{x.high}</strong>
          </span>
          {x.note === "dot" ? (
            <span className={s.crossNote} data-part="note" data-dot role="img" aria-label={noteTitle} title={noteTitle} />
          ) : (
            x.note && (
              <span className={s.crossNote} data-part="note" title={noteTitle}>
                {x.note === "full" ? noteTitle : x.note === "tight" ? t("не закрыта") : t("не закр.")}
              </span>
            )
          )}
        </div>
        <div className={s.crossRow} data-fit>
          <span>
            L <strong>{x.low}</strong>
          </span>
          <span className={x.up ? "up" : "down"}>
            C <strong>{x.close}</strong>
            {x.change !== null && <span data-part="change"> {x.change}</span>}
          </span>
          {x.volume !== null && (
            <span data-part="volume">
              V <strong>{x.volume}</strong>
            </span>
          )}
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

/** Содержимое шире своего места (строки значений с data-fit обрезаются, а не переносятся); без допуска в пиксель. */
const wider = (x: Element) => x.scrollWidth > x.clientWidth;

/** Переполнена хоть одна строка значений, а с part — та, где лежит часть (нет части — false). */
function overflowOf(el: HTMLElement): (part?: CrossPart) => boolean {
  const rows = [...el.querySelectorAll("[data-fit]")].filter(wider);
  return (part) => {
    if (!part) return rows.length > 0;
    const x = el.querySelector(`[data-part="${part}"]`);
    return !!x && rows.some((r) => r.contains(x));
  };
}

/**
 * Вид строки (crossText, nextCrossFit): с полного — следующий шаг, пока строка шире своего места и есть чем сжать.
 * Замер — в layout-эффекте, до отрисовки: обрезанная строка не мелькает. Заново — когда сменились длина текстов (key),
 * ширина строки (поворот телефона) или догрузился шрифт (до загрузки знаки другой ширины); при движении пальца по
 * свечам с той же длиной цен — ничего не меряется.
 */
function useCrossFit(ref: RefObject<HTMLElement | null>, key: string, on: boolean): CrossFit {
  const [width, setWidth] = useState(0);
  const [fonts, setFonts] = useState(0);
  const k = `${width}|${fonts}|${key}`;
  const [state, setState] = useState<{ k: string; fit: CrossFit }>({ k: "", fit: CROSS_FULL });
  const fit = state.k === k ? state.fit : CROSS_FULL;
  // после отрисовки нового вида (другой ключ или шаг) — замер; шире места — следующий шаг, до показа на экране
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const next = nextCrossFit(fit, overflowOf(el));
    setState((s) => (next ? { k, fit: next } : s.k === k && s.fit === fit ? s : { k, fit }));
  }, [ref, k, fit]);
  useEffect(() => {
    const el = ref.current;
    if (!on || !el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, on]);
  useEffect(() => {
    const set = typeof document === "undefined" ? undefined : document.fonts;
    if (!on || !set) return;
    const done = () => setFonts((v) => v + 1);
    set.addEventListener("loadingdone", done);
    return () => set.removeEventListener("loadingdone", done);
  }, [on]);
  return fit;
}
