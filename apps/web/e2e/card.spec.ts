import { expect, test, type Page } from "@playwright/test";

/** Карточка сигнала (план 3.5): график с элементами, подсветка из обоснования, калькулятор, действия. */

const ME = {
  id: 7, email: "trader@example.com", name: null, email_verified: true, role: "user", locale: "ru", timezone: "UTC", theme: "system",
  risk: { deposit: "10000", risk_pct: "1.00", exchange: "binance", market_type: "futures", default_leverage: 3, experience: null },
};
const T0 = Date.parse("2026-10-20T00:00:00Z") / 1000;
const candles = Array.from({ length: 120 }, (_, i) => {
  const base = 100 + 8 * Math.sin(i / 7) + i * 0.05;
  const o = base - 0.3;
  const c = base + 0.3;
  return { t: T0 + i * 14400, o: o.toFixed(2), h: (c + 0.6).toFixed(2), l: (o - 0.6).toFixed(2), c: c.toFixed(2), v: "10" };
});
const SIG_T = new Date((T0 + 100 * 14400) * 1000).toISOString();
const DETAIL = {
  id: "abc", symbol: "BTCUSDT", instrument_id: 1, strategy_version: "1.1.0", direction: "long", candle_close_time: SIG_T, created_at: SIG_T,
  entry_market: "104.50", entry_limit: "104.20", stop_loss: "102.20", tp1: "106.20", tp2: "109.40", tp3: "112.20", rr_tp2: "2.6", score: 81, grade: "A",
  status: "active", flags: [], last_event_at: SIG_T, result: null,
  facts: ["D1: структура up", "BOS 23.10 20:00 с закрытием на 0.42 ATR выше уровня", "Ретест OB 103.8–104.6", "Ликвидность: снятие перед входом", "ATR-режим: в норме (p48)"],
  zone: { kind: "ob", top: "104.60", bottom: "103.80" },
  score_breakdown: { bias: 15, structure: 15, zone: 12, liquidity: 10, volume: 8, derivatives: 6, volatility: 5, rr: 10 },
  events: [{ type: "created", price: null, at: SIG_T, source: "engine" }, { type: "activated", price: "104.20", at: new Date((T0 + 102 * 14400) * 1000).toISOString(), source: "tracker" }],
};
const ANALYSIS = {
  swings: [{ time: new Date((T0 + 60 * 14400) * 1000).toISOString(), price: "108.1", kind: "high" }, { time: new Date((T0 + 80 * 14400) * 1000).toISOString(), price: "96.4", kind: "low" }],
  events: [{ time: new Date((T0 + 95 * 14400) * 1000).toISOString(), type: "bos", direction: "up", level: "103.9", from_time: new Date((T0 + 60 * 14400) * 1000).toISOString() }],
  zones: [{ kind: "ob", direction: "up", top: "104.60", bottom: "103.80", from_time: new Date((T0 + 94 * 14400) * 1000).toISOString(), status: "touched" }],
  levels: { pdh: "107.0", pdl: "101.5", pwh: "110.0", pwl: "95.0" },
  equal_levels: [{ kind: "low", price: "96.5", from_time: new Date((T0 + 70 * 14400) * 1000).toISOString(), to_time: null, swept: true }],
  sweeps: [{ time: new Date((T0 + 92 * 14400) * 1000).toISOString(), kind: "low", level: "101.5" }],
  bias: { bias: "long", d1_trend: "up", w1_trend: "up", ema50_d1: "99.5" },
  trade_params: { split: ["0.4", "0.4", "0.2"], be_after_tp1: true, limit_expiry_candles: 6, time_stop_candles: 15 },
  atr: "1.9",
};

