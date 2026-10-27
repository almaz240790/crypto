"use client";

import dynamic from "next/dynamic";

const Page = dynamic(() => import("./MultiChart").then((m) => m.MultiChart), { ssr: false, loading: () => <p className="text-2" style={{ padding: 16 }}>Загрузка графиков…</p> });

export function MultiChartClient() {
  return <Page />;
}
