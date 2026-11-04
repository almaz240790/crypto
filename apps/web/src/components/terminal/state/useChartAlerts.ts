"use client";

import type { AlertLine } from "@platform/charts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useT } from "@/i18n/client";
import { createAlert, getAlerts, type Alert } from "@/lib/alerts";

/** Ценовые алерты инструмента в терминале (план 2A.6): список, линии на графике, черновик формы, создание. */

export type AlertOp = "cross_up" | "cross_down" | "enter_range";
export type AlertFrequency = "once" | "every" | "once_per_bar";
export type AlertDraft = { price: string; op: AlertOp; price2: string; frequency: AlertFrequency };

export const EMPTY_ALERT_DRAFT: AlertDraft = { price: "", op: "cross_up", price2: "", frequency: "once" };

/** Активные ценовые алерты → линии на графике (одна ссылка, пока список не изменился). */
export function alertLinesOf(alerts: readonly Alert[]): AlertLine[] {
  return alerts
    .filter((a) => a.type === "price" && typeof a.condition.price === "string")
    .map((a) => {
      const op = a.condition.op === "cross_down" ? "cross_down" : a.condition.op === "enter_range" ? "enter_range" : "cross_up";
      const price2 = typeof a.condition.price2 === "string" ? Number(a.condition.price2) : undefined;
      return { id: a.id, price: Number(a.condition.price), op, ...(price2 !== undefined && Number.isFinite(price2) ? { price2 } : {}) };
    });
}

export function useChartAlerts({ symbol, authed, say, onCreated }: { symbol: string; authed: boolean; say: (text: string) => void; onCreated: () => void }) {
  const t = useT();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [draft, setDraft] = useState<AlertDraft>(EMPTY_ALERT_DRAFT);
  const loadAlerts = useCallback(() => {
    if (!authed) return;
    getAlerts({ symbol, status: "active" })
      .then((r) => setAlerts(r.items))
      .catch(() => {});
  }, [authed, symbol]);
  useEffect(() => {
    loadAlerts();
  }, [loadAlerts]);
  const addPriceAlert = useCallback(
    (price: string, op: AlertOp, price2?: string, drawingId?: string, frequency: AlertFrequency = "once") => {
      if (!authed) return say(t("Алерты доступны после входа"));
      createAlert({ symbol, type: "price", condition: { op, price, ...(price2 ? { price2 } : {}) }, frequency, drawing_client_id: drawingId ?? null })
        .then((a) => {
          say(t("Алерт создан: {text}", { text: a.text }));
          loadAlerts();
          onCreated();
        })
        .catch((e: Error) => say(e.message));
    },
    [authed, say, t, symbol, loadAlerts, onCreated],
  );
  /** Новый черновик формы: цена — текущая (или пусто), условие «пересечение вверх», один раз. */
  const resetDraft = useCallback((price: number | null) => setDraft({ ...EMPTY_ALERT_DRAFT, price: price == null ? "" : String(price) }), []);
  const alertLines = useMemo<AlertLine[]>(() => alertLinesOf(alerts), [alerts]);
  return { alerts, alertLines, draft, setDraft, resetDraft, addPriceAlert };
}
