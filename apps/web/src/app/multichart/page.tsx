import type { Metadata } from "next";
import { AppShell } from "@/components/app/AppShell";
import { MultiChartClient } from "@/components/terminal/MultiChartClient";

export const metadata: Metadata = { title: "Мультичарт", description: "2 или 4 графика на одном экране: структура рынка, зоны, сигналы по нескольким инструментам сразу." };

export default function MultiChartRoute() {
  return (
    <AppShell title="Мультичарт" flush>
      <MultiChartClient />
    </AppShell>
  );
}
