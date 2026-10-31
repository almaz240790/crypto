"use client";

import dynamic from "next/dynamic";
import { useT } from "@/i18n/client";

function Loading() {
  const t = useT();
  return (
    <p className="text-2" style={{ padding: 16 }}>
      {t("Загрузка графиков…")}
    </p>
  );
}

const Page = dynamic(() => import("./MultiChart").then((m) => m.MultiChart), { ssr: false, loading: () => <Loading /> });

export function MultiChartClient() {
  return <Page />;
}
