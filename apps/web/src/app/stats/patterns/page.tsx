import type { Metadata } from "next";
import Link from "next/link";
import { DISCLAIMER, Footer, Header } from "@/components/site";
import { EmptyState, Panel, Table, Td, Th } from "@/components/ui";
import { getFigureStats, getPatternStats, type PatternStatItem } from "@/lib/api";
import { formatTimeUTC } from "@/lib/format";
import s from "../page.module.css";
import { getT } from "@/i18n/server";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return {
    title: t("Отработка свечных паттернов"),
    description: t("Историческая отработка свечных паттернов по закрытым свечам: число случаев, доля хода ≥ 1 ATR в сторону паттерна, интервал Уилсона 95 %. Паттерны не являются сигналами."),
  };
}

const TFS = ["15m", "1h", "4h", "1d", "1w"];
const HORIZONS = [3, 5, 10];
type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? (v[0] ?? "") : (v ?? ""));

function pct(x: string | null): string {
  return x === null ? "—" : `${Math.round(Number(x) * 100)} %`;
}

async function Row({ it, tf, scope, horizon }: { it: PatternStatItem; tf: string; scope: string; horizon: number }) {
  const t = await getT();
  return (
    <tr>
      <Td>
        <Link href={`/stats/patterns?tf=${tf}&scope=${scope}&horizon=${horizon}&type=${it.type}`}>{it.title}</Link>
      </Td>
      <Td num>{it.n}</Td>
      <Td num>{it.low_n ? <span className="caption">{t("мало данных")}</span> : pct(it.success_rate)}</Td>
      <Td num>{it.low_n ? "—" : `${pct(it.ci_low)} – ${pct(it.ci_high)}`}</Td>
      <Td num>{it.low_n || !it.avg_move_atr ? "—" : Number(it.avg_move_atr).toFixed(2)}</Td>
      <Td num>{it.low_n || !it.avg_adverse_atr ? "—" : Number(it.avg_adverse_atr).toFixed(2)}</Td>
    </tr>
  );
}

