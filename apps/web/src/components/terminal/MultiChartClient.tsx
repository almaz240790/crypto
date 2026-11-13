"use client";

import dynamic from "next/dynamic";
import { useT } from "@/i18n/client";
import { MultiChartUpsell } from "./MultiChartUpsell";
import { useMultichartAccess } from "./state/usePlan";

function Loading({ charts = false }: { charts?: boolean }) {
  const t = useT();
  return (
    <p className="text-2" role="status" style={{ padding: 16 }}>
      {charts ? t("Загрузка графиков…") : t("Загрузка…")}
    </p>
  );
}

const Page = dynamic(() => import("./MultiChart").then((m) => m.MultiChart), { ssr: false, loading: () => <Loading charts /> });

/**
 * Мультичарт — Premium (план, раздел 4; ADR-0009, дополнение 2026-11-13). Пока доступ не известен — нейтральная
 * «Загрузка…» (ни сетки, ни замка; код графиков не грузится), без права — экран тарифа, с правом — сетка.
 */
export function MultiChartClient() {
  const { access, intradayLocked } = useMultichartAccess();
  if (access === null) return <Loading />;
  if (access !== "ok") return <MultiChartUpsell guest={access === "guest"} />;
  return <Page intradayLocked={intradayLocked} />;
}
