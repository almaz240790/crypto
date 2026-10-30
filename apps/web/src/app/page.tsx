import type { Metadata } from "next";
import Link from "next/link";
import { Footer, Header } from "@/components/site";
import { HeroLine } from "@/components/landing/HeroLine";
import { DeskTools } from "@/components/landing/DeskTools";
import { LineArt, Thumb } from "@/components/landing/LineArt";
import { getDailyCloses, getHealth, getInstrumentCount } from "@/lib/api";
import { COUNTS } from "@/lib/capabilities";
import s from "./page.module.css";
import { getT } from "@/i18n/server";

// Рендер на каждый запрос (данные fetch кэшируются): при сборке образа API недоступен.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "PlatformSol — крипто-график для технического анализа",
  description:
    "Индикаторы, инструменты рисования и автоматическая разметка: уровни, зоны OB и FVG, структура рынка и карта ликвидаций. Монеты Binance — в браузере и на телефоне.",
};

/**
 * Главная (ADR-0006): порядок и сетка блоков — по образцу robinhood.com по просьбе владельца,
 * содержание, изображения и тексты — свои. Цвета блоков — токены --lp-*, не зависят от темы.
 */

const TRUST = [
  { art: "candles", t: "Разметка не перерисовывается задним числом." },
  { art: "data", t: "Данные напрямую с Binance Futures." },
  { art: "rings", t: "Двухфакторная защита аккаунта." },
  { art: "loupe", t: "Без обещаний доходности — только инструмент анализа." },
] as const;

const BASICS = [
  { thumb: "ob", t: "Что такое ордер-блок?", p: "Зона, откуда цена ушла импульсом и куда часто возвращается" },
  { thumb: "fvg", t: "Что такое FVG?", p: "Разрыв между свечами, который цена нередко заполняет" },
  { thumb: "choch", t: "Что такое CHoCH?", p: "Первый признак того, что тренд меняет направление" },
] as const;

