"use client";

import { MAX_CANDLES, type ChartStore } from "@platform/charts";
import { useT } from "@/i18n/client";
import { formatPrice } from "@/lib/format";
import { useChartStore } from "./useChartStore";
import c from "./chart.module.css";

/**
 * Левый край истории (план 2A.7; ADR-0003, дополнение от 2026-11-12): пока идёт порция слева — «Загрузка истории…» с
 * индикатором, а когда у левого края подгрузку остановил лимит буфера (5 000 свечей в памяти) при истории на сервере —
 * «История ограничена 5 000 свечами»: без пометки казалось, что истории дальше нет. Стоит у левого края основной панели
 * по середине её высоты (h — высота панели цены), клики не перехватывает.
 */
export function HistoryEdgeNote({ store, h }: { store: ChartStore; h: number }) {
  const edge = useChartStore((st) => st.status.historyEdge, store);
  const t = useT();
  if (!edge || h <= 0) return null;
  return (
    <p className={c.historyEdge} style={{ top: h / 2 }} role="status" data-testid="chart-history-edge" data-edge={edge}>
      {edge === "loading" && <span className={c.historySpinner} aria-hidden="true" />}
      {edge === "loading" ? t("Загрузка истории…") : t("История ограничена {n} свечами", { n: formatPrice(MAX_CANDLES, "1") })}
    </p>
  );
}
