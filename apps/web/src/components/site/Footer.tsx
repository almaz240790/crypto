"use client";

import Link from "next/link";
import { Logo } from "./Logo";
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
          <div className={s.about}>
            <Logo />
            <p>{t(DISCLAIMER)}</p>
          </div>
          <div>
            <h3>{t("Продукт")}</h3>
            <ul>
              <li>
                <Link href="/chart">{t("График")}</Link>
              </li>
              <li>
                <Link href="/screener">{t("Скринер")}</Link>
              </li>
              <li>
                <Link href="/pricing">{t("Подписка")}</Link>
              </li>
            </ul>
          </div>
          <div>
            <h3>{t("Помощь")}</h3>
            <ul>
              <li>
                <Link href="/#faq">{t("Вопросы и ответы")}</Link>
              </li>
              <li>
                <Link href="/support">{t("Поддержка")}</Link>
              </li>
              <li>
                <Link href="/status">{t("Статус системы")}</Link>
              </li>
              <li>
                <Link href="/api-docs">{t("Документация API")}</Link>
              </li>
            </ul>
          </div>
        </div>
        <div className={s.meta}>
          <span>
            © 2026 PlatformSol · {t("Данные: Binance")} · {t("Графики:")}{" "}
            <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">
              TradingView Lightweight Charts™
            </a>{" "}
            · 18+
          </span>
          {status && <span>{status}</span>}
        </div>
      </div>
    </footer>
  );
}
