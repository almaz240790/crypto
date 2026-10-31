import type { Metadata } from "next";
import { AppShell } from "@/components/app/AppShell";
import { MultiChartClient } from "@/components/terminal/MultiChartClient";
import { getT } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return {
    title: t("Мультичарт"),
    description: t("2 или 4 графика на одном экране: структура рынка, зоны и уровни по нескольким инструментам сразу."),
  };
}

export default async function MultiChartRoute() {
  const t = await getT();
  return (
    <AppShell title={t("Мультичарт")} flush>
      <MultiChartClient />
    </AppShell>
  );
}
