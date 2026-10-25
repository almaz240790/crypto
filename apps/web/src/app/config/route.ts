/** Публичная конфигурация клиента, известная только серверу во время работы (не при сборке). */
export const dynamic = "force-dynamic";

export function GET(): Response {
  const api = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
  // WebSocket не проходит через прокси route handler — клиент подключается к API напрямую.
  const ws = api.replace(/^http/, "ws") + "/v1/ws";
  return Response.json({ ws }, { headers: { "cache-control": "public, max-age=300" } });
}
