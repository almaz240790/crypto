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
