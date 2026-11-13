import type { Metadata } from "next";
import Link from "next/link";
import { Footer, Header } from "@/components/site";
import { Panel, Table, Td, Th } from "@/components/ui";
import { getT } from "@/i18n/server";
import { API_ENDPOINTS, PUBLIC_API_BASE as BASE } from "@/lib/apiDocs";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return {
    title: t("API для чтения"),
    description: t("Публичный API PlatformSol для тарифа Premium: сигналы, статистика, свечи, скринер — только чтение, по ключу в заголовке X-API-Key."),
  };
}

/** Описание и параметры переносятся по словам: таблица помещается в колонку без прокрутки. */
const WRAP = { whiteSpace: "normal", paddingBlock: 6 } as const;

export default async function ApiDocsPage() {
  const t = await getT();
  const key = t("pk_ваш_ключ");
  return (
    <>
      <Header />
      <main className="container" style={{ paddingBlock: 24, display: "grid", gap: 16, maxWidth: 960 }}>
        <div>
          <h1>{t("API для чтения")}</h1>
          <p className="text-2">{t("Те же данные, что на сайте, для ваших скриптов и таблиц. Доступно на тарифе Premium: ключ создаётся в")}{" "}<Link href="/settings">{t("настройках")}</Link>{t(", передаётся в заголовке")}{" "}<code>X-API-Key</code>{" "}{t("и даёт только чтение (запросы GET). Лимит — 600 запросов в минуту на ключ, не больше 5 активных ключей.")}</p>
        </div>
        <Panel title={t("Пример")}>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 13 }}>{`curl -H "X-API-Key: ${key}" "${BASE}/v1/signals?status=closed&limit=50"

# Python
import requests
r = requests.get("${BASE}/v1/stats", params={"scope": "live"}, headers={"X-API-Key": "${key}"})
print(r.json()["metrics"])`}</pre>
          <p className="caption" style={{ margin: "8px 0 0" }}>{t("Ответы — JSON, цены и объёмы — строками (без потери точности), время — ISO 8601 в UTC или unix-секунды в полях")}{" "}<code>t</code>{t(". Ошибки: 401 — ключ неверный или отозван, 403 — тариф без API, запрос не на чтение или эндпоинта нет в списке ниже (профиль, сессии, ключи, платежи по ключу недоступны), 429 — превышен лимит.")}</p>
        </Panel>
        <Panel title={t("Эндпоинты")} flush>
          <Table compact>
            <thead>
              <tr>
                <Th>{t("Путь")}</Th>
                <Th>{t("Что возвращает")}</Th>
                <Th>{t("Параметры")}</Th>
              </tr>
            </thead>
            <tbody>
              {API_ENDPOINTS.map((e) => (
                <tr key={e.path}>
                  <Td>
                    <code>GET {e.path}</code>
                  </Td>
                  <Td style={WRAP}>{t(e.what)}</Td>
                  <Td className="text-2" style={{ ...WRAP, minWidth: 180 }}>
                    {e.params}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Panel>
        <p className="caption">{t("Полная схема всех эндпоинтов с типами полей — в OpenAPI:")}{" "}<a href={`${BASE}/docs`}>{BASE}/docs</a>{t(". Данные носят информационный характер и не являются инвестиционной рекомендацией.")}</p>
      </main>
      <Footer />
    </>
  );
}
