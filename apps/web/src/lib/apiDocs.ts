/**
 * Публичный API для чтения (план 3.10, ADR-0017): адрес и список эндпоинтов страницы /api-docs.
 *
 * Ключ X-API-Key открывает ровно эти эндпоинты (GET): сервер держит тот же список
 * (apps/api/app/apikeys.py, KEY_ENDPOINTS), тест apps/api/tests/test_apikeys.py сверяет оба. Новый пункт
 * добавляется в оба места; остальное (профиль, ключи, сессии, платежи…) по ключу — 403.
 */

/** Адрес API для скриптов. Прокси сайта (www…/v1) заголовок X-API-Key не передаёт — запрос с ключом туда
 *  получил бы ответ гостя. */
export const PUBLIC_API_BASE = "https://api.platformsol.com";

export type ApiEndpoint = { path: string; what: string; params: string };

export const API_ENDPOINTS: ApiEndpoint[] = [
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
  { path: "/v1/instruments", what: "Список инструментов по капитализации (поле rank)", params: "—" },
  { path: "/v1/prices", what: "Последние цены", params: "symbols" },
  { path: "/v1/journal", what: "Ваш журнал сделок", params: "limit, offset" },
  { path: "/v1/journal/analytics", what: "Аналитика вашего журнала", params: "—" },
  { path: "/v1/alerts", what: "Ваши алерты", params: "symbol, status" },
];

/** Пример запроса с новым ключом (настройки): эндпоинт и параметры из списка выше, адрес API, ключ целиком —
 *  команду можно скопировать и запустить. Адрес в кавычках: `&` в нём иначе разбирает оболочка. */
export function apiKeyExample(key: string): string {
  return `curl -H "X-API-Key: ${key}" "${PUBLIC_API_BASE}/v1/signals?status=open&limit=50"`;
}
