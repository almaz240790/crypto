import { expect, test, type Locator, type Page } from "@playwright/test";
import { mock } from "./helpers/chart";

/**
 * Монеты по капитализации (BTC, ETH, BNB, XRP, SOL…) во всех списках инструментов: выбор в терминале (десктоп и
 * телефон), ячейки мультичарта, добавление в «Мои монеты», алерты, скринер. API до правки отдаёт список по
 * алфавиту и без поля rank — порядок берётся из статического снимка; новое API — по полю rank.
 */

/** Как отдавало API до правки: по алфавиту, 1000BONKUSDT первым, без rank. */
const ALPHA = ["1000BONKUSDT", "1000PEPEUSDT", "ADAUSDT", "BNBUSDT", "BTCUSDT", "ETHUSDT", "MKRUSDT", "SOLUSDT", "XRPUSDT"];
const BY_CAP = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT", "SOLUSDT", "ADAUSDT", "1000PEPEUSDT", "1000BONKUSDT", "MKRUSDT"];
const inst = (symbol: string, i: number, rank?: number | null) => ({
  id: i + 1,
  symbol,
  base: symbol.replace(/USDT$/, ""),
  quote: "USDT",
  tick_size: "0.01",
  lot_size: "0.001",
  ...(rank === undefined ? {} : { rank }),
});
const OLD_API = ALPHA.map((s, i) => inst(s, i));
/** Новое API: порядок по полю rank (у SOL здесь место выше, чем у BNB, — свежий порядок важнее снимка). */
const NEW_API = [inst("BTCUSDT", 0, 1), inst("ETHUSDT", 1, 2), inst("SOLUSDT", 2, 3), inst("BNBUSDT", 3, 4), inst("MKRUSDT", 4, null), inst("ABCUSDT", 5, null)];

const options = (select: Locator) => select.locator("option").evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value).filter(Boolean));

async function instruments(page: Page, body: unknown) {
  await page.route("**/v1/instruments", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }));
}

test("терминал: выбор инструмента — по капитализации, BTCUSDT и ETHUSDT первыми; буквы с клавиатуры — первая по капитализации", async ({ page }) => {
  await mock(page, []);
  await instruments(page, OLD_API);
  await page.goto("/chart/ETHUSDT/4h");
  const picker = page.getByLabel("инструмент", { exact: true }).first();
  await expect.poll(() => options(picker)).toEqual(BY_CAP);
  // наложение второго инструмента — тот же порядок без текущего
  await page.getByRole("button", { name: "Вид", exact: true }).click();
  await expect.poll(() => options(page.getByRole("dialog", { name: "Вид" }).getByLabel("наложение"))).toEqual(BY_CAP.filter((s) => s !== "ETHUSDT"));
  await page.keyboard.press("Escape");
  // поиск по буквам в списке: «S» — SOLUSDT, первая на S по капитализации
  await picker.focus();
  await page.keyboard.press("s");
  await expect(page).toHaveURL(/\/chart\/SOLUSDT\/4h$/);
});

test("терминал: новое API — порядок по полю rank, без места — в конце по алфавиту", async ({ page }) => {
  await mock(page, []);
  await instruments(page, NEW_API);
  await page.goto("/chart/BTCUSDT/4h");
  await expect.poll(() => options(page.getByLabel("инструмент", { exact: true }).first())).toEqual(["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "ABCUSDT", "MKRUSDT"]);
});

test("телефон: выбор инструмента — по капитализации", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mock(page, []);
  await instruments(page, OLD_API);
  await page.goto("/chart/BTCUSDT/4h");
  await expect.poll(() => options(page.getByLabel("инструмент", { exact: true }).first())).toEqual(BY_CAP);
});

test("мультичарт: выбор в каждой ячейке — по капитализации", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mock(page, []);
  await instruments(page, OLD_API);
  await page.goto("/multichart");
  const cells = page.getByRole("region", { name: /^график / });
  await expect(cells.first()).toBeVisible();
  const n = await cells.count();
  expect(n).toBeGreaterThan(1);
  for (let i = 0; i < n; i++) await expect.poll(() => options(cells.nth(i).getByLabel("инструмент", { exact: true }))).toEqual(BY_CAP);
});

