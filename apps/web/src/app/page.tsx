import type { Metadata } from "next";
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

const FAQ: { q: string; a: string }[] = [
  {
    q: "Почему вы не обещаете доходность?",
    a: "Потому что её никто не может гарантировать. Мы показываем историю каждой сделки, винрейт, средний R и просадку за период, и этого достаточно, чтобы вы сами оценили систему. Любое обещание доходности в этой сфере — признак обмана.",
  },
  {
    q: "Что такое R?",
    a: "Единица риска. 1 R — расстояние от входа до стопа. Результат +2 R означает, что сделка принесла вдвое больше, чем вы рисковали; −1 R — сработал стоп. Так сравниваются сделки на разных инструментах и с разным размером позиции.",
  },
  {
    q: "Почему именно H4?",
    a: "На 4-часовом таймфрейме структура рынка читается надёжнее, чем на минутных, шум ниже, а сигналов немного — их можно обработать вручную без постоянного сидения у монитора. Сделка в среднем длится от нескольких часов до нескольких дней.",
  },
  {
    q: "Сигнал может измениться после публикации?",
    a: "Нет. Движок работает только по закрытым свечам, а запись о сигнале в базе данных нельзя изменить — только дописать события (касание входа, стопа, целей). Любой сигнал можно воспроизвести по тем же данным и получить тот же результат.",
  },
  {
    q: "Это искусственный интеллект?",
    a: "Нет. Сигналы генерирует детерминированный набор правил: тренд старшего таймфрейма, структура рынка, зоны интереса, фильтры по волатильности, объёму и деривативам. Правила описаны на этой странице. Языковая модель используется только для пояснений паттернов на графике и помечается отдельно.",
  },
  {
    q: "Какие инструменты?",
    a: "Бессрочные фьючерсы Binance в USDT: BTC, ETH и ещё около 30 ликвидных пар. Список расширяется только после бэктеста и форвард-теста на новом инструменте.",
  },
  {
    q: "Что значит «форвард-тест»?",
    a: "Период, когда стратегия работает на живых данных, но её сигналы не публикуются. Так мы проверяем, что результат на реальном рынке совпадает с бэктестом. Только после форвард-теста версия стратегии попадает в ленту.",
  },
  {
    q: "Можно ли торговать по сигналам автоматически?",
    a: "Сервис не исполняет сделки и не подключается к вашим биржевым ключам. Решение о входе и размере позиции вы принимаете сами; калькулятор риска помогает посчитать размер.",
  },
  {
    q: "Как оплачивать?",
    a: "Только криптовалютой: USDT, USDC, BTC, ETH, TON. Подписка оформляется на 1, 3 или 12 месяцев без автопродления. Первые 7 дней Pro — бесплатно, без оплаты.",
  },
  {
    q: "Чем Free отличается от Pro?",
    a: "Логика сигналов одинаковая для всех. Free видит сигналы градации A с задержкой 12 часов, Pro — все сигналы сразу. Статистика открыта для всех.",
  },
];

function num(v: number | null | undefined, f: (n: number) => string): string {
  return v === null || v === undefined ? "—" : f(v);
}

function MetricsRow({ m, updated }: { m: Metrics; updated: string }) {
  return (
    <dl className={s.metrics} aria-label={`live-статистика за 90 дней, обновлено ${updated}`}>
      <div className={s.metric}>
        <dt>сделок за 90 дней</dt>
        <dd>{m.closed}</dd>
      </div>
      <div className={s.metric}>
        <dt>винрейт</dt>
        <dd>{num(m.winrate, (n) => formatPct(n * 100, { signed: false }))}</dd>
      </div>
      <div className={s.metric}>
        <dt>средний R</dt>
        <dd>{num(m.avg_r, (n) => formatR(n))}</dd>
      </div>
      <div className={s.metric}>
        <dt>макс. просадка</dt>
        <dd>{m.closed ? formatR(-m.max_drawdown_r) : "—"}</dd>
      </div>
    </dl>
  );
}

