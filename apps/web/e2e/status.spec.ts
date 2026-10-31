import { expect, test } from "@playwright/test";

/** Статус-страница (план 6.7, задача 2.16): компоненты, инциденты за 7 дней, ссылка в подвале. */

test("статус: компоненты и инциденты", async ({ page }) => {
  await page.goto("/status");
  await expect(page.getByRole("heading", { name: "Статус системы" })).toBeVisible();
  await expect(page.getByText("Общий статус: с перебоями")).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: "Свечи H4" }).first();
  await expect(row).toContainText("с перебоями");
  await expect(row).toContainText("100.00 %");
  await expect(page.getByRole("row").filter({ hasText: "Движок сигналов" }).first()).toContainText("99.80 %");
  const incidents = page.getByRole("row").filter({ hasText: "ещё открыт" });
  await expect(incidents).toContainText("Свечи H4");
  await expect(page.getByRole("row").filter({ hasText: "23.10" }).first()).toContainText("не работает");
});

test("статус: ссылка из подвала", async ({ page }) => {
  await page.goto("/stats");
  await page.getByRole("contentinfo").getByRole("link", { name: "Статус системы" }).first().click();
  await expect(page).toHaveURL(/\/status$/);
  await expect(page.getByRole("heading", { name: "Статус системы" })).toBeVisible();
});
