import type { Metadata } from "next";
import { SupportForm } from "@/components/support/SupportForm";
import { Footer, Header } from "@/components/site";
import { Panel } from "@/components/ui";
import { FAQ } from "@/content/faq";
import { getT } from "@/i18n/server";

export const metadata: Metadata = {
  title: "Поддержка",
  description: "Вопросы и ответы о сервисе и форма обращения. Отвечаем на email, обычно в течение суток.",
};

export default async function SupportPage() {
  const t = await getT();
  return (
    <>
      <Header />
      <main className="container" style={{ padding: "24px 0", display: "grid", gap: 16, maxWidth: 900 }}>
        <div>
          <h1>{t("Поддержка")}</h1>
          <p className="text-2">{t("Сначала посмотрите ответы ниже. Если не нашли — напишите: к обращению сами прикрепятся страница, тариф и версия приложения.")}</p>
        </div>
        <SupportForm />
        <Panel title={t("Вопросы и ответы")} flush>
          <div style={{ padding: "4px 16px" }}>
            {FAQ.map((f) => (
              <details key={f.q} style={{ padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                <summary style={{ cursor: "pointer", fontWeight: 500 }}>{f.q}</summary>
                <p className="text-2" style={{ margin: "8px 0 0" }}>
                  {f.a}
                </p>
              </details>
            ))}
          </div>
        </Panel>
        <p className="caption">{t("Статус движка и бирж — на странице «Статус системы». Чата с оператором пока нет; email — единственный канал.")}</p>
      </main>
      <Footer />
    </>
  );
}
