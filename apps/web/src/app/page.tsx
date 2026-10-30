import type { Metadata } from "next";
import { FAQ } from "@/content/faq";
import { EquityChart, Footer, Header } from "@/components/site";
import { Button } from "@/components/ui";
import { getHealth, getInstrumentCount, getStats, type Metrics } from "@/lib/api";
import { formatPct, formatR, formatTimeUTC } from "@/lib/format";
import s from "./page.module.css";
import { getT } from "@/i18n/server";

// Рендер на каждый запрос (данные fetch кэшируются на 60 с): при сборке образа API недоступен.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "PlatformSol — уровни, зоны и ликвидации на одном графике",
  description:
    "Крипто-график с поддержкой и сопротивлением, зонами OB и FVG и картой ликвидаций. Сигналы на H4 по строгим правилам с открытой статистикой каждой сделки.",
};

/** Иконки возможностей: линия currentColor, 24 px. */
const ICON: Record<string, string> = {
  levels: "M3 7h18M3 12h18M3 17h18M15 4v16",
  signal: "M4 17l5-5 4 4 7-8M15 8h5v5",
  screener: "M4 5h16l-6 7v6l-4 2v-8z",
  alert: "M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0",
  journal: "M6 3h10l3 3v15H6zM9 9h7M9 13h7M9 17h4",
  ask: "M4 5h16v11H9l-5 4zM9 9h6M9 12h4",
};

const FEATURES = [
  { icon: "levels", t: "Уровни и карта ликвидаций", p: "Поддержка и сопротивление по касаниям, зоны OB, FVG и SD, оценка ликвидаций с суммами — без шума поверх свечей." },
  { icon: "signal", t: "Сигналы по правилам", p: "Тренд → зона → ретест: вход, стоп и три цели. Одна версия правил для всех монет, без ручных правок." },
  { icon: "screener", t: "Скринер", p: "Какие монеты ближе всего к зоне входа: фильтры по тренду, волатильности, funding и открытому интересу." },
  { icon: "alert", t: "Алерты", p: "Цена, индикаторы, зоны, структура и паттерны. Push и письмо в течение минуты." },
  { icon: "journal", t: "Журнал сделок", p: "Результат в R, винрейт, типовые ошибки и импорт сделок с Binance." },
  { icon: "ask", t: "Вопрос о графике", p: "Ответ по данным графика: тренд, зоны, уровни. Без прогнозов и советов." },
];

const STEPS = [
  { t: "Свеча H4 закрылась", p: "Через 60 секунд после закрытия движок проверяет каждый инструмент по одним и тем же правилам. Незакрытые свечи не участвуют." },
  { t: "Сигнал или его отсутствие", p: "Если все условия выполнены — публикуется сигнал с входом, стопом и тремя целями. Если нет — ничего не публикуется. В среднем 0–3 сигнала в день на 30 инструментов." },
  { t: "Трекер ведёт сделку", p: "Касание входа, стопа и целей фиксируется автоматически по минутным свечам биржи. Сигнал нельзя отредактировать после публикации." },
  { t: "Результат попадает в статистику", p: "Каждая сделка в R (отношение к риску) видна всем, включая убыточные. Статистика считается тем же кодом, что и бэктест." },
];

const RULES = [
  { t: "Контекст", p: "Направление тренда на D1 и W1 по структуре и EMA50. Сделки только по тренду старшего таймфрейма; при расхождении D1 и W1 сигнала нет." },
  { t: "Структура", p: "Свинги, слом структуры (BOS) и смена характера (CHoCH) на H4. Вход — только после подтверждённого слома в сторону тренда." },
  { t: "Зона", p: "Ордер-блок или имбаланс (FVG), образовавшие слом. Вход — на возврате цены в зону, не на пробое." },
  { t: "Ликвидность", p: "Снятие равных максимумов/минимумов, дневных и недельных уровней до входа повышает оценку сигнала." },
  { t: "Фильтры", p: "Волатильность (ATR в границах), объём, расстояние до стопа, funding и открытый интерес, макрособытия, корреляция с BTC. Любой невыполненный фильтр отменяет сигнал." },
  { t: "Стоп и цели", p: "Стоп за границей зоны с запасом по ATR. TP1 — ближайшая ликвидность, TP2 — не менее 2.5 R, TP3 — следующий структурный уровень. После TP1 стоп переносится в безубыток." },
];

