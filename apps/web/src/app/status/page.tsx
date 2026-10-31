import type { Metadata } from "next";
import { Footer, Header } from "@/components/site";
import { Badge, EmptyState, Panel, Table, Td, Th } from "@/components/ui";
import { API_URL } from "@/lib/api";
import { formatTimeUTC } from "@/lib/format";
import { componentTitle, statusDetail } from "@/lib/statusText";
import { getT } from "@/i18n/server";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return {
    title: t("Статус системы"),
    description: t("Состояние данных с биржи, движка сигналов, трекера и уведомлений PlatformSol. Инциденты за 7 дней."),
  };
}

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
  const t = await getT();
  const st = await load();
  const titles = new Map((st?.components ?? []).map((c) => [c.key, componentTitle(t, c.key, c.title)]));
  return (
    <>
      <Header />
      <main className="container" style={{ paddingBlock: 24, display: "grid", gap: 16, maxWidth: 900 }}>
        <div>
          <h1>{t("Статус системы")}</h1>
          <p className="text-2">{t("Проверяется каждую минуту. Обновлено {time}.", { time: st ? formatTimeUTC(st.generated_at) : "—" })}</p>
        </div>
        {!st ? (
          <Panel>
            <EmptyState text={t("API недоступен. Если это длится дольше нескольких минут — это и есть инцидент.")} />
          </Panel>
        ) : (
          <>
            <Panel title={t("Общий статус: {s}", { s: t(LABEL[st.status]) })} flush>
              <Table compact>
                <thead>
                  <tr>
                    <Th>{t("Компонент")}</Th>
                    <Th>{t("Состояние")}</Th>
                    <Th>{t("Подробности")}</Th>
                    <Th num>{t("Доступность 7 д")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {st.components.map((c) => (
                    <tr key={c.key}>
                      <Td>{titles.get(c.key)}</Td>
                      <Td mobile="right">
                        <Badge tone={TONE[c.status]}>{t(LABEL[c.status])}</Badge>
                      </Td>
                      <Td className="text-2" mobile="secondary">
                        {statusDetail(t, c.detail)}
                      </Td>
                      <Td num mobile="right">
                        {c.uptime_7d.toFixed(2)} %
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Panel>
            <Panel title={t("Инциденты за 7 дней")} flush footer={t("Инциденты открывает и закрывает монитор автоматически; записи не редактируются вручную.")}>
              {st.incidents.length === 0 ? (
                <EmptyState text={t("Инцидентов не было.")} />
              ) : (
                <Table compact>
                  <thead>
                    <tr>
                      <Th>{t("Открыт")}</Th>
                      <Th>{t("Закрыт")}</Th>
                      <Th>{t("Компонент")}</Th>
                      <Th>{t("Уровень")}</Th>
                      <Th>{t("Что случилось")}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {st.incidents.map((i) => (
                      <tr key={i.component + i.opened_at}>
                        <Td className="num" style={{ textAlign: "left" }} mobile="secondary">
                          {formatTimeUTC(i.opened_at)}
                        </Td>
                        <Td className="num" style={{ textAlign: "left" }} mobile="secondary">
                          {i.closed_at ? formatTimeUTC(i.closed_at) : t("ещё открыт")}
                        </Td>
                        <Td>{titles.get(i.component) ?? i.component}</Td>
                        <Td mobile="right">
                          <Badge tone={i.severity === "down" ? "down" : "warn"}>{t(LABEL[i.severity as "degraded" | "down"])}</Badge>
                        </Td>
                        <Td className="text-2" mobile="secondary">
                          {statusDetail(t, i.message)}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Panel>
          </>
        )}
        <p className="caption">{t("Правила: сигнал публикуется в течение 60 секунд после закрытия свечи H4; отсутствие закрытия свечи дольше 2 минут или прогона движка по более чем 5 % инструментов считается инцидентом.")}</p>
      </main>
      <Footer />
    </>
  );
}
