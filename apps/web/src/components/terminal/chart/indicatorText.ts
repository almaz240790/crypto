import { formatCompactValue, formatIndicatorValue, type IndicatorValue } from "@platform/charts";
import { formatPrice } from "@/lib/format";

/**
 * Значение индикатора для легенды, заголовка панели и карточки перекрестия (план 2B.9 §10) — одно правило на всех:
 * линии на графике цены — по шагу инструмента; объём и OBV — компактно, как их шкала; остальное — formatIndicatorValue.
 */
export function indicatorText(v: IndicatorValue, tick: string | null, compact = false): string {
  if (v.value == null) return "—";
  if (v.price) return formatPrice(v.value, tick);
  return compact ? formatCompactValue(v.value) : formatIndicatorValue(v.value);
}
