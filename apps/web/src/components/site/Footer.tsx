import Link from "next/link";
import s from "./Footer.module.css";

export const DISCLAIMER =
  "Информация носит образовательный и информационный характер, не является индивидуальной инвестиционной рекомендацией. Торговля криптовалютами и производными инструментами связана с риском потери всех средств. Прошлые результаты не гарантируют будущих.";

export function Footer({ status }: { status?: string }) {
  return (
    <footer className={s.footer}>
      <div className="container">
        <div className={s.cols}>
          <p className={s.disclaimer}>{DISCLAIMER}</p>
          <ul>
            <li>
              <Link href="/#rules">Правила системы</Link>
            </li>
            <li>
              <Link href="/stats">Статистика</Link>
            </li>
            <li>
              <Link href="/pricing">Тарифы</Link>
            </li>
            <li>
              <Link href="/#faq">Вопросы и ответы</Link>
            </li>
            <li>
              <Link href="/status">Статус системы</Link>
            </li>
          </ul>
          <ul>
            <li>Условия использования — готовятся</li>
            <li>Политика конфиденциальности — готовится</li>
            <li>Telegram-бот — после запуска</li>
            <li>18+</li>
          </ul>
        </div>
        <div className={s.meta}>
          <span>Platform. Данные: Binance (публичные). График: TradingView Lightweight Charts.</span>
          <span>{status ?? ""}</span>
        </div>
      </div>
    </footer>
  );
}
