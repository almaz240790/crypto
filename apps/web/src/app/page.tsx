import type { Metadata } from "next";
import Link from "next/link";
import { FAQ } from "@/content/faq";
import { DISCLAIMER, EquityChart, Footer, Header } from "@/components/site";
import {
  Button,
  DirectionBadge,
  EmptyState,
  GradeBadge,
  Panel,
  StatusBadge,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { getClosedSignals, getHealth, getStats, type Metrics } from "@/lib/api";
import { formatDuration, formatPct, formatR, formatTimeUTC, plural } from "@/lib/format";
import s from "./page.module.css";
import { getT } from "@/i18n/server";

// Рендер на каждый запрос (данные fetch кэшируются на 60 с): при сборке образа API недоступен.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Platform — сигналы на H4 с публичной статистикой каждой сделки",
  description:
    "Торговые сигналы на 4-часовом таймфрейме по крипторынку. Одна система правил, закрытые свечи, статистика каждой сделки открыта.",
};

const STEPS = [
  {
    t: "Свеча H4 закрылась",
    p: "Через 60 секунд после закрытия движок проверяет каждый инструмент по одним и тем же правилам. Незакрытые свечи не участвуют.",
  },
  {
    t: "Сигнал или его отсутствие",
    p: "Если все условия выполнены — публикуется сигнал с входом, стопом и тремя целями. Если нет — ничего не публикуется. В среднем 0–3 сигнала в день на 30 инструментов.",
  },
  {
    t: "Трекер ведёт сделку",
    p: "Касание входа, стопа и целей фиксируется автоматически по минутным свечам биржи. Сигнал нельзя отредактировать после публикации.",
  },
  {
    t: "Результат попадает в статистику",
    p: "Каждая сделка в R (отношение к риску) видна всем, включая убыточные. Статистика считается тем же кодом, что и бэктест.",
  },
];


function num(v: number | null | undefined, f: (n: number) => string): string {
  return v === null || v === undefined ? "—" : f(v);
}

async function MetricsRow({ m, updated }: { m: Metrics; updated: string }) {
  const t = await getT();
  return (
    <dl className={s.metrics} aria-label={`live-статистика за 90 дней, обновлено ${updated}`}>
      <div className={s.metric}>
        <dt>{t("сделок за 90 дней")}</dt>
        <dd>{m.closed}</dd>
      </div>
      <div className={s.metric}>
        <dt>{t("винрейт")}</dt>
        <dd>{num(m.winrate, (n) => formatPct(n * 100, { signed: false }))}</dd>
      </div>
      <div className={s.metric}>
        <dt>{t("средний R")}</dt>
        <dd>{num(m.avg_r, (n) => formatR(n))}</dd>
      </div>
      <div className={s.metric}>
        <dt>{t("макс. просадка")}</dt>
        <dd>{m.closed ? formatR(-m.max_drawdown_r) : "—"}</dd>
      </div>
    </dl>
  );
}