export default async function PatternStatsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const t = await getT();
  const sp = await searchParams;
  const tf = TFS.includes(one(sp.tf)) ? one(sp.tf) : "4h";
  const scope = one(sp.scope) === "live" ? "live" : "backfill";
  const horizon = HORIZONS.includes(Number(one(sp.horizon))) ? Number(one(sp.horizon)) : 5;
  const type = one(sp.type) || undefined;
  const data = await getPatternStats({ tf, scope, horizon, type });
  const figures = ["4h", "1d", "1w"].includes(tf) ? await getFigureStats({ tf, scope }) : null;
  const figItems = figures?.items ?? [];
  const link = (patch: Partial<{ tf: string; scope: string; horizon: number; type: string | undefined }>) => {
    const q = { tf, scope, horizon, type, ...patch };
    const p = new URLSearchParams({ tf: q.tf, scope: q.scope, horizon: String(q.horizon) });
    if (q.type) p.set("type", q.type);
    return `/stats/patterns?${p.toString()}`;
  };
  const items = data?.items ?? [];
  const hasData = items.some((i) => i.n > 0);
  return (
    <>
      <Header />
      <main className={`container ${s.main}`}>
        <div className={s.top}>
          <div>
            <h1>{t("Отработка свечных паттернов")}</h1>
            <p className="text-2">
              Доля случаев, когда после подтверждения паттерна на закрытии свечи цена прошла ≥ 1 ATR в его сторону за {horizon} {horizon === 3 ? t("свечи") : t("свечей")}. Считается автоматически из отметок детектора, без ручного ввода. При n &lt; 30 процент не показывается. Паттерны не являются сигналами.{" "}
              <Link href="/stats">{t("Статистика сигналов")}</Link>.
            </p>
          </div>
          <nav className={s.scopes} aria-label={t("область статистики")}>
            <Link href={link({ scope: "backfill" })} aria-current={scope === "backfill" ? "true" : undefined}>{t("Историческая (бэкфилл)")}</Link>
            <Link href={link({ scope: "live" })} aria-current={scope === "live" ? "true" : undefined}>
              Live
            </Link>
          </nav>
        </div>
        <p className={s.note}>
          <strong>{scope === "backfill" ? t("Историческая (бэкфилл).") : "Live."}</strong>{" "}
          {scope === "backfill" ? t("Детектор прогнан по истории с 2022 года той же версией правил; отметки не пересчитываются задним числом.") : t("Отметки, найденные по закрытию свечей после запуска детектора; статистика копится отдельно от исторической.")}
          {data?.computed_at ? ` ${t("Обновлено {time}.", { time: formatTimeUTC(data.computed_at) })}` : ""}
        </p>
        <div className={s.filters}>
          <label>
            таймфрейм{" "}
            {TFS.map((t) => (
              <Link key={t} href={link({ tf: t })} aria-current={t === tf ? "true" : undefined} style={{ marginRight: 8, fontWeight: t === tf ? 600 : 400 }}>
                {t === "4h" ? "H4" : t.toUpperCase()}
              </Link>
            ))}
          </label>
          <label>
            горизонт{" "}
            {HORIZONS.map((h) => (
              <Link key={h} href={link({ horizon: h })} aria-current={h === horizon ? "true" : undefined} style={{ marginRight: 8, fontWeight: h === horizon ? 600 : 400 }}>
                {h} св.
              </Link>
            ))}
          </label>
          {type && <Link href={link({ type: undefined })}>{t("все типы")}</Link>}
        </div>
        {!hasData ? (
          <EmptyState text={t("Пока нет данных: статистика появится после бэкфилла детектора по истории. Для 15m и 1h история не хранится — отработка копится только live.")} />
        ) : (
          <Panel>
            <Table>
              <thead>
                <tr>
                  <Th>{t("Паттерн")}</Th>
                  <Th num>n</Th>
                  <Th num>{t("отработка")}</Th>
                  <Th num>{t("95 % интервал")}</Th>
                  <Th num>{t("ход за, ATR")}</Th>
                  <Th num>{t("ход против, ATR")}</Th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <Row key={it.type} it={it} tf={tf} scope={scope} horizon={horizon} />
                ))}
              </tbody>
            </Table>
          </Panel>
        )}
        {type && data?.by_context && (
          <Panel>
            <h2>{t("С контекстом и без")}</h2>
            <p className="caption">{t("«Значимый» — паттерн с контекстом из правил (после движения, у зоны, со sweep или объёмом). «Найден» — без контекста.")}</p>
            <Table>
              <thead>
                <tr>
                  <Th>{t("статус")}</Th>
                  <Th num>n</Th>
                  <Th num>{t("отработка")}</Th>
                  <Th num>{t("95 % интервал")}</Th>
                  <Th num>{t("ход за, ATR")}</Th>
                  <Th num>{t("ход против, ATR")}</Th>
                </tr>
              </thead>
              <tbody>
                {(["significant", "found"] as const).map((k) => {
                  const it = data.by_context?.[k];
                  return it ? <Row key={k} it={{ ...it, title: k === "significant" ? t("значимый") : t("найден") }} tf={tf} scope={scope} horizon={horizon} /> : null;
                })}
              </tbody>
            </Table>
          </Panel>
        )}
        {type && data?.by_year && data.by_year.length > 0 && (
          <Panel>
            <h2>{t("По годам")}</h2>
            <Table>
              <thead>
                <tr>
                  <Th>{t("год")}</Th>
                  <Th num>n</Th>
                  <Th num>{t("отработка")}</Th>
                  <Th num>{t("95 % интервал")}</Th>
                  <Th num>{t("ход за, ATR")}</Th>
                  <Th num>{t("ход против, ATR")}</Th>
                </tr>
              </thead>
              <tbody>
                {data.by_year.map((it) => (
                  <Row key={it.year} it={{ ...it, title: String(it.year) }} tf={tf} scope={scope} horizon={horizon} />
                ))}
              </tbody>
            </Table>
          </Panel>
        )}
        {!type && (
          <Panel>
            <h2>{t("Графические фигуры")}</h2>
            <p className="caption">
              {t("Доля подтверждённых фигур, у которых цена дошла до расчётной цели раньше инвалидации за 20 свечей. Только H4, D1 и W1. Фигуры не являются сигналами.")}
              {figures?.computed_at ? ` ${t("Обновлено {time}.", { time: formatTimeUTC(figures.computed_at) })}` : ""}
            </p>
            {!figItems.some((i) => i.n > 0) ? (
              <EmptyState text={t("Пока нет данных по фигурам: статистика появится после бэкфилла детектора.")} />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>{t("Фигура")}</Th>
                    <Th num>n</Th>
                    <Th num>{t("до цели")}</Th>
                    <Th num>{t("95 % интервал")}</Th>
                    <Th num>{t("ход за, ATR")}</Th>
                    <Th num>{t("ход против, ATR")}</Th>
                    <Th num>{t("свечей до цели")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {figItems.map((it) => (
                    <tr key={it.type} data-testid="figure-stat-row">
                      <Td>{it.title}</Td>
                      <Td num>{it.n}</Td>
                      <Td num>{it.low_n ? <span className="caption">{t("мало данных")}</span> : pct(it.success_rate)}</Td>
                      <Td num>{it.low_n ? "—" : `${pct(it.ci_low)} – ${pct(it.ci_high)}`}</Td>
                      <Td num>{it.low_n || !it.avg_move_atr ? "—" : Number(it.avg_move_atr).toFixed(2)}</Td>
                      <Td num>{it.low_n || !it.avg_adverse_atr ? "—" : Number(it.avg_adverse_atr).toFixed(2)}</Td>
                      <Td num>{it.low_n || !it.avg_bars_to_target ? "—" : Number(it.avg_bars_to_target).toFixed(1)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Panel>
        )}
        <p className="caption">{DISCLAIMER}</p>
      </main>
      <Footer />
    </>
  );
}
