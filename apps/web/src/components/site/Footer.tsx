"use client";

import Link from "next/link";
import s from "./Footer.module.css";
import { useT } from "@/i18n/client";

export const DISCLAIMER =
  "Информация носит образовательный и информационный характер, не является индивидуальной инвестиционной рекомендацией. Торговля криптовалютами и производными инструментами связана с риском потери всех средств. Прошлые результаты не гарантируют будущих.";

export function Footer({ status }: { status?: string }) {
  const t = useT();
  return (
    <footer className={s.footer}>
      <div className="container">
        <div className={s.cols}>
          <p className={s.disclaimer}>{DISCLAIMER}</p>
          <ul>
            <li>
              <Link href="/#rules">{t("Правила системы")}</Link>
            </li>
            <li>
              <Link href="/stats">{t("Статистика")}</Link>
            </li>
            <li>
              <Link href="/pricing">{t("Тарифы")}</Link>
            </li>
            <li>
              <Link href="/#faq">{t("Вопросы и ответы")}</Link>
            </li>
            <li>
              <Link href="/status">{t("Статус системы")}</Link>
            </li>
            <li>
              <Link href="/support">{t("Поддержка")}</Link>
            </li>
          </ul>
          <ul>
            <li>{t("Условия использования — готовятся")}</li>
            <li>{t("Политика конфиденциальности — готовится")}</li>
            <li>{t("Telegram-бот — после запуска")}</li>
            <li>18+</li>
          </ul>
        </div>
        <div className={s.meta}>
          <span>
            {t("Platform. Данные: Binance (публичные). График:")}{" "}
            <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">
              TradingView Lightweight Charts™
            </a>
          </span>
          <span>{status ?? ""}</span>
        </div>
      </div>
    </footer>
  );
}
