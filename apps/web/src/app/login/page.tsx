import type { Metadata } from "next";
import { Footer, Header } from "@/components/site";
import { Button, Panel } from "@/components/ui";

export const metadata: Metadata = { title: "Вход" };

// Заглушка до задачи 2.8 (регистрация, вход, онбординг).
export default function LoginPage() {
  return (
    <>
      <Header />
      <main className="container" style={{ padding: "24px 0", maxWidth: 480 }}>
        <Panel title="Вход и регистрация">
          <p className="text-2">
            Регистрация откроется вместе с лентой сигналов. Сейчас доступны публичные разделы:
            правила системы, статистика и тарифы.
          </p>
          <div style={{ marginTop: 12 }}>
            <Button href="/">На главную</Button>
          </div>
        </Panel>
      </main>
      <Footer />
    </>
  );
}
