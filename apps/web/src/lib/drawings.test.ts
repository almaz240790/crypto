import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Офлайн-очередь рисунков (план 2A.5, 2B.7; аудит DTS-4): отказ одному рисунку не держит очередь. */

const api = vi.fn();
vi.mock("./auth-client", () => ({ api: (...args: unknown[]) => api(...args) }));

const { queueAdd, queueFlush, queueRead } = await import("./drawings");
type Wire = Parameters<typeof queueAdd>[0][number];

const w = (id: string, symbol = "BTCUSDT", updated_at = 1000): Wire => ({ client_id: id, symbol, timeframe: null, type: "hline", points: [{ time: 1, price: 100 }], style: { color: "text2", width: 1, dashed: false }, text: null, levels: null, locked: false, updated_at, deleted_at: null });

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  api.mockReset();
});

describe("queueFlush", () => {
  it("принятые и отклонённые сервером рисунки уходят из очереди, отказы — в ответе", async () => {
    queueAdd([w("d_btc1"), w("d_eth1", "ETHUSDT")]);
    const limit = { client_id: "d_eth1", symbol: "ETHUSDT", status: 403, code: "limit", detail: "d_eth1: лимит рисунков на инструмент: 100 (тариф pro)" };
    api.mockResolvedValueOnce({ items: [w("d_btc1")], rejected: [limit] });
    const r = await queueFlush();
    expect(api).toHaveBeenCalledWith("/v1/drawings", { method: "PUT", json: [w("d_btc1"), w("d_eth1", "ETHUSDT")] });
    expect(r).toEqual({ items: [w("d_btc1")], rejected: [limit] });
    expect(queueRead()).toEqual([]);
  });

  it("ответ API прежней сборки (без rejected) — без отказов", async () => {
    queueAdd([w("d_btc1")]);
    api.mockResolvedValueOnce({ items: [w("d_btc1")] });
    expect(await queueFlush()).toEqual({ items: [w("d_btc1")], rejected: [] });
    expect(queueRead()).toEqual([]);
  });

  it("версия, поставленная в очередь, пока шёл запрос, остаётся до следующей отправки", async () => {
    queueAdd([w("d_a"), w("d_b")]);
    api.mockImplementationOnce(async () => {
      queueAdd([w("d_a", "BTCUSDT", 2000), w("d_c")]);
      return { items: [w("d_a"), w("d_b")], rejected: [] };
    });
    await queueFlush();
    expect(queueRead()).toEqual([w("d_a", "BTCUSDT", 2000), w("d_c")]);
  });

  it("ошибка запроса (сеть, 5xx, отказ всего пакета) — исключение, очередь на месте", async () => {
    queueAdd([w("d_a"), w("d_b", "ETHUSDT")]);
    api.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(queueFlush()).rejects.toThrow("Failed to fetch");
    expect(queueRead()).toEqual([w("d_a"), w("d_b", "ETHUSDT")]);
  });

  it("пустая очередь — без запроса", async () => {
    expect(await queueFlush()).toEqual({ items: [], rejected: [] });
    expect(api).not.toHaveBeenCalled();
  });
});
