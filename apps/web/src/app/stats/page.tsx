import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Footer, Header } from "@/components/site";
import { StaffStats } from "@/components/stats/StaffStats";
import { loadStats, parseStatsQuery, StatsView } from "@/components/stats/StatsView";
import { getRuns, getSignalsPublic, getStatsFor, getStatsTrades, getStrategies } from "@/lib/api";
import { getT } from "@/i18n/server";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  if (!(await getSignalsPublic())) {
    // пока сигналы закрыты (ADR-0013), заголовок вкладки и описание о них не говорят
    return { title: t("Статистика"), robots: { index: false, follow: false } };
  }
  return {
    title: t("Статистика сигналов"),
    description: t("Открытая статистика торговых сигналов PlatformSol: live, форвард-тест и бэктест помечены отдельно, полная история сделок, просадки и распределение результата в R."),
  };
}

type Search = Record<string, string | string[] | undefined>;

/**
 * Статистика сигналов (план 2.11, 3.10). Пока сигналы закрыты (ADR-0013), их видят только admin и owner:
 * гостя сервер сразу уводит на открытую статистику паттернов, вошедшему страница загружает данные в браузере
 * с его токеном (StaffStats) — без прав API ответит 404, и страница уведёт туда же.
 */
export default async function StatsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const tr = await getT();
  const { scope, q, page } = parseStatsQuery(await searchParams);
  if (!(await getSignalsPublic())) {
    if ((await cookies()).get("pl_auth")?.value !== "1") redirect("/stats/patterns");
    return (
      <>
        <Header />
        <StaffStats scope={scope} q={q} page={page} />
        <Footer />
      </>
    );
  }
  const data = await loadStats(q, page, { stats: getStatsFor, strategies: getStrategies, runs: getRuns, trades: getStatsTrades });
  return (
    <>
      <Header />
      <StatsView tr={tr} scope={scope} page={page} data={data} />
      <Footer />
    </>
  );
}