const PLANS = [
  { name: "Free", price: "$0", per: "", year: "", cta: "Начать бесплатно", href: "/register", hot: false, items: ["Сигналы градации A с задержкой 12 часов", "BTC, ETH + 3 инструмента на выбор", "Email-дайджест раз в день", "Публичная статистика"] },
  { name: "Pro", price: "$29", per: "/ мес", year: "или $249 в год", cta: "Попробовать Pro", href: "/register", hot: true, items: ["Все сигналы сразу", "Все инструменты, уровни и карта ликвидаций", "Алерты: Telegram, push, email", "Скринер, журнал без ограничений, CSV"] },
  { name: "Premium", price: "$79", per: "/ мес", year: "или $690 в год", cta: "Выбрать Premium", href: "/pricing", hot: false, items: ["Всё из Pro", "Вопросы о графике", "Экспериментальные стратегии", "API-ключ и вебхуки"] },
];

function Icon({ name }: { name: string }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICON[name]} />
    </svg>
  );
}

async function LiveStats({ m, equity, updated }: { m: Metrics; equity: { t: string; r: number }[]; updated: string }) {
  const t = await getT();
  const num = (v: number | null | undefined, f: (n: number) => string) => (v == null ? "—" : f(v));
  return (
    <div className={s.liveCard}>
      <dl className={s.liveNums} aria-label={t("live-статистика за 90 дней, обновлено {u}", { u: updated })}>
        <div>
          <dt>{t("сделок за 90 дней")}</dt>
          <dd>{m.closed}</dd>
        </div>
        <div>
          <dt>{t("винрейт")}</dt>
          <dd>{num(m.winrate, (n) => formatPct(n * 100, { signed: false }))}</dd>
        </div>
        <div>
          <dt>{t("средний R")}</dt>
          <dd>{num(m.avg_r, (n) => formatR(n))}</dd>
        </div>
        <div>
          <dt>{t("макс. просадка")}</dt>
          <dd>{formatR(-m.max_drawdown_r)}</dd>
        </div>
      </dl>
      <EquityChart points={equity} />
    </div>
  );
}

