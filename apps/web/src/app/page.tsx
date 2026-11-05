import type { Metadata } from "next";
import Link from "next/link";
import { Footer, Header } from "@/components/site";
import { HeroLine } from "@/components/landing/HeroLine";
import { DeskTools } from "@/components/landing/DeskTools";
import { LineArt, Thumb } from "@/components/landing/LineArt";
import { getDailyCloses, getHealth, getInstrumentCount } from "@/lib/api";
import { COUNTS } from "@/lib/capabilities";
import { nb, plural } from "@/lib/format";
import s from "./page.module.css";
import { getT } from "@/i18n/server";

// Рендер на каждый запрос (данные fetch кэшируются): при сборке образа API недоступен.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return {
    title: t("PlatformSol — крипто-график для технического анализа"),
    description: t("Индикаторы, инструменты рисования и автоматическая разметка: поддержка и сопротивление, зоны спроса и предложения (ордер-блоки и FVG), пробои структуры и карта ликвидаций. Монеты Binance — в браузере и на телефоне."),
  };
}

/**
 * Главная (ADR-0006): порядок и сетка блоков — по образцу robinhood.com по просьбе владельца,
 * содержание, изображения и тексты — свои. Цвета блоков — токены --lp-*, не зависят от темы.
 * Кнопка «Открыть график» — одна, на первом экране. Названия разметки — как на графике (packages/charts
 * scene/text.ts): «Поддержка», «Сопротивление», «Спрос», «Предложение», «Пробой», «Смена», «Ликвидации».
 * Картинки public/landing/*.webp — снимки production (гость, тёмная тема); подписи и alt описывают ровно их.
 * В имени картинки — начало sha256 содержимого (landingImages.test.ts): Cloudflare кэширует /landing/* на 4 часа,
 * поэтому новый снимок — всегда новое имя, иначе рядом с новыми подписями браузер покажет старую картинку.
 */

const TRUST = [
  { art: "candles", t: "Структура, зоны и паттерны не перерисовываются." },
  { art: "data", t: "Данные напрямую с Binance Futures." },
  { art: "rings", t: "Двухфакторная защита аккаунта." },
  { art: "loupe", t: "Без обещаний доходности — только инструмент анализа." },
] as const;

/** Классические сокращения и то, как они подписаны на графике. */
const BASICS = [
  { thumb: "ob", t: "Что такое ордер-блок (OB)?", p: "Зона, откуда цена ушла импульсом и может к ней вернуться. На графике — зона «Спрос» или «Предложение»" },
  { thumb: "fvg", t: "Что такое FVG?", p: "Разрыв цены между свечами, который цена может заполнить. На графике — тоже зона «Спрос» или «Предложение»" },
  { thumb: "choch", t: "Что такое CHoCH?", p: "Первый пробой против прежнего движения — возможная смена направления. На графике — метка «Смена ↑» или «Смена ↓»" },
] as const;

