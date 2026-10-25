import type { Metadata } from "next";
import { Footer, Header } from "@/components/site";
import { Badge, EmptyState, Panel, Table, Td, Th } from "@/components/ui";
import { API_URL } from "@/lib/api";
import { formatTimeUTC } from "@/lib/format";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Статус системы",
  description: "Состояние данных с биржи, движка сигналов, трекера и уведомлений Platform. Инциденты за 7 дней.",
};

type Status = {
  status: "ok" | "degraded" | "down";
  generated_at: string;
  components: { key: string; title: string; status: "ok" | "degraded" | "down"; detail: string; uptime_7d: number }[];
  incidents: { component: string; severity: string; message: string; opened_at: string; closed_at: string | null }[];
};

const LABEL = { ok: "работает", degraded: "с перебоями", down: "не работает" } as const;
const TONE = { ok: "up", degraded: "warn", down: "down" } as const;

async function load(): Promise<Status | null> {
  try {
    const r = await fetch(`${API_URL}/status`, { cache: "no-store" });
    return r.ok ? ((await r.json()) as Status) : null;
  } catch {
    return null;
  }
}

export default async function StatusPage() {
  const st = await load();
  const titles = new Map((st?.components ?? []).map((c) => [c.key, c.title]));
  return (
    <>
      <Header />
      <main className="container" style={{ padding: "24px 0", display: "grid", gap: 16, maxWidth: 900 }}>
        <div>
          <h1>Статус системы</h1>
          <p className="text-2">Проверяется каждую минуту. Обновлено {st ? formatTimeUTC(st.generated_at) : "—"}.</p>
        </div>
        {!st ? (
          <Panel>
            <EmptyState text="API недоступен. Если это длится дольше нескольких минут — это и есть инцидент." />
          </Panel>
        ) : (
          <>
            <Panel title={`Общий статус: ${LABEL[st.status]}`} flush>
              <Table compact stack={false}>
                <thead>
                  <tr>
                    <Th>Компонент</Th>
                    <Th>Состояние</Th>
                    <Th>Подробности</Th>
                    <Th num>Доступность 7 д</Th>
                  </tr>
                </thead>
                <tbody>
                  {st.components.map((c) => (
                    <tr key={c.key}>
                      <Td>{c.title}</Td>
                      <Td>
                        <Badge tone={TONE[c.status]}>{LABEL[c.status]}</Badge>
                      </Td>
                      <Td className="text-2">{c.detail}</Td>
                      <Td num>{c.uptime_7d.toFixed(2)} %</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Panel>
            <Panel title="Инциденты за 7 дней" flush footer="Инциденты открывает и закрывает монитор автоматически; записи не редактируются вручную.">
              {st.incidents.length === 0 ? (
                <EmptyState text="Инцидентов не было." />
              ) : (
                <Table compact stack={false}>
                  <thead>
                    <tr>
                      <Th>Открыт</Th>
                      <Th>Закрыт</Th>
                      <Th>Компонент</Th>
                      <Th>Уровень</Th>
                      <Th>Что случилось</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {st.incidents.map((i) => (
                      <tr key={i.component + i.opened_at}>
                        <Td className="num" style={{ textAlign: "left" }}>
                          {formatTimeUTC(i.opened_at)}
                        </Td>
                        <Td className="num" style={{ textAlign: "left" }}>
                          {i.closed_at ? formatTimeUTC(i.closed_at) : "ещё открыт"}
                        </Td>
                        <Td>{titles.get(i.component) ?? i.component}</Td>
                        <Td>
                          <Badge tone={i.severity === "down" ? "down" : "warn"}>{LABEL[i.severity as "degraded" | "down"]}</Badge>
                        </Td>
                        <Td className="text-2">{i.message}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Panel>
          </>
        )}
        <p className="caption">
          Правила: сигнал публикуется в течение 60 секунд после закрытия свечи H4; отсутствие закрытия свечи дольше 2 минут или прогона движка по более чем 5 % инструментов считается инцидентом.
        </p>
      </main>
      <Footer />
    </>
  );
}