export default async function Home() {
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
            <h1 id="h-title">Сигналы на H4 с публичной статистикой каждой сделки</h1>
            <p>
              Одна система правил для всех инструментов. Сигнал публикуется через 60 секунд после
              закрытия 4-часовой свечи и не меняется задним числом. Результат каждой сделки, включая
              убыточные, виден всем.
            </p>
            <div className={s.cta}>
              <Button href="/login" variant="primary">
                Создать аккаунт
              </Button>
              <Button href="#stats">Открытая статистика</Button>
            </div>
            <p className={s.fine}>{DISCLAIMER}</p>
          </div>
          <div className={s.section}>
            {hasLive && m ? (
              <MetricsRow m={m} updated={updated} />
            ) : (
              <Panel title="Live-статистика за 90 дней">
                <EmptyState text="Live-сигналов пока нет: текущая версия стратегии проходит форвард-тест на живых данных. Статистика появится с первой закрытой сделкой." />
              </Panel>
            )}
            <Panel
              title="Последние закрытые сигналы"
              actions={<span>обновляется раз в минуту</span>}
              flush
            >
              {recent.length === 0 ? (
                <EmptyState text="Закрытых live-сигналов пока нет." />
              ) : (
                <Table compact>
                  <thead>
                    <tr>
                      <Th>Время</Th>
                      <Th>Инструмент</Th>
                      <Th>Статус</Th>
                      <Th num>Результат</Th>
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
            <h2 id="h-how">Как это работает</h2>
            <p>Четыре шага от закрытия свечи до строки в статистике. Без ручного вмешательства.</p>
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
            <h2 id="h-rules">Правила системы</h2>
            <p>
              Стратегия «тренд → зона → ретест». Все параметры зафиксированы в версии стратегии;
              изменение любого числа — это новая версия с новым бэктестом и форвард-тестом.
            </p>
          </div>
          <div className={s.rules}>
            <Panel title="Что проверяется на каждой свече H4">
              <dl>
                <dt>Контекст</dt>
                <dd>
                  Направление тренда на D1 и W1 по структуре и EMA50. Сделки только по тренду
                  старшего таймфрейма; при расхождении D1 и W1 сигнала нет.
                </dd>
                <dt>Структура</dt>
                <dd>
                  Свинги, слом структуры (BOS) и смена характера (CHoCH) на H4. Вход — только после
                  подтверждённого слома в сторону тренда.
                </dd>
                <dt>Зона</dt>
                <dd>
                  Ордер-блок или имбаланс (FVG), образовавшие слом. Вход — на возврате цены в зону, не
                  на пробое.
                </dd>
                <dt>Ликвидность</dt>
                <dd>
                  Снятие равных максимумов/минимумов, дневных и недельных уровней до входа повышает
                  оценку сигнала.
                </dd>
                <dt>Фильтры</dt>
                <dd>
                  Волатильность (ATR в границах), объём, расстояние до стопа, funding и открытый
                  интерес, макрособытия, корреляция с BTC. Любой невыполненный фильтр отменяет сигнал.
                </dd>
              </dl>
            </Panel>
            <Panel title="Параметры сделки и оценка">
              <dl>
                <dt>Вход</dt>
                <dd>Лимитный ордер в зоне; срок жизни — 6 свечей H4, потом сигнал истекает без сделки.</dd>
                <dt>Стоп</dt>
                <dd>За границей зоны с запасом по ATR. Стоп не двигается против позиции.</dd>
                <dt>Цели</dt>
                <dd>
                  TP1 — ближайшая ликвидность, TP2 — не менее 2.5 R, TP3 — следующий структурный
                  уровень. После TP1 стоп переносится в безубыток.
                </dd>
                <dt>Оценка</dt>
                <dd>
                  0–100 баллов по восьми компонентам; градации A (≥ 75), B (60–74), C (45–59).
                  Градация — это не «сила» сигнала, а статистическая группа с собственным винрейтом.
                </dd>
                <dt>Без перерисовки</dt>
                <dd>
                  Только закрытые свечи, запись сигнала неизменяема, каждый сигнал воспроизводим по
                  хэшу входных данных.
                </dd>
              </dl>
            </Panel>
          </div>
        </section>

        {/* Статистика */}
        <section id="stats" className={s.section} aria-labelledby="h-stats">
          <div className={s.sectionHead}>
            <h2 id="h-stats">Статистика</h2>
            <p>
              Считается автоматически по закрытым live-сигналам тем же кодом, что бэктест. Ручного
              ввода нет. Период: 90 дней, обновлено {updated}.
            </p>
          </div>
          {hasLive && stats && m ? (
            <div className={s.statsGrid}>
              <Panel
                title="Накопленный результат, R"
                actions={
                  <span>
                    {m.closed} {plural(m.closed, "сделка", "сделки", "сделок")}, итог {formatR(m.sum_r)}
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
              <Panel title="По месяцам" flush>
                <Table compact stack={false}>
                  <thead>
                    <tr>
                      <Th>Месяц</Th>
                      <Th num>Сделок</Th>
                      <Th num>Винрейт</Th>
                      <Th num>Итог, R</Th>
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
            <Panel title="Статистика live-сигналов">
              <EmptyState text="Публикуем только результаты live-версии стратегии. Бэктест и форвард-тест не выдаём за реальный результат; их отчёты появятся на отдельной странице с пометкой типа данных." />
            </Panel>
          )}
        </section>

        {/* Тарифы */}
        <section id="pricing" className={s.section} aria-labelledby="h-pricing">
          <div className={s.sectionHead}>
            <h2 id="h-pricing">Тарифы</h2>
            <p>
              Логика сигналов одинакова на всех тарифах. Различаются скорость доступа, набор
              инструментов и глубина инструментов. Оплата только криптовалютой, без автопродления.
            </p>
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
                  <th scope="row">Цена</th>
                  <td>
                    <span className={s.price}>0</span>
                  </td>
                  <td>
                    <span className={s.price}>29 USD</span> / мес
                    <br />
                    <span className="caption">249 USD / год</span>
                  </td>
                  <td>
                    <span className={s.price}>79 USD</span> / мес
                    <br />
                    <span className="caption">690 USD / год</span>
                  </td>
                </tr>
                <tr>
                  <th scope="row">Сигналы</th>
                  <td>Градация A, с задержкой 12 часов</td>
                  <td>Все градации, сразу</td>
                  <td>Все + экспериментальные стратегии (форвард)</td>
                </tr>
                <tr>
                  <th scope="row">Инструменты</th>
                  <td>BTC, ETH + 3 на выбор</td>
                  <td>Все</td>
                  <td>Все + расширенный список</td>
                </tr>
                <tr>
                  <th scope="row">Уведомления</th>
                  <td>Email-дайджест раз в день</td>
                  <td>Telegram, push, email — сразу</td>
                  <td>То же + вебхуки</td>
                </tr>
                <tr>
                  <th scope="row">Статистика</th>
                  <td>Публичная</td>
                  <td>Полная история, CSV</td>
                  <td>То же + API-ключ</td>
                </tr>
                <tr>
                  <th scope="row">Журнал, вотчлист</th>
                  <td>20 записей, 5 инструментов</td>
                  <td>Без ограничений, 50 инструментов</td>
                  <td>Без ограничений</td>
                </tr>
                <tr>
                  <th scope="row">Пробный период</th>
                  <td>—</td>
                  <td>7 дней без оплаты</td>
                  <td>—</td>
                </tr>
              </tbody>
            </table>
          </Panel>
          <p className="caption">
            Оплата появится после запуска: USDT, USDC, BTC, ETH, TON. До этого все
            зарегистрированные пользователи получают доступ уровня Pro.
          </p>
        </section>

        {/* FAQ */}
        <section id="faq" className={s.section} aria-labelledby="h-faq">
          <div className={s.sectionHead}>
            <h2 id="h-faq">Вопросы и ответы</h2>
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
            ? `Движок: ${health.status === "ok" ? "работает" : "сбой"}, свечей в базе: ${Number(health.candles).toLocaleString("ru-RU")}`
            : "Движок: нет связи с API"
        }
      />
    </>
  );
}
