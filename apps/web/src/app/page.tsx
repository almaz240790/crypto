import type { Metadata } from "next";
import Link from "next/link";
import { FAQ } from "@/content/faq";
import { Footer, Header } from "@/components/site";
import { getHealth, getInstrumentCount, getMonthPrices } from "@/lib/api";
import { COUNTS, DERIVATIVE_PANELS, INDICATOR_LIST, TOOL_GROUPS } from "@/lib/capabilities";
import s from "./page.module.css";
import { getT } from "@/i18n/server";

// Рендер на каждый запрос (данные fetch кэшируются): при сборке образа API недоступен.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "PlatformSol — крипто-график для технического анализа",
  description:
    "Индикаторы, инструменты рисования и автоматическая разметка: уровни, зоны OB и FVG, структура рынка и карта ликвидаций. Монеты Binance — в браузере и на телефоне.",
};

const EXTRAS = [
  ["Магнит", "к OHLC"],
  ["50 шагов", "отмены"],
  ["Рисунок", "на все таймфреймы"],
  ["Копирование", "на другую монету"],
  ["Алерт", "на уровне из линии"],
  ["Синхронизация", "между устройствами"],
];

const PATTERNS = [
  "Двойная вершина и дно",
  "Голова и плечи",
  "Треугольники",
  "Флаг и вымпел",
  "Клинья",
  "Каналы",
  "Чашка с ручкой",
  "Поглощение",
  "Пин-бар",
  "Доджи",
  "Утренняя и вечерняя звезда",
  "Три солдата и три вороны",
  "Внутренний бар",
  "Марубозу",
  "Пинцет",
  "Макс./мин. дня и недели",
];

const MORE = [
  { t: "Алерты с графика", p: "Пересечение уровня или вход в диапазон. Push, Telegram и письмо в течение минуты." },
  { t: "Снимок графика", p: "PNG с монетой, таймфреймом и временем — чтобы поделиться разбором." },
  { t: "Вопрос о графике", p: "Ответ только по данным графика: тренд, зоны, уровни. Без прогнозов и советов." },
  { t: "Скринер", p: "Какие монеты ближе всего к зоне: фильтры по тренду, волатильности, funding и открытому интересу." },
];

const PLANS = [
  { name: "Free", code: "free", per: "", cta: "Начать бесплатно", href: "/register", hot: false, items: ["Все индикаторы и инструменты рисования", "Автоматическая разметка", "Таймфреймы от 1 часа", "10 рисунков на монету, 3 алерта"] },
  { name: "Pro", code: "pro", per: "/ мес", cta: "Оформить Pro", href: "/register", hot: true, items: ["Таймфреймы 1, 5 и 15 минут", "100 рисунков на монету и синхронизация", "5 раскладок, 50 алертов", "Экспорт и журнал без ограничений"] },
  { name: "Premium", code: "premium", per: "/ мес", cta: "Выбрать Premium", href: "/pricing", hot: false, items: ["Всё из Pro", "Вопросы о графике", "Рисунки и алерты без лимита, 20 раскладок", "API и вебхуки"] },
];

const PANE_LABEL = { overlay: "на графике", separate: "панель", derivatives: "деривативы" } as const;

