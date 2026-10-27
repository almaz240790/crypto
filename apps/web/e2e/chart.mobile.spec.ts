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

test("телефон: long-press включает липкое перекрестие, тап выключает; лист тянется до 90 %", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls, true);
  await page.goto("/chart/BTCUSDT/4h");
  const term = page.getByTestId("terminal");
  await expect(term.locator("canvas").first()).toBeVisible();
  const box = (await term.boundingBox())!;
  const x = box.x + box.width * 0.5, y = box.y + box.height * 0.4;
  // long-press: pointerdown (touch) без движения > 300 мс
  await page.evaluate(
    ({ x, y }) => {
      const el = document.querySelector('[data-testid="terminal"]')!;
      const opts = { bubbles: true, clientX: x, clientY: y, pointerType: "touch", pointerId: 1, isPrimary: true };
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
    },
    { x, y },
  );
  await page.waitForTimeout(400);
  await expect(term).toHaveAttribute("data-sticky", "1");
  await page.evaluate(
    ({ x, y }) => {
      const el = document.querySelector('[data-testid="terminal"]')!;
      el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: x, clientY: y, pointerType: "touch", pointerId: 1, isPrimary: true }));
    },
    { x, y },
  );
  await expect(term).toHaveAttribute("data-sticky", "1"); // после отпускания остаётся
  // короткий тап — выход из режима
  await page.evaluate(
    ({ x, y }) => {
      const el = document.querySelector('[data-testid="terminal"]')!;
      const o = { bubbles: true, clientX: x + 40, clientY: y + 40, pointerType: "touch", pointerId: 2, isPrimary: true };
      el.dispatchEvent(new PointerEvent("pointerdown", o));
      el.dispatchEvent(new PointerEvent("pointerup", o));
    },
    { x, y },
  );
  await expect(term).not.toHaveAttribute("data-sticky", "1");
  // лист: 50 % по умолчанию, тянется до 90 %
  await page.getByRole("button", { name: "Индикаторы (1)" }).tap();
  const sheet = page.getByRole("dialog", { name: "Индикаторы" });
  await expect(sheet).toHaveAttribute("data-height", "50");
  const handle = sheet.getByRole("separator");
  await handle.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hx = r.x + r.width / 2, hy = r.y + r.height / 2;
    const mk = (t: string, cy: number) => el.dispatchEvent(new PointerEvent(t, { bubbles: true, clientX: hx, clientY: cy, pointerType: "touch", pointerId: 3, isPrimary: true }));
    mk("pointerdown", hy);
    mk("pointermove", hy - 300);
    mk("pointerup", hy - 300);
  });
  await expect(sheet).toHaveAttribute("data-height", "90");
});
