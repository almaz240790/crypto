import { expect, test, type Page } from "@playwright/test";

/** Лента сигналов (план 3.4): фильтры в URL, сортировка, действия. API — заглушка в браузере. */

const ME = {
  id: 7, email: "trader@example.com", name: null, email_verified: true, role: "user", locale: "ru",
  timezone: "UTC", theme: "system",
  risk: { deposit: null, risk_pct: "1.00", exchange: "binance", market_type: "futures", default_leverage: 3, experience: null },
};
const row = (id: string, iid: number, symbol: string, direction: string, grade: string, status: string) => ({
  id, symbol, instrument_id: iid, strategy_version: "1.1.0", direction, candle_close_time: "2026-10-25T08:00:00Z",
  created_at: "", entry_market: "100.5", entry_limit: null, stop_loss: "98.5", tp1: "103", tp2: "105.5", tp3: "108",
  rr_tp2: "2.5", score: 77, grade, status, flags: [], last_event_at: null, result: null,
});
const ITEMS = [row("a", 1, "BTCUSDT", "long", "A", "active"), row("b", 2, "ETHUSDT", "short", "B", "pending")];

async function mock(page: Page, calls: string[], restrictions: Record<string, unknown> | null = null) {
  await page.context().addCookies([{ name: "pl_auth", value: "1", url: "http://localhost:3101" }]);
  await page.route("**/v1/**", (route) => {
    const u = new URL(route.request().url());
    calls.push(`${route.request().method()} ${u.pathname}${u.search}`);
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    const p = u.pathname;
    if (p === "/v1/auth/refresh") return json(200, { access_token: "t" });
    if (p === "/v1/auth/me") return json(200, ME);
    if (p === "/v1/instruments") return json(200, [{ symbol: "BTCUSDT", tick_size: "0.1" }, { symbol: "ETHUSDT", tick_size: "0.01" }]);
    if (p === "/v1/signals/summary") return json(200, { active: 2, today_new: 1, next_h4_close: new Date(Date.now() + 3600e3).toISOString(), now: "", scope: "live" });
    if (p === "/v1/signals") {
      let items = ITEMS;
      const g = u.searchParams.get("grade");
      if (g) items = items.filter((i) => i.grade === g);
      const d = u.searchParams.get("direction");
      if (d) items = items.filter((i) => i.direction === d);
      return json(200, { items, sparklines: { "1": ["1", "2", "3"], "2": ["3", "2", "1"] }, prices: { "1": { p: "102.5", at: "" } }, total: items.length, scope: "live", limit: 50, offset: 0, restrictions });
    }
    if (p === "/v1/watchlist/items") return json(201, {});
    if (p === "/v1/journal") return json(201, {});
    return json(404, { detail: "нет заглушки" });
  });
}

test("лента: строки, живой P&L, фильтры в URL и сортировка", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls);
  await page.goto("/signals");
  await expect(page.getByText("2 сигналов")).toBeVisible();
  await expect(page.getByRole("cell", { name: /\+1\.00.R/ })).toBeVisible(); // (102.5-100.5)/2 = +1 R
  await page.getByRole("combobox", { name: "градация" }).selectOption("A");
  await expect(page).toHaveURL(/grade=A/);
  await expect(page.getByText("1 сигналов")).toBeVisible();
  await page.getByRole("button", { name: "сортировать по: Инструмент" }).click();
  await expect(page).toHaveURL(/sort=symbol/);
  await expect.poll(() => calls.some((c) => c.includes("sort=symbol&order=desc"))).toBe(true);
  await page.getByRole("button", { name: "сбросить" }).click();
  await expect(page).toHaveURL(/\/signals$/);
});

test("лента: вотчлист и «я вошёл»", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls);
  await page.goto("/signals");
  await page.getByRole("button", { name: "+ вотчлист" }).first().click();
  await expect(page.getByRole("status")).toContainText("BTCUSDT в вотчлисте");
  await page.getByRole("button", { name: "я вошёл" }).first().click();
  await expect(page.getByRole("status")).toContainText("Запись в журнале");
  expect(calls).toContain("POST /v1/watchlist/items");
  expect(calls).toContain("POST /v1/journal");
});

test("лента: пометка об ограничениях тарифа Free", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls, { plan: "free", grades: ["A"], delay_hours: 12, all_instruments: false });
  await page.goto("/signals");
  const note = page.getByRole("note");
  await expect(note).toContainText("Тариф free");
  await expect(note).toContainText("задержкой 12 ч");
  await expect(note).toContainText("инструменты вотчлиста");
  await note.getByRole("link", { name: "Подписка" }).click();
  await expect(page).toHaveURL(/\/pricing$/);
});
