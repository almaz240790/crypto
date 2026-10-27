import { devices, expect, test } from "@playwright/test";
import { mock } from "./helpers/chart";

/** Терминал на телефоне (план 2A.7): страница не шире экрана, ценовая шкала видна. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { defaultBrowserType, ...pixel5 } = devices["Pixel 5"];
test.use(pixel5);

test("график на телефоне: страница не шире экрана, ценовая шкала видна", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls, true);
  await page.goto("/chart/BTCUSDT/4h");
  await expect(page.getByTestId("terminal").locator("canvas").first()).toBeVisible();
  const m = await page.evaluate(() => ({ inner: window.innerWidth, doc: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(m.inner).toBe(393);
  expect(m.doc).toBeLessThanOrEqual(393);
  expect(m.body).toBeLessThanOrEqual(393);
  const box = await page.getByTestId("terminal").boundingBox();
  expect(Math.round(box!.x + box!.width)).toBeLessThanOrEqual(393);
});

test("рисование на телефоне: горизонтальная линия одним тапом", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls, true);
  await page.goto("/chart/BTCUSDT/4h");
  const term = page.getByTestId("terminal");
  await expect(term.locator("canvas").first()).toBeVisible();
  await page.getByRole("button", { name: "Рисовать" }).tap();
  await page.getByRole("dialog", { name: "Рисование" }).getByRole("button", { name: "Горизонтальная линия" }).tap();
  const box = (await term.boundingBox())!;
  await page.touchscreen.tap(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await expect(page.getByTestId("drawings-count")).toHaveText("рисунков: 1");
});
