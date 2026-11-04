"use client";

import { formatCompactValue, formatIndicatorValue, type ChartState, type ChartStore, type IndicatorValue } from "@platform/charts";
import { useT } from "@/i18n/client";
import { formatPrice } from "@/lib/format";
import { useChartStore } from "./useChartStore";
import s from "../terminal.module.css";

const selectCross = (st: ChartState) => st.crosshair;
const DATE = new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/**
 * Карточка перекрестия телефона (план 2A.7; вид до PR C2 прежний): дата, O/H/L/C/V, «индикаторы (n)» и ×.
 * Лист: читает перекрестие из хранилища графика — TerminalShell при движении пальца не перерисовывается.
 */
export function CrosshairCard({ store, tick, more, onMore, onClose }: { store: ChartStore; tick: string | null; more: boolean; onMore: (v: boolean) => void; onClose: () => void }) {
  const t = useT();
  const cross = useChartStore(selectCross, store);
  if (!cross) return null;
  const k = cross.candle;
  const fmtP = (v: number | null) => (v == null ? "—" : formatPrice(v, tick));
  const fmtV = (v: IndicatorValue) => (v.value == null ? "—" : v.price ? formatPrice(v.value, tick) : formatIndicatorValue(v.value));
  return (
    <div className={s.ohlc} data-testid="ohlc" data-more={more || undefined}>
      <button type="button" className={s.ohlcClose} aria-label={t("закрыть карточку")} onClick={onClose}>
        ×
      </button>
      <span>{DATE.format(new Date(k.time * 1000))} UTC</span>
      <span>
        O <strong>{fmtP(k.open)}</strong>
      </span>
      <span>
        H <strong>{fmtP(k.high)}</strong>
      </span>
      <span>
        L <strong>{fmtP(k.low)}</strong>
      </span>
      <span className={k.close >= k.open ? "up" : "down"}>
        C <strong>{fmtP(k.close)}</strong> {(((k.close - k.open) / k.open) * 100).toFixed(2)} %
      </span>
      <span>
        V <strong>{formatCompactValue(k.volume)}</strong>
      </span>
      {cross.values.length > 0 && (
        <button type="button" className={s.ohlcMore} aria-expanded={more} onClick={() => onMore(!more)}>
          {more ? t("скрыть индикаторы") : t("индикаторы ({n})", { n: cross.values.length })}
        </button>
      )}
      {cross.values.map((v) => (
        <span key={v.key} className={s.ohlcVal}>
          <span style={{ color: v.color }}>{v.label}</span> <strong>{fmtV(v)}</strong>
        </span>
      ))}
      {k.open_ && <span className="caption">{t("свеча не закрыта")}</span>}
    </div>
  );
}
