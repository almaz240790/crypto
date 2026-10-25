import { formatTimeUTC } from "@/lib/format";

// Временная главная до задачи 2.7 (лендинг с живыми данными).
export default function Home() {
  return (
    <main className="container" style={{ padding: "24px 0" }}>
      <h1>Platform</h1>
      <p className="text-2" style={{ marginTop: 8 }}>
        Торговые сигналы на H4 по крипторынку. Сайт в разработке.
      </p>
      <p className="caption" style={{ marginTop: 16 }}>
        Собрано {formatTimeUTC(new Date(), { withYear: true })} · <a href="/ui">дизайн-система</a>
      </p>
    </main>
  );
}
