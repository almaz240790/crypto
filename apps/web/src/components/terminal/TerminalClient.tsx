"use client";

import type { Timeframe } from "@platform/charts";
import dynamic from "next/dynamic";
import { useT } from "@/i18n/client";

function Loading() {
  const t = useT();
  return (
    <p className="text-2" style={{ padding: 16 }}>
      {t("Загрузка графика…")}
    </p>
  );
}

const Page = dynamic(() => import("./TerminalPage").then((m) => m.TerminalPage), { ssr: false, loading: () => <Loading /> });

export function TerminalClient({ symbol, tf }: { symbol: string; tf: Timeframe }) {
  return <Page symbol={symbol} tf={tf} />;
}