export default async function Home() {
  const t = await getT();
  const [health, instruments, closes] = await Promise.all([getHealth(), getInstrumentCount(), getDailyCloses()]);
  const coins = instruments;

  return (
    <>
      <Header chartCta={false} />
      <main className={s.page}>
        {/* Полоса-объявление */}
        <p className={s.promo}>
          <b>{t("Новое:")}</b>{" "}
          <Link href="/chart/BTCUSDT/4h">{t("цена прямо с биржи в реальном времени")}</Link>; {t("позиция Long/Short — одним нажатием.")} {t("Бесплатно, без регистрации.")}
        </p>

        {/* Первый экран */}
        <section className={s.hero} aria-labelledby="h-title">
          <HeroLine closes={closes} />
          <div className={s.heroText}>
            <h1 id="h-title" className={s.h1}>
              {t("Технический анализ.")}
              <br />
              {t("Без рутины.")}
            </h1>
            <p className={s.heroSub}>
              {nb(t("{i} индикаторов, {d} инструментов рисования, авторазметка: поддержка и сопротивление, зоны спроса и предложения, ликвидации.", { i: COUNTS.indicators, d: COUNTS.tools }))}{" "}
              {coins !== null &&
                nb(t(plural(coins, "{n} монета Binance — бесплатно.", "{n} монеты Binance — бесплатно.", "{n} монет Binance — бесплатно."), { n: coins }))}
            </p>
            <Link href="/chart/BTCUSDT/4h" className={`${s.pill} ${s.lime}`}>
              {t("Открыть график")}
            </Link>
          </div>
        </section>

        {/* 1. «Стол картографа» — текст справа */}
        <section id="features" className={`${s.band} ${s.mat}`} aria-labelledby="h-tools">
          <div className={s.visual}>
            <div className={s.desk}>
              <DeskTools />
              <div className={s.tablet}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/landing/multi.8073678b.webp" width={2000} height={1312} alt={t("Мультичарт PlatformSol: четыре графика — BTCUSDT и ETHUSDT на 4 часах, SOLUSDT и BNBUSDT на 1 дне — с поддержкой, сопротивлением и зонами спроса")} loading="lazy" />
              </div>
            </div>
          </div>
          <div className={`${s.copy} ${s.right}`}>
            <div className={s.kickLime}>{t("Всё для теханализа")}</div>
            <h2 id="h-tools" className={s.h2}>
              {nb(t("Разметка, индикаторы и рынок — в одном окне"))}
            </h2>
            <p>{nb(t("{i} индикаторов, {d} инструментов рисования, мультичарт на 4 графика и алерты прямо с графика.", { i: COUNTS.indicators, d: COUNTS.tools }))}</p>
            <p className={s.fine}>{t("На снимке — мультичарт на 4 графика с разметкой «Компактный». Данные: Binance Futures. Информация не является инвестиционной рекомендацией.")}</p>
          </div>
        </section>

        {/* 2. «Слои» на светлом камне — текст справа */}
        <section className={`${s.band} ${s.stone}`} aria-labelledby="h-auto">
          <div className={`${s.visual} ${s.cards}`}>
            <span className={s.beam} aria-hidden="true" />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className={s.cardLiq} src="/landing/liq.cc9bf925.webp" width={900} height={1340} alt={t("График BTCUSDT, 4 часа, разметка «Карта ликвидаций»: полоса ликвидаций у шкалы цен с расчётными суммами в долларах, линии поддержки и сопротивления")} loading="lazy" />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className={s.cardLv} src="/landing/levels.d87a7c31.webp" width={600} height={1200} alt={t("Список «Уровни» на панели «Найдено»: сопротивление, поддержка, максимумы и минимумы дня и недели, зоны спроса — с ценой и расстоянием до неё")} loading="lazy" />
          </div>
          <div className={`${s.copy} ${s.right}`}>
            <p className={s.lockup}>
              <span className={s.mark} aria-hidden="true" />
              <b>PlatformSol</b> {t("Разметка")}
            </p>
            <h2 id="h-auto" className={s.h2}>
              {nb(t("Уровни, зоны и ликвидации — сами"))}
            </h2>
            <p>{nb(t("Поддержка и сопротивление по касаниям, зоны спроса и предложения, пробои и смены направления, карта ликвидаций — и список найденного с ценами."))}</p>
            <p className={s.info}>
              <span aria-hidden="true">i</span>
              {nb(t("Карта ликвидаций — расчётная оценка, а не данные биржи"))}
            </p>
            <p className={s.fine}>{t("На снимках — BTCUSDT, 4 часа: разметка «Карта ликвидаций» и список «Уровни». Структура и зоны строятся только по закрытым свечам.")}</p>
          </div>
        </section>

        {/* 3. Телефон на тёмном градиенте — текст слева */}
        <section className={`${s.band} ${s.dawn}`} aria-labelledby="h-phone">
          <div className={`${s.copy} ${s.left}`}>
            <p className={s.lockup}>
              <span className={s.mark} aria-hidden="true" />
              <b>PlatformSol</b> {t("Мобильный")}
            </p>
            <h2 id="h-phone" className={s.h2}>
              {nb(t("Полноценный график в кармане"))}
            </h2>
            <p>{nb(t("Масштаб двумя пальцами, перекрестие по удержанию пальца, рисование и индикаторы из нижней панели. Ничего не нужно устанавливать — сайт можно добавить на главный экран."))}</p>
            <p>{t("Работает в любом современном браузере.")}</p>
            <p className={s.fine}>{t("На скриншоте — BTCUSDT, 4 часа, разметка «Уровни и зоны»: сопротивление, поддержка, зона спроса и максимум вчерашнего дня.")}</p>
          </div>
          <div className={`${s.visual} ${s.phoneWrap}`}>
            <div className={s.phone}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/landing/phone.ce7c3325.webp" width={390} height={844} alt={t("График BTCUSDT на телефоне: разметка «Уровни и зоны», цена в реальном времени и нижняя панель с кнопками")} loading="lazy" />
            </div>
          </div>
        </section>

        {/* 4. Основы — салатовый блок с карточкой; низ карточки уходит под тёмный блок «доверия» */}
        <section className={s.learn} aria-labelledby="h-learn">
          <h2 id="h-learn" className={s.h2c}>
            {nb(t("Читайте график увереннее —"))}
            <br />
            {t("прямо на графике")}
          </h2>
          <p>{nb(t("Найденные паттерны и фигуры — с пояснением и историей отработки. Вот с чего начать."))}</p>
          <Link href="/register" className={`${s.pill} ${s.ink}`}>
            {t("Зарегистрироваться")}
          </Link>
          <div className={s.card}>
            <h3>{t("Основы разметки")}</h3>
            <ul>
              {BASICS.map((b) => (
                <li key={b.thumb}>
                  <Thumb name={b.thumb} />
                  <div>
                    <b>{t(b.t)}</b>
                    <span>{nb(t(b.p))}</span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* 5. Доверие — тёмный блок перед подвалом: 2×2, на телефоне — список строками */}
        <section className={s.trust} aria-labelledby="h-trust">
          <h2 id="h-trust" className={s.h2c}>
            {nb(t("Честный инструмент —"))}
            <br />
            {t("структура без перерисовки")}
          </h2>
          <ul aria-labelledby="h-trust">
            {TRUST.map((i) => (
              <li key={i.art}>
                <LineArt name={i.art} />
                <p>{nb(t(i.t))}</p>
              </li>
            ))}
          </ul>
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
