"use client";

import type { Timeframe } from "@platform/charts";
import dynamic from "next/dynamic";

const Page = dynamic(() => import("./TerminalPage").then((m) => m.TerminalPage), { ssr: false, loading: () => <p className="text-2" style={{ padding: 16 }}>Загрузка графика…</p> });

export function TerminalClient({ symbol, tf }: { symbol: string; tf: Timeframe }) {
  return <Page symbol={symbol} tf={tf} />;
}