const ME = { id: 7, email: "trader@example.com", name: "Al", email_verified: true, role: "user", locale: "ru", timezone: "UTC", theme: "system", risk: {} };
const SCREEN = (symbol: string, i: number, change: string) => ({
  symbol, instrument_id: i + 1, exchange: "binance", price: "1", change_24h: change, volume_24h: "1000000", bias: "neutral", d1_trend: "up", w1_trend: "up",
  last_event: null, zone: null, atr_pct: "1", atr_percentile: "50", beta_btc: "1", funding: "0.01", funding_pct: "50", oi_change_24h: "1", liq_long_24h: "0", liq_short_24h: "0", ls_ratio: "1", ls_top: "1",
});

async function mockCabinet(page: Page, list: unknown) {
  await page.context().addCookies([{ name: "pl_auth", value: "1", url: test.info().project.use.baseURL ?? "http://localhost:3101" }]);
  await page.route("**/v1/**", (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (p === "/v1/auth/refresh") return json(200, { access_token: "t" });
    if (p === "/v1/auth/me") return json(200, ME);
    if (p === "/v1/instruments") return json(200, list);
    // скринер до правки — по алфавиту и без rank; у SOL самое большое изменение, у BNB — самое малое
    if (p === "/v1/screener") return json(200, { items: ALPHA.map((s, i) => SCREEN(s, i, s === "SOLUSDT" ? "9" : s === "BNBUSDT" ? "-5" : String(i / 10))), generated_at: new Date().toISOString(), sparklines: {} });
    if (p === "/v1/screener/screens") return json(200, []);
    if (p === "/v1/watchlist") return json(200, { id: 1, name: "Основной", items: [] });
    if (p === "/v1/prices") return json(200, {});
    if (p === "/v1/alerts/triggers") return json(200, { items: [] });
    if (p === "/v1/alerts") return json(200, { items: [], active: 0, limit: 3, types: [], frequencies: [] });
    if (p === "/v1/signals") return json(200, { items: [], sparklines: {}, prices: {}, total: 0, scope: "live", limit: 50, offset: 0 });
    return json(404, { detail: "нет заглушки" });
  });
}

const firstCells = (page: Page) => page.locator("tbody tr").evaluateAll((rows) => rows.map((r) => r.querySelector("td:nth-child(2)")?.textContent?.trim() ?? ""));

test("скринер: по умолчанию по капитализации, сортировка по колонке работает, «#» возвращает порядок", async ({ page }, testInfo) => {
  await mockCabinet(page, OLD_API);
  await page.goto("/screener");
  await expect(page.locator("tbody tr")).toHaveCount(ALPHA.length);
  await expect.poll(() => firstCells(page)).toEqual(BY_CAP);
  await expect(page.locator("tbody tr").first().locator("td").first()).toHaveText("1");
  await page.screenshot({ path: testInfo.outputPath("screener-by-cap.png") });
  await page.getByRole("button", { name: "сортировать по: 24 ч" }).click();
  await expect.poll(() => firstCells(page).then((x) => [x[0], x.at(-1)])).toEqual(["SOLUSDT", "BNBUSDT"]);
  await page.getByRole("button", { name: "сортировать по: место по капитализации" }).click();
  await expect.poll(() => firstCells(page)).toEqual(BY_CAP);
});

test("«Мои монеты» и алерты: списки инструментов — по капитализации", async ({ page }) => {
  await mockCabinet(page, OLD_API);
  await page.goto("/watchlist");
  await expect.poll(() => page.locator("#wl-symbols option").evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value))).toEqual(BY_CAP);
  await page.goto("/alerts");
  await expect.poll(() => options(page.getByLabel("инструмент алерта"))).toEqual(BY_CAP);
});
