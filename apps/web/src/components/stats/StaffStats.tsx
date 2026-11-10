"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useSignalsAccess } from "@/components/auth/signalsAccess";
import { EmptyState } from "@/components/ui";
import { api } from "@/lib/auth-client";
import { statsSearch, type StatsQuery } from "@/lib/api";
import { useT } from "@/i18n/client";
import { loadStats, StatsView, type StatsData, type StatsLoaders, type StatsScope } from "./StatsView";
import s from "@/app/stats/page.module.css";

/** Ответ API или null (404, сеть): так же ведут себя серверные загрузчики lib/api. */
function quiet<T>(path: string): Promise<T | null> {
  return api<T>(path).catch(() => null);
}

const LOADERS: StatsLoaders = {
  stats: (q) => quiet(`/v1/stats?${statsSearch(q)}`),
  strategies: () => quiet<StatsData["strategies"]>("/v1/strategies").then((r) => r ?? []),
  runs: () => quiet<StatsData["runs"]>("/v1/stats/runs").then((r) => r ?? []),
  trades: (q, offset, limit) => quiet(`/v1/stats/trades?${statsSearch(q)}&offset=${offset}&limit=${limit}`),
};

/**
 * Статистика сигналов, пока сигналы закрыты (ADR-0013): данные отдаются только admin и owner, а их
 * токен есть лишь в браузере, поэтому загрузка — здесь, с токеном. Остальных (вошедших без прав)
 * уводим на открытую статистику паттернов; гостей сервер уводит туда сам.
 */
export function StaffStats({ scope, q, page }: { scope: StatsScope; q: StatsQuery; page: number }) {
  const t = useT();
  const router = useRouter();
  const { open, loading } = useSignalsAccess();
  const [loaded, setLoaded] = useState<{ key: string; data: StatsData } | null>(null);
  const key = `${statsSearch(q)}|${page}`;

  useEffect(() => {
    if (!loading && !open) router.replace("/stats/patterns");
  }, [loading, open, router]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void loadStats(q, page, LOADERS).then((data) => {
      if (alive) setLoaded({ key, data });
    });
    return () => {
      alive = false;
    };
    // q пересоздаётся на каждом рендере сервера; содержимое запроса целиком — в key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key]);

  if (!open || loaded?.key !== key) {
    return (
      <main className={`container ${s.main}`}>
        <EmptyState text={t("Загрузка…")} />
      </main>
    );
  }
  return <StatsView tr={t} scope={scope} page={page} data={loaded.data} />;
}
