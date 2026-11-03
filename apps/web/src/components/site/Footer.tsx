"use client";

import Link from "next/link";
import s from "./Footer.module.css";
import { useT } from "@/i18n/client";

export const DISCLAIMER =
  "Информация носит образовательный и информационный характер, не является индивидуальной инвестиционной рекомендацией. Торговля криптовалютами и производными инструментами связана с риском потери всех средств. Прошлые результаты не гарантируют будущих.";

const COLUMNS: { title: string; links: { href: string; label: string }[] }[] = [
  {
    title: "Продукт",
    links: [
      { href: "/chart", label: "График" },
      { href: "/multichart", label: "Мультичарт" },
      { href: "/screener", label: "Скринер" },
      { href: "/alerts", label: "Алерты" },
      { href: "/pricing", label: "Подписка" },
    ],
  },
  {
    title: "Помощь",
    links: [
      { href: "/support", label: "Вопросы и ответы" },
      { href: "/support", label: "Поддержка" },
      { href: "/status", label: "Статус системы" },
      { href: "/api-docs", label: "Документация API" },
    ],
  },
  {
    title: "Аккаунт",
    links: [
      { href: "/login", label: "Войти" },
      { href: "/register", label: "Регистрация" },
      { href: "/settings", label: "Настройки" },
      { href: "/billing", label: "Оплата" },
    ],
  },
];

/** Подвал: салатовый, колонки ссылок, правовой текст справа и крупное название внизу (сетка по образцу robinhood.com, ADR-0006). */
export function Footer({ status }: { status?: string }) {
  const t = useT();
  return (
    <footer className={s.footer}>
      <div className={s.top}>
        <div className={s.quick}>
          <Link href="/status">{t("Статус системы")}</Link>
          <Link href="/api-docs">{t("Документация API")}</Link>
        </div>
        <p className={s.attrib}>
          {t("Данные: Binance")} · {t("Графики:")}{" "}
          <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">
            TradingView Lightweight Charts™
          </a>
        </p>
      </div>
      <div className={s.body}>
        <div className={s.cols}>
          {COLUMNS.map((c) => (
            <div key={c.title}>
              <h3>{t(c.title)}</h3>
              <ul>
                {c.links.map((l) => (
                  <li key={l.label}>
                    <Link href={l.href}>{t(l.label)}</Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className={s.legal}>
          <p>
            <b>{t("Торговля связана с риском.")}</b>
          </p>
          <p>{t(DISCLAIMER)}</p>
          <p>
            <b>{t("Карта ликвидаций")}</b> {t("— расчётная оценка по приросту открытого интереса, а не данные биржи.")}
          </p>
          <p>
            <b>{t("Структура, зоны и паттерны")}</b> {t("строятся по детерминированным правилам только по закрытым свечам и не перерисовываются задним числом. Уровни поддержки и сопротивления и карта ликвидаций пересчитываются с каждой новой свечой.")}
          </p>
          {status && <p>{status}</p>}
          <p>© 2026 PlatformSol · 18+</p>
        </div>
      </div>
      <svg className={s.word} viewBox="0 0 1000 190" role="img" aria-label="PlatformSol">
        <text x="0" y="158" textLength="1000" lengthAdjust="spacingAndGlyphs">
          PlatformSol
        </text>
      </svg>
    </footer>
  );
}
