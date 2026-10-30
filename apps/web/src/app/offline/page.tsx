import type { Metadata } from "next";
import { Button, Panel } from "@/components/ui";

export const metadata: Metadata = { title: "Нет сети", robots: { index: false } };

export default function OfflinePage() {
  return (
    <main className="container" style={{ padding: "24px 0", maxWidth: 480 }}>
      <Panel title="Нет соединения">
        <p className="text-2">Сигналы и цены не кэшируются, чтобы вы не видели устаревшие данные. Проверьте сеть и обновите страницу.</p>
        <div style={{ marginTop: 12 }}>
          <Button href="/chart">Повторить</Button>
        </div>
      </Panel>
    </main>
  );
}