export default async function Home() {
  const t = await getT();
  const [stats, health, instruments] = await Promise.all([getStats(90), getHealth(), getInstrumentCount()]);
  const m = stats?.metrics;
  const hasLive = !!m && m.closed > 0;
  const candles = health ? Number(health.candles) : null;
  const candlesText = candles ? `${(candles / 1e6).toFixed(1).replace(".", ",")} ${t("млн")}` : "1,5+ " + t("млн");

  return (
    <>
      <Header />
      <main>
        {/* Первый экран */}
        <section className={s.hero} aria-labelledby="h-title">
          <div className={`container ${s.heroInner}`}>
            <div className={s.heroText}>
              <span className={s.eyebrow}>{t("Крипто · Binance · только закрытые свечи")}</span>
              <h1 id="h-title">{t("Уровни, зоны и ликвидации на одном чистом графике")}</h1>
              <p className={s.sub}>{t("PlatformSol сам размечает поддержку и сопротивление, зоны OB и FVG и карту ликвидаций с суммами. Сигналы на H4 строятся по строгим правилам, и результат каждой сделки открыт.")}</p>
              <div className={s.cta}>
                <Button href="/chart/BTCUSDT/4h" variant="primary" size="lg">
                  {t("Открыть график")}
                </Button>
                <Button href="/register" size="lg">
                  {t("Создать аккаунт")}
                </Button>
              </div>
              <p className={s.note}>{t("Пока оплата не включена, все новые пользователи получают уровень Pro. Не является инвестиционной рекомендацией.")}</p>
            </div>
            <figure className={s.shot}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className={s.shotDark} src="/landing/chart-dark.png" width={1240} height={729} alt={t("График BTCUSDT H4 с уровнями, зонами и картой ликвидаций")} />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className={s.shotLight} src="/landing/chart-light.png" width={1240} height={729} alt="" aria-hidden="true" />
            </figure>
          </div>
        </section>

        {/* Цифры */}
        <section className="container" aria-label={t("цифры")}>
          <dl className={s.numbers}>
            <div>
              <dd>{instruments ?? 60}</dd>
              <dt>{t("монет Binance в работе")}</dt>
            </div>
            <div>
              <dd>{candlesText}</dd>
              <dt>{t("свечей в истории")}</dt>
            </div>
            <div>
              <dd>60 {t("с")}</dd>
              <dt>{t("от закрытия свечи до сигнала")}</dt>
            </div>
            <div>
              <dd>0</dd>
              <dt>{t("правок задним числом")}</dt>
            </div>
          </dl>
        </section>

        {/* Возможности */}
        <section id="features" className={`container ${s.section}`} aria-labelledby="h-features">
          <header className={s.head}>
            <h2 id="h-features">{t("Всё для решения — на одном экране")}</h2>
            <p>{t("Инструменты профессионального терминала без лишнего: только то, что помогает читать рынок.")}</p>
          </header>
          <ul className={s.features}>
            {FEATURES.map((f) => (
              <li key={f.t}>
                <span className={s.icon}>
                  <Icon name={f.icon} />
                </span>
                <h3>{t(f.t)}</h3>
                <p>{t(f.p)}</p>
              </li>
            ))}
          </ul>
        </section>

        {/* Как работает сигнал */}
        <section id="signals" className={`container ${s.section}`} aria-labelledby="h-how">
          <header className={s.head}>
            <h2 id="h-how">{t("Как работает сигнал")}</h2>
            <p>{t("Четыре шага от закрытия свечи до строки в статистике. Без ручного вмешательства.")}</p>
          </header>
          <ol className={s.steps}>
            {STEPS.map((st, i) => (
              <li key={st.t}>
                <span className={s.stepN}>{i + 1}</span>
                <h3>{t(st.t)}</h3>
                <p>{t(st.p)}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* Открытая статистика и правила */}
        <section id="rules" className={`container ${s.section} ${s.split}`} aria-labelledby="h-open">
          <div className={s.open}>
            <h2 id="h-open">{t("Статистика без подтасовок")}</h2>
            <p>{t("Каждая сделка — в R, включая убыточные. Бэктест, форвард-тест и live показаны раздельно и подписаны. Сигнал нельзя изменить после публикации: запись в базе только дописывается.")}</p>
            {hasLive && stats && m ? (
              <LiveStats m={m} equity={stats.equity} updated={formatTimeUTC(stats.generated_at)} />
            ) : (
              <p className={s.status}>
                <span className={s.dot} aria-hidden="true" />
                {t("Текущая версия стратегии проходит проверку на живом рынке. Её результаты — на странице статистики с пометкой «форвард».")}
              </p>
            )}
            <Button href="/stats">{t("Смотреть статистику")}</Button>
          </div>
          <div className={s.rules}>
            <h3>{t("Правила системы")}</h3>
            {RULES.map((r) => (
              <details key={r.t}>
                <summary>{t(r.t)}</summary>
                <p>{t(r.p)}</p>
              </details>
            ))}
          </div>
        </section>

        {/* Тарифы */}
        <section id="pricing" className={`container ${s.section}`} aria-labelledby="h-pricing">
          <header className={s.head}>
            <h2 id="h-pricing">{t("Тарифы")}</h2>
            <p>{t("Логика сигналов одинакова на всех тарифах. Различаются скорость доступа и набор инструментов.")}</p>
          </header>
          <div className={s.plans}>
            {PLANS.map((p) => (
              <article key={p.name} className={s.plan} data-hot={p.hot || undefined}>
                {p.hot && <span className={s.badge}>{t("Популярный")}</span>}
                <h3>{p.name}</h3>
                <p className={s.price}>
                  <span>{p.price}</span> {p.per && t(p.per)}
                </p>
                <p className={s.year}>{p.year ? t(p.year) : " "}</p>
                <ul>
                  {p.items.map((it) => (
                    <li key={it}>{t(it)}</li>
                  ))}
                </ul>
                <Button href={p.href} variant={p.hot ? "primary" : "default"} block>
                  {t(p.cta)}
                </Button>
              </article>
            ))}
          </div>
          <p className={s.payNote}>{t("Оплата криптовалютой: USDT, USDC, BTC, ETH, TON, без автопродления. Пока оплата не включена, все зарегистрированные пользователи получают уровень Pro.")}</p>
        </section>

        {/* Вопросы */}
        <section id="faq" className={`container ${s.section} ${s.faqSection}`} aria-labelledby="h-faq">
          <header className={s.head}>
            <h2 id="h-faq">{t("Вопросы и ответы")}</h2>
          </header>
          <div className={s.faq}>
            {FAQ.map((f) => (
              <details key={f.q}>
                <summary>{t(f.q)}</summary>
                <p>{t(f.a)}</p>
              </details>
            ))}
          </div>
        </section>

        {/* Призыв */}
        <section className="container">
          <div className={s.final}>
            <h2>{t("Откройте график BTC прямо сейчас")}</h2>
            <p>{t("Регистрация не нужна: уровни, зоны и карта ликвидаций доступны сразу.")}</p>
            <Button href="/chart/BTCUSDT/4h" variant="primary" size="lg">
              {t("Открыть график")}
            </Button>
          </div>
        </section>
      </main>
      <Footer
        status={
          health
            ? `${t("Движок")}: ${health.status === "ok" ? t("работает") : t("сбой")}`
            : t("Движок: нет связи с API")
        }
      />
    </>
  );
}
