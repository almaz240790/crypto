import { expect, test } from "@playwright/test";
import { mock } from "./helpers/chart";

/** Терминал-график (план 3.17, 2A): загрузка свечей, строка состояния, таймфреймы, индикаторы и слои. */

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