export default async function Home() {
  const t = await getT();
  const [stats, recent, health] = await Promise.all([getStats(90), getClosedSignals(5), getHealth()]);
  const m = stats?.metrics;
  const hasLive = !!m && m.closed > 0;
  const updated = stats ? formatTimeUTC(stats.generated_at) : "—";
  const months = stats ? Object.entries(stats.by_month).sort(([a], [b]) => (a < b ? 1 : -1)) : [];

  return (
    <>
      <Header />
      <main className={`container ${s.main}`}>
        {/* Первый экран */}
        <section className={s.hero} aria-labelledby="h-title">
          <div className={s.lead}>
            <h1 id="h-title">{t("Сигналы на H4 с публичной статистикой каждой сделки")}</h1>
            <p>{t("Одна система правил для всех инструментов. Сигнал публикуется через 60 секунд после закрытия 4-часовой свечи и не меняется задним числом. Результат каждой сделки, включая убыточные, виден всем.")}</p>
            <div className={s.cta}>
              <Button href="/login" variant="primary">{t("Создать аккаунт")}</Button>
              <Button href="/stats">{t("Открытая статистика")}</Button>
            </div>
            <p className={s.fine}>{DISCLAIMER}</p>
          </div>
          <div className={s.section}>
            {hasLive && m ? (
              <MetricsRow m={m} updated={updated} />
            ) : (
              <Panel title={t("Live-статистика за 90 дней")}>
                <EmptyState text={t("Live-сигналов пока нет: текущая версия стратегии проходит форвард-тест на живых данных. Статистика появится с первой закрытой сделкой.")} />
              </Panel>
            )}
            <Panel
              title={t("Последние закрытые сигналы")}
              actions={<span>{t("обновляется раз в минуту")}</span>}
              flush
            >
              {recent.length === 0 ? (
                <EmptyState text={t("Закрытых live-сигналов пока нет.")} />
              ) : (
                <Table compact>
                  <thead>
                    <tr>
                      <Th>{t("Время")}</Th>
                      <Th>{t("Инструмент")}</Th>
                      <Th>{t("Статус")}</Th>
                      <Th num>{t("Результат")}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((r) => {
                      const rr = r.result?.realized_r ? Number(r.result.realized_r) : null;
                      return (
                        <tr key={r.id}>
                          <Td mobile="secondary" className="text-2">
                            {formatTimeUTC(r.candle_close_time)}
                          </Td>
                          <Td>
                            <strong>{r.symbol}</strong> <DirectionBadge direction={r.direction} />{" "}
                            <GradeBadge grade={r.grade} />
                          </Td>
                          <Td mobile="secondary">
                            <StatusBadge status={r.status} />
                          </Td>
                          <Td num mobile="right" className={rr == null ? "" : rr > 0 ? "up" : rr < 0 ? "down" : ""}>
                            {rr == null ? "—" : formatR(rr)}
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Table>
              )}
            </Panel>
          </div>
        </section>

        {/* Как это работает */}
        <section id="signals" className={s.section} aria-labelledby="h-how">
          <div className={s.sectionHead}>
            <h2 id="h-how">{t("Как это работает")}</h2>
            <p>{t("Четыре шага от закрытия свечи до строки в статистике. Без ручного вмешательства.")}</p>
          </div>
          <ol className={s.steps} style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {STEPS.map((st, i) => (
              <li key={st.t} className={s.step}>
                <span className={s.n}>0{i + 1}</span>
                <h3>{st.t}</h3>
                <p>{st.p}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* Правила системы */}
        <section id="rules" className={s.section} aria-labelledby="h-rules">
          <div className={s.sectionHead}>
            <h2 id="h-rules">{t("Правила системы")}</h2>
            <p>{t("Стратегия «тренд → зона → ретест». Все параметры зафиксированы в версии стратегии; изменение любого числа — это новая версия с новым бэктестом и форвард-тестом.")}</p>
          </div>
          <div className={s.rules}>
            <Panel title={t("Что проверяется на каждой свече H4")}>
              <dl>
                <dt>{t("Контекст")}</dt>
                <dd>{t("Направление тренда на D1 и W1 по структуре и EMA50. Сделки только по тренду старшего таймфрейма; при расхождении D1 и W1 сигнала нет.")}</dd>
                <dt>{t("Структура")}</dt>
                <dd>{t("Свинги, слом структуры (BOS) и смена характера (CHoCH) на H4. Вход — только после подтверждённого слома в сторону тренда.")}</dd>
                <dt>{t("Зона")}</dt>
                <dd>{t("Ордер-блок или имбаланс (FVG), образовавшие слом. Вход — на возврате цены в зону, не на пробое.")}</dd>
                <dt>{t("Ликвидность")}</dt>
                <dd>{t("Снятие равных максимумов/минимумов, дневных и недельных уровней до входа повышает оценку сигнала.")}</dd>
                <dt>{t("Фильтры")}</dt>
                <dd>{t("Волатильность (ATR в границах), объём, расстояние до стопа, funding и открытый интерес, макрособытия, корреляция с BTC. Любой невыполненный фильтр отменяет сигнал.")}</dd>
              </dl>
            </Panel>
            <Panel title={t("Параметры сделки и оценка")}>
              <dl>
                <dt>{t("Вход")}</dt>
                <dd>{t("Лимитный ордер в зоне; срок жизни — 6 свечей H4, потом сигнал истекает без сделки.")}</dd>
                <dt>{t("Стоп")}</dt>
                <dd>{t("За границей зоны с запасом по ATR. Стоп не двигается против позиции.")}</dd>
                <dt>{t("Цели")}</dt>
                <dd>{t("TP1 — ближайшая ликвидность, TP2 — не менее 2.5 R, TP3 — следующий структурный уровень. После TP1 стоп переносится в безубыток.")}</dd>
                <dt>{t("Оценка")}</dt>
                <dd>{t("0–100 баллов по восьми компонентам; градации A (≥ 75), B (60–74), C (45–59). Градация — это не «сила» сигнала, а статистическая группа с собственным винрейтом.")}</dd>
                <dt>{t("Без перерисовки")}</dt>
                <dd>{t("Только закрытые свечи, запись сигнала неизменяема, каждый сигнал воспроизводим по хэшу входных данных.")}</dd>
              </dl>
            </Panel>
          </div>
        </section>

        {/* Статистика */}
        <section id="stats" className={s.section} aria-labelledby="h-stats">
          <div className={s.sectionHead}>
            <h2 id="h-stats">{t("Статистика")}</h2>
            <p>
              Считается автоматически по закрытым live-сигналам тем же кодом, что бэктест. Ручного
              ввода нет. Период: 90 дней, обновлено {updated}.
            </p>
          </div>
          {hasLive && stats && m ? (
            <div className={s.statsGrid}>
              <Panel
                title={t("Накопленный результат, R")}
                actions={
                  <span>
                    {m.closed} {plural(m.closed, t("сделка"), t("сделки"), t("сделок"))}, итог {formatR(m.sum_r)}
                  </span>
                }
              >
                <EquityChart points={stats.equity} />
                <p className="caption" style={{ marginTop: 8 }}>
                  Профит-фактор {num(m.profit_factor, (n) => n.toFixed(2))}, серия убытков до{" "}
                  {m.max_losing_streak}, средняя длительность {formatDuration(m.avg_duration_hours)}.
                  {stats.worst_drawdowns[0] &&
                    ` Худшая просадка ${formatR(-stats.worst_drawdowns[0].depth_r)} с ${formatTimeUTC(stats.worst_drawdowns[0].start)}.`}
                </p>
              </Panel>
              <Panel title={t("По месяцам")} flush>
                <Table compact stack={false}>
                  <thead>
                    <tr>
                      <Th>{t("Месяц")}</Th>
                      <Th num>{t("Сделок")}</Th>
                      <Th num>{t("Винрейт")}</Th>
                      <Th num>{t("Итог, R")}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {months.slice(0, 6).map(([k, v]) => (
                      <tr key={k}>
                        <Td>{k}</Td>
                        <Td num>{v.closed}</Td>
                        <Td num>{num(v.winrate, (n) => formatPct(n * 100, { signed: false }))}</Td>
                        <Td num className={v.sum_r > 0 ? "up" : v.sum_r < 0 ? "down" : ""}>
                          {formatR(v.sum_r)}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </Panel>
            </div>
          ) : (
            <Panel title={t("Статистика live-сигналов")} actions={<Link href="/stats">{t("вся статистика")}</Link>}>
              <EmptyState
                text={t("Live-сигналов пока нет. Результаты форвард-теста и бэктеста открыты на странице статистики с явной пометкой типа данных — мы не выдаём их за реальный результат.")}
                action={<Button href="/stats?scope=forward" size="sm">{t("Форвард и бэктест")}</Button>}
              />
            </Panel>
          )}
        </section>

        {/* Тарифы */}
        <section id="pricing" className={s.section} aria-labelledby="h-pricing">
          <div className={s.sectionHead}>
            <h2 id="h-pricing">{t("Тарифы")}</h2>
            <p>{t("Логика сигналов одинакова на всех тарифах. Различаются скорость доступа, набор инструментов и глубина инструментов. Оплата только криптовалютой, без автопродления.")}</p>
          </div>
          <Panel flush className={s.pricing}>
            <table>
              <thead>
                <tr>
                  <th />
                  <th>Free</th>
                  <th>Pro</th>
                  <th>Premium</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">{t("Цена")}</th>
                  <td>
                    <span className={s.price}>0</span>
                  </td>
                  <td>
                    <span className={s.price}>29 USD</span>{" "}{t("/ мес")}<br />
                    <span className="caption">{t("249 USD / год")}</span>
                  </td>
                  <td>
                    <span className={s.price}>79 USD</span>{" "}{t("/ мес")}<br />
                    <span className="caption">{t("690 USD / год")}</span>
                  </td>
                </tr>
                <tr>
                  <th scope="row">{t("Сигналы")}</th>
                  <td>{t("Градация A, с задержкой 12 часов")}</td>
                  <td>{t("Все градации, сразу")}</td>
                  <td>{t("Все + экспериментальные стратегии (форвард)")}</td>
                </tr>
                <tr>
                  <th scope="row">{t("Инструменты")}</th>
                  <td>{t("BTC, ETH + 3 на выбор")}</td>
                  <td>{t("Все")}</td>
                  <td>{t("Все + расширенный список")}</td>
                </tr>
                <tr>
                  <th scope="row">{t("Уведомления")}</th>
                  <td>{t("Email-дайджест раз в день")}</td>
                  <td>{t("Telegram, push, email — сразу")}</td>
                  <td>{t("То же + вебхуки")}</td>
                </tr>
                <tr>
                  <th scope="row">{t("Статистика")}</th>
                  <td>{t("Публичная")}</td>
                  <td>{t("Полная история, CSV")}</td>
                  <td>{t("То же + API-ключ")}</td>
                </tr>
                <tr>
                  <th scope="row">{t("Журнал, вотчлист")}</th>
                  <td>{t("20 записей, 5 инструментов")}</td>
                  <td>{t("Без ограничений, 50 инструментов")}</td>
                  <td>{t("Без ограничений")}</td>
                </tr>
                <tr>
                  <th scope="row">{t("Пробный период")}</th>
                  <td>—</td>
                  <td>{t("7 дней без оплаты")}</td>
                  <td>—</td>
                </tr>
              </tbody>
            </table>
          </Panel>
          <p className="caption">
            Оплата появится после запуска: USDT, USDC, BTC, ETH, TON. До этого все
            зарегистрированные пользователи получают доступ уровня Pro. Подробнее — на{" "}
            <Link href="/pricing">{t("странице тарифов")}</Link>.
          </p>
        </section>

        {/* FAQ */}
        <section id="faq" className={s.section} aria-labelledby="h-faq">
          <div className={s.sectionHead}>
            <h2 id="h-faq">{t("Вопросы и ответы")}</h2>
          </div>
          <div className={s.faq}>
            {FAQ.map((f) => (
              <details key={f.q}>
                <summary>{f.q}</summary>
                <div className={s.a}>{f.a}</div>
              </details>
            ))}
          </div>
        </section>
      </main>
      <Footer
        status={
          health
            ? `Движок: ${health.status === "ok" ? t("работает") : t("сбой")}, свечей в базе: ${Number(health.candles).toLocaleString("ru-RU")}`
            : t("Движок: нет связи с API")
        }
      />
    </>
  );
}
