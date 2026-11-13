import { expect, test, type Page } from "@playwright/test";
import { mock, type MockServer } from "./helpers/chart";

/**
 * Мультичарт по тарифу (план, раздел 4, строка «График: таймфреймы»: Premium — «Все + мультичарт (v2)»; ADR-0009,
 * дополнение 2026-11-13). Решение принято Fable по делегированию (ADR-0012), владелец: «Делай по твоему».
 *
 * - Оплата включена: гость, Free и Pro вместо сетки видят экран «Доступно с подпиской Premium» (что такое мультичарт,
 *   подписка, «Открыть терминал»); Premium, админы и владелец — сетку. Пока тариф не известен — нейтральная
 *   загрузка: сетка не мелькает и свечи не запрашиваются.
 * - Оплата выключена (как на production до запуска): ничего не меняется — сетка у всех, включая гостя.
 */

const server = (o: Partial<MockServer>): MockServer => ({ drawings: [], layout: null, ...o });
const cells = (page: Page) => page.getByRole("region", { name: /^график / });
const upsell = (page: Page) => page.getByTestId("multichart-upsell");
const PREMIUM = "Доступно с подпиской Premium";

/** Отмечает, появлялась ли на странице хоть одна ячейка сетки (мелькание до ответа о тарифе). */
async function watchGrid(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __gridSeen?: boolean };
    new MutationObserver(() => {
      if (document.querySelector('[aria-label^="график "]')) w.__gridSeen = true;
    }).observe(document, { childList: true, subtree: true });
  });
}
const gridSeen = (page: Page) => page.evaluate(() => !!(window as unknown as { __gridSeen?: boolean }).__gridSeen);
const chartCalls = (calls: string[]) => calls.filter((c) => c.startsWith("/v1/chart/"));

test.describe("оплата включена: мультичарт — Premium", () => {
  test("гость: экран Premium вместо сетки — подписка (/pricing), вход с возвратом, терминал; свечи не запрашиваются; на телефоне — тот же экран", async ({ page }) => {
    await watchGrid(page);
    const calls: string[] = [];
    await mock(page, calls, false, server({ billing: true }));
    await page.goto("/multichart");
    const u = upsell(page);
    await expect(u.getByRole("heading", { name: PREMIUM })).toBeVisible();
    await expect(u).toContainText("2 или 4 графика на одном экране");
    await expect(u.getByRole("link", { name: "Подписка" })).toHaveAttribute("href", "/pricing");
    await expect(u.getByRole("link", { name: "Войти" })).toHaveAttribute("href", "/login?next=/multichart");
    await expect(u.getByRole("link", { name: "Открыть терминал" })).toHaveAttribute("href", "/chart/BTCUSDT/4h");
    await page.waitForTimeout(500);
    await expect(cells(page)).toHaveCount(0);
    expect(await gridSeen(page)).toBe(false);
    expect(chartCalls(calls)).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(u.getByRole("heading", { name: PREMIUM })).toBeVisible();
    await expect(page.getByText("Мультичарт доступен на десктопе", { exact: false })).toHaveCount(0);
  });

  for (const plan of ["free", "pro"] as const)
    test(`${plan}: пока тариф грузится — «Загрузка…», затем экран Premium с подпиской (/billing) без «Войти»; сетка не мелькает`, async ({ page }) => {
      await watchGrid(page);
      const calls: string[] = [];
      await mock(page, calls, true, server({ billing: true, plan }));
      await page.route("**/v1/billing/me", async (r) => {
        await new Promise((res) => setTimeout(res, 1500));
        return r.fallback();
      });
      await page.goto("/multichart");
      await expect(page.getByRole("status").filter({ hasText: "Загрузка…" })).toBeVisible();
      const u = upsell(page);
      await expect(u.getByRole("heading", { name: PREMIUM })).toBeVisible();
      await expect(u.getByRole("link", { name: "Подписка" })).toHaveAttribute("href", "/billing");
      await expect(u.getByRole("link", { name: "Открыть терминал" })).toHaveAttribute("href", "/chart/BTCUSDT/4h");
      await expect(u.getByRole("link", { name: "Войти" })).toHaveCount(0);
      await expect(cells(page)).toHaveCount(0);
      expect(await gridSeen(page)).toBe(false);
      expect(chartCalls(calls)).toEqual([]);
    });

  test("Premium: сетка мультичарта", async ({ page }) => {
    await mock(page, [], true, server({ billing: true, plan: "premium" }));
    await page.goto("/multichart");
    await expect(cells(page)).toHaveCount(2);
    await expect(cells(page).first().locator("canvas").first()).toBeVisible();
    await expect(upsell(page)).toHaveCount(0);
  });

  for (const role of ["owner", "admin"] as const)
    test(`${role === "owner" ? "владелец" : "админ"}: сетка без запроса тарифа — права Premium`, async ({ page }) => {
      const calls: string[] = [];
      await mock(page, calls, true, server({ billing: true, plan: "free" }));
      await page.route("**/v1/auth/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: 1, email: "o@example.com", name: null, email_verified: true, role, locale: "ru", timezone: "UTC", theme: "system", risk: {} }) }));
      await page.goto("/multichart");
      await expect(cells(page)).toHaveCount(2);
      await expect(upsell(page)).toHaveCount(0);
      expect(calls.filter((c) => c.startsWith("/v1/billing/"))).toEqual([]);
    });
});

test.describe("оплата выключена (как сейчас): ничего не меняется", () => {
  test("гость видит сетку", async ({ page }) => {
    await mock(page, [], false, server({ billing: false }));
    await page.goto("/multichart");
    await expect(cells(page)).toHaveCount(2);
    await expect(upsell(page)).toHaveCount(0);
  });

  test("вошедший видит сетку", async ({ page }) => {
    await mock(page, [], true, server({ billing: false, plan: "pro" }));
    await page.goto("/multichart");
    await expect(cells(page)).toHaveCount(2);
    await expect(upsell(page)).toHaveCount(0);
  });
});

test("тарифы: мультичарт — в карточке Premium, не в Pro", async ({ page }) => {
  await mock(page, [], false, server({ billing: true }));
  await page.goto("/pricing");
  const card = (name: string) => page.locator("article").filter({ has: page.getByRole("heading", { name, exact: true }) });
  await expect(card("Premium")).toContainText("Мультичарт: 2 или 4 графика на экране");
  await expect(card("Pro")).toBeVisible();
  await expect(card("Pro")).not.toContainText("Мультичарт");
});
