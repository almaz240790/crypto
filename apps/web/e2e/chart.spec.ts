import { expect, test, type Page } from "@playwright/test";

/** Терминал-график (план 3.17, 2A): загрузка свечей, строка состояния, таймфреймы, индикаторы и слои. */

const T0 = 1_792_000_000 - (1_792_000_000 % 14400);
const candle = (i: number) => {
  const o = 100 + Math.sin(i / 7) * 5;
  const c = o + Math.cos(i / 5);
  return { t: T0 + i * 14400, o: o.toFixed(2), h: (Math.max(o, c) + 1).toFixed(2), l: (Math.min(o, c) - 1).toFixed(2), c: c.toFixed(2), v: "1000", open: false };
};

async function mock(page: Page, calls: string[], authed = false) {
  if (authed) await page.context().addCookies([{ name: "pl_auth", value: "1", url: "http://localhost:3101" }]);
  await page.route("**/v1/**", (route) => {
    const u = new URL(route.request().url());
    const p = u.pathname;
    calls.push(`${p}?${u.searchParams.toString()}`);
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (p === "/v1/auth/refresh") return json(authed ? 200 : 401, authed ? { access_token: "t" } : { detail: "нет" });
    if (p === "/v1/auth/me") return json(200, { id: 7, email: "t@example.com", name: null, email_verified: true, role: "user", locale: "ru", timezone: "UTC", theme: "system", risk: {} });
    if (p === "/v1/instruments") return json(200, [{ symbol: "BTCUSDT", tick_size: "0.1" }, { symbol: "ETHUSDT", tick_size: "0.01" }]);
    if (p === "/v1/chart/candles") {
      const tf = u.searchParams.get("tf");
      if (["1m", "5m", "15m"].includes(tf ?? "") && !authed) return json(403, { detail: "таймфреймы 1m–15m доступны на тарифе Pro" });
      const before = u.searchParams.get("before");
      const n = before ? 500 : 300;
      const items = Array.from({ length: n }, (_, i) => candle(before ? i - 500 : i));
      return json(200, { symbol: "BTCUSDT", tf, candles: items, current: { ...candle(n), t: T0 + n * 14400, open: true }, has_older: !before, tick_size: "0.1", server_time: "" });
    }
    if (p === "/v1/chart/derivatives")
      return json(200, { symbol: "BTCUSDT", tf: "4h", funding: [{ t: T0 + 100 * 14400, v: "0.0001" }, { t: T0 + 200 * 14400, v: "0.00012" }], funding_current: "0.00012", next_funding_t: Math.floor(Date.now() / 1000) + 3600, oi: [{ t: T0 + 100 * 14400, v: "1000000" }], liquidations: [{ t: T0 + 100 * 14400, long: "1000", short: "2000" }], liquidations_note: "" });
    if (p === "/v1/chart/layers")
      return json(200, {
        symbol: "BTCUSDT", tf: "4h",
        structure: { tf: "4h", strategy_version: "1.2.0", swings: [{ t: T0 + 100 * 14400, p: "104", kind: "high" }], events: [{ t: T0 + 120 * 14400, type: "bos", dir: "up", level: "103.5", from_t: T0 + 100 * 14400 }], zones: [{ kind: "ob", dir: "up", top: "101", bottom: "99.5", from_t: T0 + 120 * 14400, status: "active" }], levels: { pdh: "106", pdl: "95", pwh: "108", pwl: "92" }, equal_levels: [], sweeps: [], bias: { bias: "long", d1_trend: "up", w1_trend: "up", ema50_d1: "100" }, atr: "1.8" },
        signals: [{ id: "s1", version: "1.2.0", dir: "short", t: T0 + 250 * 14400, status: "active", grade: "A", entry: "102", sl: "104", tp: ["100", "98", "96"], zone: null, events: [] }],
        server_time: "",
      });
    return json(404, { detail: "нет заглушки" });
  });
}

test("график: загрузка, строка состояния, смена таймфрейма, индикаторы и слои", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls);
  await page.goto("/chart/BTCUSDT/4h");
  await expect(page.getByTestId("terminal").locator("canvas").first()).toBeVisible();
  const strip = page.getByLabel("состояние");
  await expect(strip).toContainText("цена");
  await expect(strip).toContainText("bias");
  await expect(strip).toContainText("ATR");
  expect(calls.some((c) => c.startsWith("/v1/chart/candles?symbol=BTCUSDT&tf=4h"))).toBe(true);
  // таймфрейм H4 выделен, 1m без входа недоступен
  await expect(page.getByRole("link", { name: "H4" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name: "1M" })).toHaveAttribute("aria-disabled", "true");
  await page.getByRole("link", { name: "1D" }).click();
  await expect(page).toHaveURL(/\/chart\/BTCUSDT\/1d$/);
  await expect.poll(() => calls.some((c) => c.includes("tf=1d"))).toBe(true);
  // индикаторы: добавить RSI (отдельная панель), слои: выключить зоны
  await page.getByRole("button", { name: /Индикаторы/ }).click();
  await page.getByRole("dialog", { name: "Индикаторы" }).getByLabel(/RSI/).check();
  await page.getByRole("dialog", { name: "Индикаторы" }).getByLabel(/Funding/).check();
  await page.getByRole("button", { name: "Готово" }).click();
  await expect(page.getByRole("button", { name: "Индикаторы (3)" })).toBeVisible();
  await expect(strip).toContainText("funding 0.0120 %");
  await page.getByRole("button", { name: "Слои" }).click();
  await page.getByRole("dialog", { name: "Слои" }).getByLabel("Зоны").uncheck();
  await page.getByRole("button", { name: "Готово" }).click();
  // тип графика
  await page.getByLabel("тип графика").selectOption("heikin");
  await expect(strip).toContainText("Heikin Ashi");
  // настройки сохраняются между загрузками
  await page.reload();
  await expect(page.getByRole("button", { name: "Индикаторы (3)" })).toBeVisible();
});

test("график: смена инструмента и сигналы по инструменту", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls, true);
  await page.goto("/chart/BTCUSDT/4h");
  await expect(page.getByText("сигналов по инструменту: 1")).toBeVisible();
  await page.getByLabel("инструмент").selectOption("ETHUSDT");
  await expect(page).toHaveURL(/\/chart\/ETHUSDT\/4h$/);
  await expect(page.getByRole("link", { name: "1M" })).not.toHaveAttribute("aria-disabled", "true");
});
