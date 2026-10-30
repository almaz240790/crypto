import type { Metadata } from "next";
import Link from "next/link";
import { DISCLAIMER, EquityChart, Footer, Header, RHistogram } from "@/components/site";
import { CsvButton } from "@/components/stats/CsvButton";
import { EmptyState, GradeBadge, Panel, StatusBadge, Table, Td, Th, Tooltip } from "@/components/ui";
import {
  getRuns,
  getStatsFor,
  getStatsTrades,
  getStrategies,
  statsSearch,
  type Metrics,
  type StatsQuery,
} from "@/lib/api";
import { formatDuration, formatPct, formatR, formatTimeUTC, plural } from "@/lib/format";
import s from "./page.module.css";
import { getT } from "@/i18n/server";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Статистика сигналов",
  description:
    "Открытая статистика торговых сигналов PlatformSol: live, форвард-тест и бэктест помечены отдельно, полная история сделок, просадки и распределение результата в R.",
};

const SCOPES: { key: "live" | "forward" | "backtest"; label: string; note: string }[] = [
  { key: "live", label: "Live", note: "Сигналы, опубликованные пользователям. Это единственная область, которую мы считаем результатом сервиса." },
  { key: "forward", label: "Форвард-тест", note: "Стратегия работает на живых данных без публикации сигналов. Так мы проверяем, что реальный рынок совпадает с бэктестом. Это не результат для пользователей." },
  { key: "backtest", label: "Бэктест", note: "Моделирование на истории с комиссией 0.05 % и проскальзыванием 0.03 % за сторону, без учёта funding. Исторический результат не гарантирует будущих." },
];

const METHOD: Record<string, string> = {
  closed: "Закрытые сделки: стоп, безубыток, TP3 или выход по времени. Истёкшие (вход не исполнен) считаются отдельно и в винрейт не входят.",
  winrate: "Доля закрытых сделок с результатом больше 0 R. Безубыток после TP1 даёт +0.4 R и считается выигрышем.",
  avg_r: "Сумма результатов в R, делённая на число закрытых сделок, включая убыточные и безубыточные.",
  profit_factor: "Сумма положительных R, делённая на модуль суммы отрицательных R.",
  expectancy: "Винрейт × средний выигрыш − (1 − винрейт) × средний проигрыш, в R на сделку.",
  max_drawdown_r: "Самое глубокое падение накопленного результата от пика, в R, по закрытым сделкам в хронологическом порядке.",
  max_losing_streak: "Максимальная серия убыточных сделок подряд.",
  tp1_share: "Доля сигналов, дошедших до TP1 раньше стопа.",
  avg_duration_hours: "Среднее время от входа до закрытия.",
};

function num(v: number | null | undefined, f: (n: number) => string): string {
  return v === null || v === undefined ? "—" : f(v);
}

function pct(v: number | null | undefined): string {
  return num(v, (n) => formatPct(n * 100, { signed: false }));
}

async function MetricCards({ m }: { m: Metrics }) {
  const tr = await getT();
  const cards: [string, string, string, string?][] = [
    ["closed", tr("закрытых сделок"), String(m.closed), `${m.open} ${plural(m.open, tr("активная"), tr("активные"), tr("активных"))}, ${m.expired} ${plural(m.expired, tr("истёк"), tr("истекли"), tr("истекли"))}`],
    ["winrate", tr("винрейт"), pct(m.winrate)],
    ["avg_r", tr("средний R"), num(m.avg_r, (n) => formatR(n))],
    ["profit_factor", tr("профит-фактор"), num(m.profit_factor, (n) => n.toFixed(2))],
    ["expectancy", "expectancy", num(m.expectancy, (n) => formatR(n))],
    ["max_drawdown_r", tr("макс. просадка"), m.closed ? formatR(-m.max_drawdown_r) : "—", m.closed ? `≈ ${(m.max_drawdown_r * 1).toFixed(1)} % при риске 1 %` : undefined],
    ["max_losing_streak", tr("серия убытков"), String(m.max_losing_streak)],
    ["tp1_share", tr("дошли до TP1"), pct(m.tp1_share), `TP2 ${pct(m.tp2_share)}, TP3 ${pct(m.tp3_share)}`],
    ["avg_duration_hours", tr("в сделке"), num(m.avg_duration_hours, (n) => formatDuration(n))],
  ];
  return (
    <div className={s.cards}>
      {cards.map(([k, label, value, sub]) => (
        <dl key={k} className={s.card}>
          <dt>
            <span>{label}</span>
            <Tooltip text={METHOD[k]}>?</Tooltip>
          </dt>
          <dd>
            {value}
            {sub && (
              <>
                <br />
                <small>{sub}</small>
              </>
            )}
          </dd>
        </dl>
      ))}
    </div>
  );
}