function Chevron() {
  return (
    <svg width="10" height="16" viewBox="0 0 10 16" aria-hidden="true">
      <path d="M2 2l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

export default async function Home() {
  const t = await getT();
  const [health, instruments, closes] = await Promise.all([getHealth(), getInstrumentCount(), getDailyCloses()]);
  const coins = instruments ?? 59;

  return (
    <>
      <Header />
      <main className={s.page}>
        {/* Полоса-объявление */}
        <p className={s.promo}>
          <b>{t("Новое:")}</b>{" "}
          <Link href="/chart/BTCUSDT/4h">{t("карта ликвидаций с суммами в долларах — прямо на графике")}</Link>. {t("Бесплатно, без регистрации.")}
        </p>

        {/* Первый экран */}
        <section className={s.hero} aria-labelledby="h-title">
          <HeroLine closes={closes} />
          <div className={s.heroText}>
            <h1 id="h-title" className={s.h1}>
              {t("Технический анализ")}
              <br />
              {t("в одном окне")}
            </h1>
            <p className={s.heroSub}>
              {t("{i} индикаторов, {d} инструментов рисования и автоматическая разметка: уровни, зоны, структура рынка и карта ликвидаций. {n} монет Binance — бесплатно.", { i: COUNTS.indicators, d: COUNTS.tools, n: coins })}
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
                <img src="/landing/multi.webp" width={1380} height={905} alt={t("Мультичарт PlatformSol: четыре графика с автоматической разметкой")} />
              </div>
            </div>
          </div>
          <div className={`${s.copy} ${s.right}`}>
            <h3 className={s.kickLime}>{t("Всё для теханализа")}</h3>
            <h2 id="h-tools" className={s.h2}>
              {t("Разметка, индикаторы и рынок — в одном окне")}
            </h2>
            <p>{t("{i} индикаторов, {d} инструментов рисования, мультичарт на 4 графика и алерты прямо с графика.", { i: COUNTS.indicators, d: COUNTS.tools })}</p>
            <Link href="/chart/BTCUSDT/4h" className={`${s.pill} ${s.lime}`}>
              {t("Открыть график")}
            </Link>
            <p className={s.fine}>{t("Данные: Binance Futures. Информация не является инвестиционной рекомендацией.")}</p>
          </div>
        </section>

        {/* 2. «Слои» на светлом камне — текст справа */}
        <section className={`${s.band} ${s.stone}`} aria-labelledby="h-auto">
          <div className={`${s.visual} ${s.cards}`}>
            <span className={s.beam} aria-hidden="true" />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className={s.cardLiq} src="/landing/liq.webp" width={900} height={1340} alt={t("Карта ликвидаций с суммами на графике BTCUSDT")} loading="lazy" />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className={s.cardLv} src="/landing/levels.webp" width={600} height={1200} alt={t("Список уровней, зон и ликвидаций с ценами")} loading="lazy" />
          </div>
          <div className={`${s.copy} ${s.right} ${s.dark}`}>
            <p className={s.lockup}>
              <span className={s.mark} aria-hidden="true" />
              <b>PlatformSol</b> {t("Разметка")}
            </p>
            <h2 id="h-auto" className={s.h2}>
              {t("Уровни, зоны и ликвидации — сами")}
            </h2>
            <p>{t("Поддержка и сопротивление по касаниям, ордер-блоки, FVG, зоны спроса и предложения, сломы структуры и карта ликвидаций с суммами. Всё найденное — в списке с ценами.")}</p>
            <p className={s.info}>
              <span aria-hidden="true">i</span>
              {t("Карта ликвидаций — расчётная оценка, а не данные биржи")}
            </p>
            <Link href="/chart/BTCUSDT/4h" className={`${s.pill} ${s.ink}`}>
              {t("Посмотреть на BTC")}
            </Link>
            <p className={s.fine}>{t("Разметка строится только по закрытым свечам.")}</p>
          </div>
        </section>

        {/* 3. «Рассвет» с телефоном — текст слева */}
        <section className={`${s.band} ${s.dawn}`} aria-labelledby="h-phone">
          <div className={`${s.copy} ${s.left}`}>
            <p className={s.lockup}>
              <span className={s.mark} aria-hidden="true" />
              <b>PlatformSol</b> {t("Мобильный")}
            </p>
            <h2 id="h-phone" className={s.h2}>
              {t("Полноценный график в кармане")}
            </h2>
            <p>{t("Масштаб двумя пальцами, перекрестие по удержанию пальца, рисование и индикаторы из нижней панели. Ничего не нужно устанавливать — сайт можно добавить на главный экран.")}</p>
            <p>{t("Работает в любом современном браузере.")}</p>
            <Link href="/chart/BTCUSDT/4h" className={`${s.pill} ${s.lime}`}>
              {t("Открыть на телефоне")}
            </Link>
            <p className={s.fine}>{t("На скриншоте — BTCUSDT, 4 часа, с картой ликвидаций и структурой рынка.")}</p>
          </div>
          <div className={`${s.visual} ${s.deco}`} aria-hidden="true">
            <span className={s.horizon} />
            <span className={s.sun} />
            <span className={s.glint} />
          </div>
          <div className={`${s.visual} ${s.phoneWrap}`}>
            <div className={s.phone}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/landing/phone.webp" width={390} height={844} alt={t("График PlatformSol на телефоне")} loading="lazy" />
            </div>
          </div>
        </section>

        {/* 4. Доверие — тёмный блок, 2×2 */}
        <section className={s.trust} aria-labelledby="h-trust">
          <h2 id="h-trust" className={s.h2c}>
            {t("Честный инструмент")}
            <br />
            {t("без перерисовки")}
          </h2>
          <ul>
            {TRUST.map((i) => (
              <li key={i.art}>
                <LineArt name={i.art} />
                <p>{t(i.t)}</p>
              </li>
            ))}
          </ul>
        </section>

        {/* 5. Основы — салатовый блок с карточкой */}
        <section className={s.learn} aria-labelledby="h-learn">
          <h2 id="h-learn" className={s.h2c}>
            {t("Читайте график увереннее —")}
            <br />
            {t("прямо на графике")}
          </h2>
          <p>{t("Найденные паттерны и фигуры — с пояснением и историей отработки. Вот с чего начать.")}</p>
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
                    <span>{t(b.p)}</span>
                  </div>
                  <Chevron />
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* 6. Призыв — «Восход»: солнце встаёт из-за горизонта, проявляются линии уровней */}
        <section className={s.final} aria-labelledby="h-final">
          <div className={s.rise} aria-hidden="true">
            {[18, 34, 52, 66].map((top, i) => (
              <span key={top} className={s.line} style={{ top: `${top}%`, animationDelay: `${i * 1.6}s` }} />
            ))}
            <span className={s.ground} />
            <span className={s.halo} />
            <span className={s.disc} />
          </div>
          <h2 id="h-final" className={s.h1}>
            {t("Откройте график")}
            <br />
            {t("прямо сейчас")}
          </h2>
          <Link href="/chart/BTCUSDT/4h" className={`${s.pill} ${s.lime}`}>
            {t("Открыть график")}
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
