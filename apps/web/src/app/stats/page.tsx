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

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Статистика сигналов",
  description:
    "Открытая статистика торговых сигналов Platform: live, форвард-тест и бэктест помечены отдельно, полная история сделок, просадки и распределение результата в R.",
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

function MetricCards({ m }: { m: Metrics }) {
  const cards: [string, string, string, string?][] = [
    ["closed", "закрытых сделок", String(m.closed), `${m.open} ${plural(m.open, "активная", "активные", "активных")}, ${m.expired} ${plural(m.expired, "истёк", "истекли", "истекли")}`],
    ["winrate", "винрейт", pct(m.winrate)],
    ["avg_r", "средний R", num(m.avg_r, (n) => formatR(n))],
    ["profit_factor", "профит-фактор", num(m.profit_factor, (n) => n.toFixed(2))],
    ["expectancy", "expectancy", num(m.expectancy, (n) => formatR(n))],
    ["max_drawdown_r", "макс. просадка", m.closed ? formatR(-m.max_drawdown_r) : "—", m.closed ? `≈ ${(m.max_drawdown_r * 1).toFixed(1)} % при риске 1 %` : undefined],
    ["max_losing_streak", "серия убытков", String(m.max_losing_streak)],
    ["tp1_share", "дошли до TP1", pct(m.tp1_share), `TP2 ${pct(m.tp2_share)}, TP3 ${pct(m.tp3_share)}`],
    ["avg_duration_hours", "в сделке", num(m.avg_duration_hours, (n) => formatDuration(n))],
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

function BreakdownTable({ title, rows, keyLabel }: { title: string; rows: [string, Metrics][]; keyLabel: string }) {
  return (
    <Panel title={title} flush>
      {rows.length === 0 ? (
        <EmptyState text="Нет закрытых сделок." />
      ) : (
        <Table compact stack={false}>
          <thead>
            <tr>
              <Th>{keyLabel}</Th>
              <Th num>Сделок</Th>
              <Th num>Винрейт</Th>
              <Th num>Средний R</Th>
              <Th num>Итог, R</Th>
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
            <h1>Статистика сигналов</h1>
            <p className="text-2">
              Считается автоматически из таблицы сигналов тем же кодом, что бэктест. Ручного ввода нет. Обновлено {stats ? formatTimeUTC(stats.generated_at) : "—"}.
            </p>
          </div>
          <nav className={s.scopes} aria-label="область статистики">
            {SCOPES.map((x) => (
              <Link key={x.key} href={link({ scope: x.key, version: undefined, run_id: undefined, entry_type: undefined })} aria-current={scope === x.key ? "true" : undefined}>
                {x.label}
              </Link>
            ))}
          </nav>
        </div>

        <p className={s.note}>
          <strong>{scopeInfo.label}.</strong> {scopeInfo.note}
          {scope === "backtest" && stats?.run && (
            <>
              {" "}
              Прогон #{stats.run.id}: стратегия {stats.run.strategy_version}, период {stats.run.period[0]} — {stats.run.period[1]}, инструментов {stats.run.instruments}, вход {stats.run.entry_type === "limit" ? "лимитный" : "рыночный"}.
              {stats.run.note ? ` ${stats.run.note}` : ""}
            </>
          )}
        </p>

        <form className={s.filters} method="get" action="/stats">
          <input type="hidden" name="scope" value={scope} />
          {scope === "backtest" ? (
            <label>
              прогон
              <select name="run_id" defaultValue={q.run_id ?? ""}>
                <option value="">последний</option>
                {runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    #{r.id} {r.strategy_version} {r.period[0]}…{r.period[1]} {r.entry_type}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label>
              версия стратегии
              <select name="version" defaultValue={q.version ?? ""}>
                <option value="">все</option>
                {versionOptions.map((v) => (
                  <option key={v.id} value={v.version}>
                    {v.name} {v.version}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            период
            <select name="days" defaultValue={q.days ?? ""}>
              <option value="">весь</option>
              <option value="30">30 дней</option>
              <option value="90">90 дней</option>
              <option value="180">180 дней</option>
              <option value="365">год</option>
            </select>
          </label>
          <label>
            инструмент
            <input name="symbol" defaultValue={q.symbol ?? ""} placeholder="все" style={{ textTransform: "uppercase" }} />
          </label>
          <label>
            градация
            <select name="grade" defaultValue={q.grade ?? ""}>
              <option value="">все</option>
              <option value="A">A</option>
              <option value="B">B</option>
              <option value="C">C</option>
            </select>
          </label>
          <label>
            тип входа
            <select name="entry_type" defaultValue={q.entry_type ?? ""}>
              <option value="">оба</option>
              <option value="market">рыночный</option>
              <option value="limit">лимитный</option>
            </select>
          </label>
          <button type="submit" className="caption" style={{ height: 32, padding: "0 12px", border: "1px solid var(--border)", borderRadius: "var(--radius)", background: "var(--surface)", color: "var(--text)", cursor: "pointer" }}>
            Применить
          </button>
          {query !== `scope=${scope}` && (
            <Link href={`/stats?scope=${scope}`} className="caption">
              сбросить
            </Link>
          )}
        </form>

        {!stats ? (
          <Panel>
            <EmptyState text="API недоступен, попробуйте позже." />
          </Panel>
        ) : !has ? (
          <Panel>
            <EmptyState
              text={
                scope === "live"
                  ? "Live-сигналов пока нет: текущая версия стратегии проходит форвард-тест. Переключите область на «Форвард-тест» или «Бэктест»."
                  : scope === "backtest" && !stats.run
                    ? "Сохранённых прогонов бэктеста нет."
                    : "По этим фильтрам сделок нет."
              }
            />
          </Panel>
        ) : (
          <>
            <MetricCards m={m!} />

            <div className={s.two}>
              <Panel title="Накопленный результат, R" actions={<span>{m!.closed} {plural(m!.closed, "сделка", "сделки", "сделок")}, итог {formatR(m!.sum_r)}</span>}>
                {stats.equity.length > 1 ? <EquityChart points={stats.equity} /> : <EmptyState text="Мало сделок для кривой." />}
              </Panel>
              <Panel title="Худшие периоды" footer="Три самые глубокие просадки — чтобы вы видели не только итог." flush>
                {stats.worst_drawdowns.length === 0 ? (
                  <EmptyState text="Просадок нет." />
                ) : (
                  <Table compact stack={false}>
                    <thead>
                      <tr>
                        <Th>Пик</Th>
                        <Th>Дно</Th>
                        <Th num>Глубина</Th>
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
              <Panel title="Распределение результата, R" footer="Сколько закрытых сделок попало в каждый диапазон R.">
                <RHistogram bins={stats.r_histogram} />
              </Panel>
              <BreakdownTable title="По типу входа" keyLabel="Вход" rows={entries.map(([k, v]) => [k === "limit" ? "лимитный" : "рыночный", v])} />
            </div>

            <div className={s.three}>
              <BreakdownTable title="По месяцам" keyLabel="Месяц" rows={months} />
              <BreakdownTable title="По градации" keyLabel="Градация" rows={grades} />
              <BreakdownTable title="По инструментам" keyLabel="Инструмент" rows={symbols} />
            </div>

            <Panel
              title={trades ? `История: ${trades.total} ${plural(trades.total, "сигнал", "сигнала", "сигналов")}` : "История"}
              actions={scope === "forward" ? <span>построчная история форварда не публикуется</span> : <CsvButton query={query} />}
              flush
            >
              {!trades ? (
                <EmptyState text="Для форвард-теста публикуются только агрегаты." />
              ) : trades.items.length === 0 ? (
                <EmptyState text="Сделок нет." />
              ) : (
                <>
                  <Table compact>
                    <thead>
                      <tr>
                        <Th>Время, UTC</Th>
                        <Th>Инструмент</Th>
                        <Th>Гр.</Th>
                        <Th num>Вход</Th>
                        <Th num>Стоп</Th>
                        <Th num>R:R</Th>
                        <Th>Тип</Th>
                        <Th>Статус</Th>
                        <Th num>TP</Th>
                        <Th num>Результат</Th>
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
                          <Td mobile="hidden">{t.entry_type === "limit" ? "лимит" : "рынок"}</Td>
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
                        {page > 0 && <Link href={link({ page: page - 1 })}>← назад</Link>}
                        {page + 1 < pages && <Link href={link({ page: page + 1 })}>вперёд →</Link>}
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
