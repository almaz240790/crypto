import type { Metadata } from "next";
import { Pricing } from "@/components/billing/Pricing";
import { Footer, Header } from "@/components/site";
import { getT } from "@/i18n/server";

export const metadata: Metadata = {
  title: "Тарифы",
  description: "Free, Pro и Premium. Оплата криптовалютой на 1, 3 или 12 месяцев без автопродления. 7 дней Pro бесплатно.",
};

export default async function PricingPage() {
  const t = await getT();
  return (
    <>
      <Header />
      <main className="container" style={{ padding: "24px 0", display: "grid", gap: 16 }}>
        <div>
          <h1>{t("Тарифы")}</h1>
          <p className="text-2">{t("Логика сигналов одинакова на всех тарифах. Различаются скорость доступа, набор инструментов и глубина инструментов.")}</p>
        </div>
        <Pricing />
        <p className="caption">{t("Оплата только криптовалютой: USDT (TRC20, ERC20, BEP20, TON), USDC, BTC, ETH, TON. Возврат первой оплаты — в течение 7 дней по правилам оферты. Информация не является инвестиционной рекомендацией.")}</p>
      </main>
      <Footer />
    </>
  );
}