async function BreakdownTable({ title, rows, keyLabel }: { title: string; rows: [string, Metrics][]; keyLabel: string }) {
  const tr = await getT();
  return (
    <Panel title={title} flush>
      {rows.length === 0 ? (
        <EmptyState text={tr("Нет закрытых сделок.")} />
      ) : (
        <Table compact stack={false}>
          <thead>
            <tr>
              <Th>{keyLabel}</Th>
              <Th num>{tr("Сделок")}</Th>
              <Th num>{tr("Винрейт")}</Th>
              <Th num>{tr("Средний R")}</Th>
              <Th num>{tr("Итог, R")}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <Td>{k}</Td>
                <Td num>{v.closed}</Td>
                <Td num>{pct(v.winrate)}</Td>
                <Td num>{num(v.avg_r, (n) => formatR(n))}</Td>
                <Td num className={v.sum_r > 0 ? "up" : v.sum_r < 0 ? "down" : ""}>
                  {formatR(v.sum_r)}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}

type Search = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

export default async function StatsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const tr = await getT();
  const sp = await searchParams;
  const scopeRaw = one(sp.scope);
  const scope = scopeRaw === "forward" || scopeRaw === "backtest" ? scopeRaw : "live";
  const q: StatsQuery = {
    scope,
    version: one(sp.version) || undefined,
    run_id: one(sp.run_id) || undefined,
    symbol: one(sp.symbol).toUpperCase() || undefined,
    grade: one(sp.grade).toUpperCase() || undefined,
    entry_type: one(sp.entry_type) || undefined,
    days: one(sp.days) || undefined,
  };
  const page = Math.max(0, Number(one(sp.page)) || 0);
  const PAGE = 50;
  const [stats, strategies, runs, trades] = await Promise.all([
    getStatsFor(q),
    getStrategies(),
    scope === "backtest" ? getRuns() : Promise.resolve([]),
    scope === "forward" ? Promise.resolve(null) : getStatsTrades(q, page * PAGE, PAGE),
  ]);
  const query = statsSearch(q);
  const m = stats?.metrics;
  const has = !!m && (m.closed > 0 || m.open > 0 || m.expired > 0);
  const months = stats ? Object.entries(stats.by_month).sort(([a], [b]) => (a < b ? 1 : -1)) : [];
  const symbols = stats ? Object.entries(stats.by_symbol).sort(([, a], [, b]) => b.closed - a.closed) : [];
  const grades = stats ? Object.entries(stats.by_grade).sort(([a], [b]) => a.localeCompare(b)) : [];
  const entries = stats ? Object.entries(stats.by_entry_type) : [];
  const scopeInfo = SCOPES.find((x) => x.key === scope)!;
  const link = (patch: Partial<StatsQuery> & { page?: number }) => {
    const { page: pg, ...rest } = patch;
    const next = { ...q, ...rest };
    const str = statsSearch(next);
    return `/stats?${str}${pg ? `&page=${pg}` : ""}`;
  };
  const pages = trades ? Math.ceil(trades.total / PAGE) : 0;
  const versionOptions = strategies.filter((v) => (scope === "backtest" ? true : v.status === scope));

  return (
    <>
      <Header />
      <main className={`container ${s.main}`}>
        <div className={s.top}>
          <div>
            <h1>{tr("Статистика сигналов")}</h1>
            <p className="text-2">
              Считается автоматически из таблицы сигналов тем же кодом, что бэктест. Ручного ввода нет. Обновлено {stats ? formatTimeUTC(stats.generated_at) : "—"}.
            </p>
          </div>
          <nav className={s.scopes} aria-label={tr("область статистики")}>
            {SCOPES.map((x) => (
              <Link key={x.key} href={link({ scope: x.key, version: undefined, run_id: undefined, entry_type: undefined })} aria-current={scope === x.key ? "true" : undefined}>
                {x.label}
              </Link>
            ))}
            <Link href="/stats/patterns">{tr("Паттерны")}</Link>
          </nav>
        </div>

        <p className={s.note}>
          <strong>{scopeInfo.label}.</strong> {scopeInfo.note}
          {scope === "backtest" && stats?.run && (
            <>
              {" "}
              Прогон #{stats.run.id}: стратегия {stats.run.strategy_version}, период {stats.run.period[0]} — {stats.run.period[1]}, инструментов {stats.run.instruments}, вход {stats.run.entry_type === "limit" ? tr("лимитный") : tr("рыночный")}.
              {stats.run.note ? ` ${stats.run.note}` : ""}
            </>
          )}
        </p>

        <form className={s.filters} method="get" action="/stats">
          <input type="hidden" name="scope" value={scope} />
          {scope === "backtest" ? (
            <label>{tr("прогон")}<select name="run_id" defaultValue={q.run_id ?? ""}>
                <option value="">{tr("последний")}</option>
                {runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    #{r.id} {r.strategy_version} {r.period[0]}…{r.period[1]} {r.entry_type}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label>{tr("версия стратегии")}<select name="version" defaultValue={q.version ?? ""}>
                <option value="">{tr("все")}</option>
                {versionOptions.map((v) => (
                  <option key={v.id} value={v.version}>
                    {v.name} {v.version}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>{tr("период")}<select name="days" defaultValue={q.days ?? ""}>
              <option value="">{tr("весь")}</option>
              <option value="30">{tr("30 дней")}</option>
              <option value="90">{tr("90 дней")}</option>
              <option value="180">{tr("180 дней")}</option>
              <option value="365">{tr("год")}</option>
            </select>
          </label>
          <label>{tr("инструмент")}<input name="symbol" defaultValue={q.symbol ?? ""} placeholder={tr("все")} style={{ textTransform: "uppercase" }} />
          </label>
          <label>{tr("градация")}<select name="grade" defaultValue={q.grade ?? ""}>
              <option value="">{tr("все")}</option>
              <option value="A">A</option>
              <option value="B">B</option>
              <option value="C">C</option>
            </select>
          </label>
          <label>{tr("тип входа")}<select name="entry_type" defaultValue={q.entry_type ?? ""}>
              <option value="">{tr("оба")}</option>
              <option value="market">{tr("рыночный")}</option>
              <option value="limit">{tr("лимитный")}</option>
            </select>
          </label>
          <button type="submit" className="caption" style={{ height: 32, padding: "0 12px", border: "1px solid var(--border)", borderRadius: "var(--radius)", background: "var(--surface)", color: "var(--text)", cursor: "pointer" }}>{tr("Применить")}</button>
          {query !== `scope=${scope}` && (
            <Link href={`/stats?scope=${scope}`} className="caption">{tr("сбросить")}</Link>
          )}
        </form>

        {!stats ? (
          <Panel>
            <EmptyState text={tr("API недоступен, попробуйте позже.")} />
          </Panel>
        ) : !has ? (
          <Panel>
            <EmptyState
              text={
                scope === "live"
                  ? tr("Live-сигналов пока нет: текущая версия стратегии проходит форвард-тест. Переключите область на «Форвард-тест» или «Бэктест».")
                  : scope === "backtest" && !stats.run
                    ? tr("Сохранённых прогонов бэктеста нет.")
                    : tr("По этим фильтрам сделок нет.")
              }
            />
          </Panel>
        ) : (
          <>
            <MetricCards m={m!} />

            <div className={s.two}>
              <Panel title={tr("Накопленный результат, R")} actions={<span>{m!.closed} {plural(m!.closed, tr("сделка"), tr("сделки"), tr("сделок"))}, итог {formatR(m!.sum_r)}</span>}>
                {stats.equity.length > 1 ? <EquityChart points={stats.equity} /> : <EmptyState text={tr("Мало сделок для кривой.")} />}
              </Panel>
              <Panel title={tr("Худшие периоды")} footer={tr("Три самые глубокие просадки — чтобы вы видели не только итог.")} flush>
                {stats.worst_drawdowns.length === 0 ? (
                  <EmptyState text={tr("Просадок нет.")} />
                ) : (
                  <Table compact stack={false}>
                    <thead>
                      <tr>
                        <Th>{tr("Пик")}</Th>
                        <Th>{tr("Дно")}</Th>
                        <Th num>{tr("Глубина")}</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.worst_drawdowns.map((d) => (
                        <tr key={d.start + d.trough}>
                          <Td>{formatTimeUTC(d.start, { withYear: true })}</Td>
                          <Td>{formatTimeUTC(d.trough, { withYear: true })}</Td>
                          <Td num className="down">
                            {formatR(-d.depth_r)}
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </Panel>
            </div>

            <div className={s.two}>
              <Panel title={tr("Распределение результата, R")} footer={tr("Сколько закрытых сделок попало в каждый диапазон R.")}>
                <RHistogram bins={stats.r_histogram} />
              </Panel>
              <BreakdownTable title={tr("По типу входа")} keyLabel={tr("Вход")} rows={entries.map(([k, v]) => [k === "limit" ? tr("лимитный") : tr("рыночный"), v])} />
            </div>

            <div className={s.three}>
              <BreakdownTable title={tr("По месяцам")} keyLabel={tr("Месяц")} rows={months} />
              <BreakdownTable title={tr("По градации")} keyLabel={tr("Градация")} rows={grades} />
              <BreakdownTable title={tr("По инструментам")} keyLabel={tr("Инструмент")} rows={symbols} />
            </div>

            <Panel
              title={trades ? `${tr("История")}: ${trades.total} ${plural(trades.total, tr("сигнал"), tr("сигнала"), tr("сигналов"))}` : tr("История")}
              actions={scope === "forward" ? <span>{tr("построчная история форварда не публикуется")}</span> : <CsvButton query={query} />}
              flush
            >
              {!trades ? (
                <EmptyState text={tr("Для форвард-теста публикуются только агрегаты.")} />
              ) : trades.items.length === 0 ? (
                <EmptyState text={tr("Сделок нет.")} />
              ) : (
                <>
                  <Table compact>
                    <thead>
                      <tr>
                        <Th>{tr("Время, UTC")}</Th>
                        <Th>{tr("Инструмент")}</Th>
                        <Th>{tr("Гр.")}</Th>
                        <Th num>{tr("Вход")}</Th>
                        <Th num>{tr("Стоп")}</Th>
                        <Th num>R:R</Th>
                        <Th>{tr("Тип")}</Th>
                        <Th>{tr("Статус")}</Th>
                        <Th num>TP</Th>
                        <Th num>{tr("Результат")}</Th>
                        <Th num>MFE / MAE</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {trades.items.map((t, i) => (
                        <tr key={`${t.id}-${t.signal_time}-${i}`}>
                          <Td mobile="secondary" className="text-2">
                            {formatTimeUTC(t.signal_time, { withYear: true })}
                          </Td>
                          <Td>
                            {t.id && scope === "live" ? <Link href={`/signals/${t.id}`}>{t.symbol}</Link> : <strong>{t.symbol}</strong>}{" "}
                            <span className={t.direction === "long" ? "up" : "down"}>{t.direction}</span>
                          </Td>
                          <Td mobile="hidden">
                            <GradeBadge grade={t.grade} /> <span className="caption">{t.score}</span>
                          </Td>
                          <Td num mobile="hidden">
                            {t.entry}
                          </Td>
                          <Td num mobile="hidden">
                            {t.stop}
                          </Td>
                          <Td num mobile="hidden">
                            {Number(t.rr_tp2).toFixed(2)}
                          </Td>
                          <Td mobile="hidden">{t.entry_type === "limit" ? tr("лимит") : tr("рынок")}</Td>
                          <Td mobile="secondary">
                            <StatusBadge status={t.status} />
                          </Td>
                          <Td num mobile="hidden">
                            {t.tp_hits}
                          </Td>
                          <Td num mobile="right" className={t.realized_r == null ? "" : t.realized_r > 0 ? "up" : t.realized_r < 0 ? "down" : ""}>
                            {t.realized_r == null ? "—" : formatR(t.realized_r)}
                          </Td>
                          <Td num mobile="hidden" className="text-2">
                            {t.mfe_r.toFixed(2)} / {t.mae_r.toFixed(2)}
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                  {pages > 1 && (
                    <div className={s.pager}>
                      <span>
                        страница {page + 1} из {pages}
                      </span>
                      <span style={{ display: "inline-flex", gap: 12 }}>
                        {page > 0 && <Link href={link({ page: page - 1 })}>{tr("← назад")}</Link>}
                        {page + 1 < pages && <Link href={link({ page: page + 1 })}>{tr("вперёд →")}</Link>}
                      </span>
                    </div>
                  )}
                </>
              )}
            </Panel>
          </>
        )}
        <p className="caption" style={{ maxWidth: "80ch" }}>
          {DISCLAIMER} Сигнал нельзя удалить или изменить после публикации; истёкшие сигналы показаны отдельно и не входят в винрейт; бэктест, форвард и live не смешиваются.
        </p>
      </main>
      <Footer />
    </>
  );
}
