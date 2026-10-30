import type { Metadata } from "next";
import Link from "next/link";
import { Footer, Header } from "@/components/site";
import { Panel, Table, Td, Th } from "@/components/ui";
import { getT } from "@/i18n/server";

export const metadata: Metadata = {
  title: "API для чтения",
  description: "Публичный API PlatformSol для тарифа Premium: сигналы, статистика, свечи, скринер — только чтение, по ключу в заголовке X-API-Key.",
};

const BASE = "https://api.platformsol.com";

const ENDPOINTS: { path: string; what: string; params: string }[] = [
  { path: "/v1/signals", what: "Лента сигналов с фильтрами и пагинацией", params: "status, symbol, grade, direction, days, sort, order, limit, offset" },
  { path: "/v1/signals/{public_id}", what: "Карточка сигнала: уровни, обоснование, события", params: "—" },
  { path: "/v1/signals/{public_id}/candles", what: "Свечи вокруг сигнала", params: "tf, before, after" },
  { path: "/v1/stats", what: "Статистика стратегии: винрейт, средний R, просадка, по градациям и месяцам", params: "scope, version, symbol, grade, days, since, until" },
  { path: "/v1/stats/trades", what: "Список сделок статистики", params: "scope, version, symbol, grade, limit, offset" },
  { path: "/v1/stats/export.csv", what: "Полная история сделок в CSV", params: "scope, version, symbol" },
  { path: "/v1/stats/patterns", what: "Отработка свечных паттернов", params: "tf, type, symbol, horizon" },
  { path: "/v1/stats/figures", what: "Отработка графических фигур", params: "tf, type" },
  { path: "/v1/chart/candles", what: "Закрытые свечи инструмента", params: "symbol, tf, before, limit" },
  { path: "/v1/chart/layers", what: "Структура рынка, зоны, уровни на таймфрейме", params: "symbol, tf" },
  { path: "/v1/chart/patterns", what: "Свечные паттерны на графике", params: "symbol, tf, since, until, limit" },
  { path: "/v1/chart/figures", what: "Графические фигуры на графике", params: "symbol, tf, since, until, limit" },
  { path: "/v1/chart/derivatives", what: "Funding, OI, ликвидации, L/S ratio по корзинам таймфрейма", params: "symbol, tf, before, limit" },
  { path: "/v1/screener", what: "Скринер по всем инструментам", params: "symbols" },
  { path: "/v1/screener/export.csv", what: "Скринер в CSV", params: "symbols" },
  { path: "/v1/instruments", what: "Список инструментов", params: "—" },
  { path: "/v1/prices", what: "Последние цены", params: "symbols" },
  { path: "/v1/journal", what: "Ваш журнал сделок", params: "limit, offset" },
  { path: "/v1/journal/analytics", what: "Аналитика вашего журнала", params: "—" },
  { path: "/v1/alerts", what: "Ваши алерты", params: "symbol, status" },
];

export default async function ApiDocsPage() {
  const t = await getT();
  return (
    <>
      <Header />
      <main className="container" style={{ padding: "24px 0", display: "grid", gap: 16, maxWidth: 960 }}>
        <div>
          <h1>{t("API для чтения")}</h1>
          <p className="text-2">{t("Те же данные, что на сайте, для ваших скриптов и таблиц. Доступно на тарифе Premium: ключ создаётся в")}{" "}<Link href="/settings">{t("настройках")}</Link>{t(", передаётся в заголовке")}{" "}<code>X-API-Key</code>{" "}{t("и даёт только чтение (запросы GET). Лимит — 600 запросов в минуту на ключ, не больше 5 активных ключей.")}</p>
        </div>
        <Panel title={t("Пример")}>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 13 }}>{`curl -H "X-API-Key: pk_ваш_ключ" "${BASE}/v1/signals?status=closed&limit=50"

# Python
import requests
r = requests.get("${BASE}/v1/stats", params={"scope": "live"}, headers={"X-API-Key": t("pk_ваш_ключ")})
print(r.json()["metrics"])`}</pre>
          <p className="caption" style={{ margin: "8px 0 0" }}>{t("Ответы — JSON, цены и объёмы — строками (без потери точности), время — ISO 8601 в UTC или unix-секунды в полях")}{" "}<code>t</code>{t(". Ошибки: 401 — ключ неверный или отозван, 403 — тариф без API или запрос не на чтение, 429 — превышен лимит.")}</p>
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
              {ENDPOINTS.map((e) => (
                <tr key={e.path}>
                  <Td>
                    <code>GET {e.path}</code>
                  </Td>
                  <Td>{e.what}</Td>
                  <Td className="text-2">{e.params}</Td>
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
