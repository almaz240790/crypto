import { expect, test, type Page } from "@playwright/test";

/** Публичная статистика (план 3.10). Серверные данные — из e2e/mock-api.mjs, клиентские — перехват. */

async function mockClient(page: Page, authed: boolean) {
  if (authed) await page.context().addCookies([{ name: "pl_auth", value: "1", url: "http://localhost:3101" }]);
  await page.route("**/v1/auth/**", (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === "/v1/auth/refresh") return route.fulfill({ status: 200, contentType: "application/json", body: '{"access_token":"t"}' });
    if (p === "/v1/auth/me")
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: 1, email: "a@b.c", name: null, email_verified: true, role: "user", locale: "ru", timezone: "UTC", theme: "system", risk: {} }) });
    return route.fulfill({ status: 404, body: "{}" });
  });
  await page.route("**/v1/stats/export.csv**", (route) =>
    route.fulfill({ status: 200, contentType: "text/csv", headers: { "content-disposition": "attachment; filename=platform-backtest-signals.csv" }, body: "id,symbol\ns1,BTCUSDT\n" }),
  );
}

test("статистика: live пусто, бэктест с цифрами, фильтры в URL, таблица с пагинацией", async ({ page }) => {
  await mockClient(page, false);
  await page.goto("/stats");
  await expect(page.getByRole("heading", { name: "Статистика сигналов" })).toBeVisible();
  await expect(page.getByText(/Live-сигналов пока нет/)).toBeVisible();
  await page.getByRole("link", { name: "Бэктест" }).click();
  await expect(page).toHaveURL(/scope=backtest/);
  await expect(page.getByText("47.0 %").first()).toBeVisible();
  await expect(page.getByText("Прогон #3")).toBeVisible();
  await expect(page.getByRole("img", { name: /Распределение результата/ })).toBeVisible();
  await expect(page.getByText("История: 73 сигнала")).toBeVisible();
  await expect(page.getByText("страница 1 из 2")).toBeVisible();
  await page.getByRole("link", { name: "вперёд →" }).click();
  await expect(page).toHaveURL(/page=1/);
  await expect(page.getByText("страница 2 из 2")).toBeVisible();
  // фильтр градации уходит в URL и меняет цифры
  await page.getByRole("combobox", { name: "градация" }).selectOption("A");
  await page.getByRole("button", { name: "Применить" }).click();
  await expect(page).toHaveURL(/grade=A/);
  await expect(page.getByText("55.0 %").first()).toBeVisible();
  // форвард: агрегаты есть, построчной истории нет
  await page.getByRole("link", { name: "Форвард-тест" }).click();
  await expect(page.getByText("построчная история форварда не публикуется")).toBeVisible();
  await page.getByRole("link", { name: "Бэктест" }).click();
  await expect(page.getByText("CSV —")).toBeVisible();
});

test("статистика: CSV скачивается после входа", async ({ page }) => {
  await mockClient(page, true);
  await page.goto("/stats?scope=backtest");
  const btn = page.getByRole("button", { name: "Скачать CSV" });
  await expect(btn).toBeVisible();
  const dl = page.waitForEvent("download");
  await btn.click();
  expect((await dl).suggestedFilename()).toBe("platform-backtest-signals.csv");
});
