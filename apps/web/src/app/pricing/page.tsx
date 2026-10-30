import type { Metadata } from "next";
import { Pricing } from "@/components/billing/Pricing";
import { Footer, Header } from "@/components/site";
import { getT } from "@/i18n/server";
import s from "./page.module.css";

export const metadata: Metadata = {
  title: "Тарифы",
  description: "Free, Pro и Premium для крипто-графика с теханализом. Оплата криптовалютой на 1, 3 или 12 месяцев без автопродления. 7 дней Pro бесплатно.",
};

export default async function PricingPage() {
  const t = await getT();
  return (
    <>
      <Header />
      <main className={`container ${s.main}`}>
        <header className={s.head}>
          <h1 className="serif">{t("Тарифы")}</h1>
          <p>{t("Все индикаторы, рисование и автоматическая разметка доступны бесплатно. Платные тарифы добавляют минутные таймфреймы, больше рисунков и алертов, синхронизацию и API.")}</p>
        </header>
        <Pricing />
        <p className={s.note}>{t("Оплата только криптовалютой: USDT (TRC20, ERC20, BEP20, TON), USDC, BTC, ETH, TON. Возврат первой оплаты — в течение 7 дней по правилам оферты. Информация не является инвестиционной рекомендацией.")}</p>
      </main>
      <Footer />
    </>
  );
}