async function mock(page: Page, calls: string[]) {
  await page.context().addCookies([{ name: "pl_auth", value: "1", url: "http://localhost:3101" }]);
  await page.route("**/v1/**", (route) => {
    const u = new URL(route.request().url());
    calls.push(`${route.request().method()} ${u.pathname}${u.search}`);
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    const p = u.pathname;
    if (p === "/v1/auth/refresh") return json(200, { access_token: "t" });
    if (p === "/v1/auth/me") return json(200, ME);
    if (p === "/v1/instruments") return json(200, [{ symbol: "BTCUSDT", tick_size: "0.1" }]);
    if (p === "/v1/prices") return json(200, { BTCUSDT: { p: "105.30", at: "" } });
    if (p === "/v1/signals/abc") return json(200, DETAIL);
    if (p === "/v1/signals/abc/analysis") return json(200, ANALYSIS);
    if (p === "/v1/chart/patterns") {
      const close = Math.floor(new Date(SIG_T).getTime() / 1000);
      return json(200, { symbol: "BTCUSDT", tf: u.searchParams.get("tf"), horizon: 5, note: "", stats: {}, items: [{ id: 11, type: "engulfing", title: "Бычье поглощение", direction: "up", status: "confirmed", significant: true, t: close - 14400, start_t: close - 28800, confirm_t: close, price: "100", atr: "2", context: {}, source: "backfill", tf: "4h" }] });
    }
    if (p === "/v1/signals/abc/candles") return json(200, { tf: u.searchParams.get("tf"), candles });
    if (p === "/v1/journal") return json(201, {});
    return json(404, { detail: "нет заглушки" });
  });
  await page.route("**/config", (route) => route.fulfill({ status: 200, contentType: "application/json", body: '{"ws":"ws://localhost:1/v1/ws"}' }));
}

test("карточка: график, параметры, подсветка факта, калькулятор, «я вошёл», скриншот", async ({ page }, testInfo) => {
  const calls: string[] = [];
  await mock(page, calls);
  await page.goto("/signals/abc");
  await expect(page.getByRole("heading", { name: "BTCUSDT LONG" })).toBeVisible();
  const chart = page.getByTestId("signal-chart");
  await expect(chart.locator("canvas").first()).toBeVisible();
  await expect.poll(() => chart.locator("canvas").count()).toBeGreaterThan(0);
  // параметры: R до TP2 и доли закрытия
  await expect(page.getByRole("cell", { name: "2.60" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "40 %" }).first()).toBeVisible();
  // нереализованный результат по цене 105.30: (105.3-104.2)/2 = +0.55 R
  await expect(page.getByText(/сейчас \+0\.55.R/)).toBeVisible();
  // подсветка факта
  const fact = page.getByRole("button", { name: /^BOS 23\.10/ });
  await fact.click();
  await expect(fact).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /^Ретест OB/ }).click();
  await expect(fact).toHaveAttribute("aria-pressed", "false");
  // калькулятор: 10000 × 1 % = 100 USDT риска, размер 100 / 2.0 = 50
  await expect(page.getByText("100.00", { exact: true })).toBeVisible();
  await expect(page.getByText(/^50 BTC$/)).toBeVisible();
  await page.getByLabel("Риск, %").fill("2");
  await expect(page.getByText("200.00", { exact: true })).toBeVisible();
  // паттерны на сигнальной свече (2B.16) и переход в терминал
  await expect.poll(() => calls.some((c) => c.includes("/v1/chart/patterns"))).toBe(true);
  await expect(page.getByTestId("signal-patterns")).toContainText("Бычье поглощение (значимый)");
  await page.getByTestId("signal-patterns").click();
  await expect(page.getByTestId("signal-patterns")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("link", { name: "Открыть в терминале" })).toHaveAttribute("href", "/chart/BTCUSDT/4h");
  // переключение на D1 запрашивает свечи D1
  await page.getByRole("button", { name: "1D" }).click();
  await expect.poll(() => calls.some((c) => c.includes("/candles?tf=1d"))).toBe(true);
  // действие
  await page.getByRole("button", { name: "Я вошёл" }).click();
  await expect(page.getByRole("status")).toContainText("Запись в журнале создана");
  expect(calls).toContain("POST /v1/journal");
  await page.screenshot({ path: testInfo.outputPath("card.png"), fullPage: true });
});
