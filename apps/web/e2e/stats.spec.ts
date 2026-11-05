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

test("форвард: одна версия без пункта «все», плашка, пометка «мало данных»", async ({ page }) => {
  await mockClient(page, false);
  await page.goto("/stats?scope=forward");
  const plaque = page.getByRole("note");
  await expect(plaque).toHaveText(
    "Результаты форварда до 06.11.2026 недействительны: из-за ошибки учёта сделки закрывались через 15 минут вместо 60 часов. Исправление и пересчёт — в работе.",
  );
  // без версии — версия по умолчанию из ответа API, она названа на странице и выбрана в селекторе
  await expect(page.getByText("Показана версия Trend OB retest 1.1.0: форвард считается по каждой версии отдельно.")).toBeVisible();
  const sel = page.getByRole("combobox", { name: "версия стратегии" });
  await expect(sel).toHaveValue("1.1.0");
  await expect(sel.locator("option")).toHaveText(["Trend OB retest 1.0.0", "Trend OB retest 1.1.0"]);
  // числа не скрыты, только помечены: 12 закрытых < 30
  const closedCard = page.locator("dl", { has: page.getByText("закрытых сделок", { exact: true }) });
  await expect(closedCard.locator("dd")).toContainText(/^12\s*мало данных/);
  await expect(page.getByText("мало данных")).toBeVisible();
  await expect(page.getByText("построчная история форварда не публикуется")).toBeVisible();

  await sel.selectOption("1.0.0");
  await page.getByRole("button", { name: "Применить" }).click();
  await expect(page).toHaveURL(/scope=forward&version=1\.0\.0/);
  await expect(page.getByText("Показана версия Trend OB retest 1.0.0: форвард считается по каждой версии отдельно.")).toBeVisible();
  await expect(page.getByText("мало данных")).toHaveCount(0);
  await expect(plaque).toBeVisible();

  // опечатка в версии — не «API недоступен», а версия по умолчанию
  await page.goto("/stats?scope=forward&version=9.9.9");
  await expect(page.getByText("Показана версия Trend OB retest 1.1.0: форвард считается по каждой версии отдельно.")).toBeVisible();

  // на live и бэктесте плашки нет, у live в селекторе по-прежнему есть «все»
  await page.goto("/stats");
  await expect(page.getByRole("note")).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "версия стратегии" }).locator("option").first()).toHaveText("все");
  await page.goto("/stats?scope=backtest");
  await expect(page.getByRole("note")).toHaveCount(0);
});

test("форвард: плашка по-английски", async ({ page }) => {
  await mockClient(page, false);
  await page.context().addCookies([{ name: "pl_locale", value: "en", url: "http://localhost:3101" }]);
  await page.goto("/stats?scope=forward");
  await expect(page.getByRole("note")).toHaveText(
    "Forward-test results before 06.11.2026 are invalid: because of an accounting error, trades were closed after 15 minutes instead of 60 hours. A fix and a recalculation are in progress.",
  );
  await expect(page.getByText("not enough data")).toBeVisible();
});