export default async function Home() {
  const t = await getT();
  const [health, instruments, prices] = await Promise.all([getHealth(), getInstrumentCount(), getMonthPrices()]);
  const coins = instruments ?? 59;
  // Цена из API без «.00»: 9.00 → $9; если API недоступен, карточка показывает только название.
  const priceOf = (code: string) => (code === "free" ? "$0" : prices?.[code] ? `$${Number(prices[code])}` : "");

  return (
    <>
      <Header />
      <main className={s.page}>
        {/* Первый экран */}
        <section className={s.hero} aria-labelledby="h-title">
          <div className="container">
            <span className={s.kick}>{t("Крипто-график для технического анализа")}</span>
            <h1 id="h-title" className={`serif ${s.h1}`}>
              {t("Технический анализ.")}
              <br />
              <em>{t("Без рутины.")}</em>
            </h1>
            <p className={s.sub}>
              {t("{i} индикаторов, {d} инструментов рисования и автоматическая разметка: уровни, зоны OB и FVG, структура рынка и карта ликвидаций. {n} монет Binance — в браузере и на телефоне.", { i: COUNTS.indicators, d: COUNTS.tools, n: coins })}
            </p>
            <div className={s.cta}>
              <Link href="/chart/BTCUSDT/4h" className={`${s.pill} ${s.acc} ${s.lg}`}>
                {t("Открыть график")}
              </Link>
              <a href="#features" className={`${s.pill} ${s.ghost} ${s.lg}`}>
                {t("Все возможности")}
              </a>
            </div>
            <p className={s.note}>{t("Бесплатно. Без регистрации и установки.")}</p>
            <div className={s.stage}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className={s.shot} src="/landing/hero.webp" width={1380} height={759} alt={t("Терминал PlatformSol: график BTCUSDT с Фибоначчи, линией тренда, уровнями и картой ликвидаций")} />
            </div>
          </div>
        </section>

        {/* Цифры */}
        <div className="container">
          <dl className={s.stats}>
            <div>
              <dd>{COUNTS.indicators}</dd>
              <dt>{t("индикаторов")}</dt>
            </div>
            <div>
              <dd>{COUNTS.tools}</dd>
              <dt>{t("инструментов рисования")}</dt>
            </div>
            <div>
              <dd>{COUNTS.layers}</dd>
              <dt>{t("слоёв автоанализа")}</dt>
            </div>
            <div>
              <dd>{COUNTS.figures}</dd>
              <dt>{t("графических фигур")}</dt>
            </div>
            <div>
              <dd>{COUNTS.timeframes}</dd>
              <dt>{t("таймфреймов, от 1 минуты до недели")}</dt>
            </div>
          </dl>
        </div>

        {/* Рисование */}
        <section id="features" className={`container ${s.sec}`} aria-labelledby="h-draw">
          <div className={s.head}>
            <span className={s.kick}>{t("Рисование")}</span>
            <h2 id="h-draw" className="serif">{t("Рисуйте, как в профессиональном терминале")}</h2>
            <p>{t("Трендовые линии, каналы, Фибоначчи, позиции с риском и прибылью. Магнит цепляет линию к цене открытия, закрытия, максимуму или минимуму свечи.")}</p>
          </div>
          <div className={s.big}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/landing/draw.webp" width={1340} height={789} alt={t("Ручная разметка: Фибоначчи, линия тренда, Bollinger Bands, RSI и MACD")} loading="lazy" />
          </div>
          <ul className={s.tools}>
            {TOOL_GROUPS.map((g) => (
              <li key={g.name}>
                {t(g.name)}
                <small>{t(g.note)}</small>
              </li>
            ))}
          </ul>
          <div className={s.extras}>
            {EXTRAS.map(([b, rest]) => (
              <span key={b}>
                <b>{t(b)}</b> {t(rest)}
              </span>
            ))}
          </div>
        </section>

        {/* Индикаторы */}
        <section className={`container ${s.sec} ${s.ind}`} aria-labelledby="h-ind">
          <div className={s.head}>
            <span className={s.kick}>{t("Индикаторы")}</span>
            <h2 id="h-ind" className="serif">{t("Классика теханализа в один клик")}</h2>
            <p>{t("Наложение на график или отдельная панель под ним. Цвета закреплены за индикаторами, поэтому их легко различать.")}</p>
            <div className={s.tpl}>
              <div>
                <b>{t("Шаблон «Осцилляторы»")}</b>RSI + MACD + Stochastic
              </div>
              <div>
                <b>{t("Шаблон «Деривативы»")}</b>
                {t("EMA 50 + Funding + Open interest + ликвидации")}
              </div>
            </div>
          </div>
          <ul className={s.grid}>
            {INDICATOR_LIST.map((i) => (
              <li key={i.name}>
                <b>{i.name}</b>
                <span>{t(PANE_LABEL[i.pane])}</span>
              </li>
            ))}
            {DERIVATIVE_PANELS.map((name) => (
              <li key={name} className={s.deriv}>
                <b>{t(name)}</b>
                <span>{t(PANE_LABEL.derivatives)}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* Автоматическая разметка */}
        <section className={`container ${s.sec}`} aria-labelledby="h-auto">
          <div className={`${s.head} ${s.center}`}>
            <span className={s.kick}>{t("Автоматическая разметка")}</span>
            <h2 id="h-auto" className="serif">
              {t("То, на что уходят часы, —")} <em>{t("уже на графике")}</em>
            </h2>
            <p>{t("Слои анализа включаются одной кнопкой «Слои». Всё найденное собрано в списке с ценами.")}</p>
          </div>
          <div className={s.bento}>
            <article className={`${s.tile} ${s.w3} ${s.liq}`}>
              <div className={s.tt}>
                <h3>{t("Карта ликвидаций с суммами")}</h3>
                <p>{t("Где скопились позиции с плечом. Оценка по приросту открытого интереса и объёму.")}</p>
              </div>
              <div className={s.img}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/landing/liq.webp" width={900} height={1340} alt="" loading="lazy" />
              </div>
            </article>
            <article className={`${s.tile} ${s.w3} ${s.lv}`}>
              <div className={s.tt}>
                <h3>{t("Поддержка, сопротивление и зоны")}</h3>
                <p>{t("Уровни по касаниям, ордер-блоки, имбалансы FVG, зоны спроса и предложения.")}</p>
              </div>
              <div className={s.img}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/landing/levels.webp" width={600} height={1200} alt="" loading="lazy" />
              </div>
            </article>
            <article className={`${s.tile} ${s.w4} ${s.st}`}>
              <div className={s.tt}>
                <h3>{t("Структура рынка")}</h3>
                <p>{t("Слом структуры BOS, смена характера CHoCH, снятие ликвидности и равные максимумы EQH.")}</p>
              </div>
              <div className={s.img}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/landing/structure.webp" width={840} height={420} alt="" loading="lazy" />
              </div>
            </article>
            <article className={`${s.tile} ${s.w2} ${s.vp}`}>
              <div className={s.tt}>
                <h3>{t("Профиль объёма")}</h3>
                <p>{t("Где прошло больше всего объёма, уровень POC и зона стоимости 70 %.")}</p>
              </div>
              <div className={s.img}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/landing/vp.webp" width={800} height={1240} alt="" loading="lazy" />
              </div>
            </article>
            <article className={`${s.tile} ${s.w6}`}>
              <div className={s.tt}>
                <h3>{t("Свечные паттерны и графические фигуры")}</h3>
                <p>{t("Фигуры — с расчётной целью и уровнем отмены, паттерны — с историей отработки.")}</p>
              </div>
              <div className={s.chips}>
                {PATTERNS.map((p) => (
                  <span key={p}>{t(p)}</span>
                ))}
              </div>
            </article>
          </div>
        </section>

        {/* Рабочее место */}
        <section className={`container ${s.sec}`} aria-labelledby="h-work">
          <div className={s.head}>
            <span className={s.kick}>{t("Рабочее место")}</span>
            <h2 id="h-work" className="serif">{t("Несколько рынков сразу — и с собой в кармане")}</h2>
          </div>
          <div className={s.duo}>
            <article className={s.tile}>
              <div className={s.tt}>
                <h3>{t("Мультичарт")}</h3>
                <p>{t("2 или 4 графика на экране, у каждого своя монета и таймфрейм.")}</p>
              </div>
              <div className={`${s.img} ${s.pad}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/landing/multi.webp" width={1380} height={905} alt="" loading="lazy" />
              </div>
            </article>
            <article className={s.tile}>
              <div className={s.tt}>
                <h3>{t("На телефоне")}</h3>
                <p>{t("Полноценный график, а не урезанная версия.")}</p>
              </div>
              <div className={s.phone}>
                <div className={s.dev}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/landing/phone.webp" width={390} height={844} alt="" loading="lazy" />
                </div>
              </div>
              <ul className={s.phoneList}>
                <li>{t("масштаб двумя пальцами")}</li>
                <li>{t("удержание пальца — перекрестие с ценой")}</li>
                <li>{t("рисование и индикаторы снизу")}</li>
              </ul>
            </article>
          </div>
          <div className={s.more}>
            {MORE.map((m) => (
              <div key={m.t}>
                <b>{t(m.t)}</b>
                <p>{t(m.p)}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Тарифы */}
        <section id="pricing" className={`container ${s.sec}`} aria-labelledby="h-pricing">
          <div className={`${s.head} ${s.center}`}>
            <span className={s.kick}>{t("Подписка")}</span>
            <h2 id="h-pricing" className="serif">{t("Начните бесплатно")}</h2>
            <p>{t("Оплата криптовалютой, без автопродления. Пока оплата не включена, все зарегистрированные пользователи получают уровень Pro.")}</p>
          </div>
          <div className={s.plans}>
            {PLANS.map((p) => (
              <article key={p.name} className={s.plan} data-hot={p.hot || undefined}>
                <h3>
                  {p.name}
                  {p.hot && <span>{t("Популярный")}</span>}
                </h3>
                <p className={s.price}>
                  {priceOf(p.code)} {p.per && priceOf(p.code) && <small>{t(p.per)}</small>}
                </p>
                <ul>
                  {p.items.map((it) => (
                    <li key={it}>{t(it)}</li>
                  ))}
                </ul>
                <Link href={p.href} className={`${s.pill} ${p.hot ? s.acc : s.line}`}>
                  {t(p.cta)}
                </Link>
              </article>
            ))}
          </div>
        </section>

        {/* Вопросы */}
        <section id="faq" className={`container ${s.sec} ${s.faqSection}`} aria-labelledby="h-faq">
          <div className={s.head}>
            <span className={s.kick}>{t("Вопросы")}</span>
            <h2 id="h-faq" className="serif">{t("Вопросы и ответы")}</h2>
          </div>
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
        <section className={`container ${s.final}`}>
          <h2 className="serif">
            {t("Откройте график")}
            <br />
            <em>{t("прямо сейчас")}</em>
          </h2>
          <p>{t("Регистрация не нужна.")}</p>
          <Link href="/chart/BTCUSDT/4h" className={`${s.pill} ${s.acc} ${s.lg}`}>
            {t("Открыть график BTC")}
          </Link>
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
