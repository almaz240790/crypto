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

test("телефон: раскрыта одна панель — последняя добавленная, свайп вниз сворачивает", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls, true);
  await page.goto("/chart/BTCUSDT/4h");
  const term = page.getByTestId("terminal");
  await expect(term.locator("canvas").first()).toBeVisible();
  await page.getByRole("button", { name: /Индикаторы/ }).tap();
  const dlg = page.getByRole("dialog", { name: "Индикаторы" });
  for (const name of [/RSI/, /MACD/, /Stochastic/, /Funding/]) await dlg.getByLabel(name).check();
  await page.getByRole("button", { name: "Готово" }).tap();
  await expect(page.getByRole("button", { name: "Индикаторы (5)" })).toBeVisible();
  const expanded = page.locator('[data-testid^="pane-"] button[aria-expanded="true"]');
  const collapsed = page.locator('[data-testid^="pane-"] button[aria-expanded="false"]');
  await expect(expanded).toHaveCount(1);
  await expect(collapsed).toHaveCount(3);
  // свайп вниз по заголовку раскрытой панели сворачивает её
  const head = page.getByTestId("pane-funding");
  await expect(head.getByRole("button", { name: "свернуть панель Funding" })).toBeVisible();
  const box = (await head.boundingBox())!;
  await page.evaluate(
    ({ x, y }) => {
      const el = document.querySelector('[data-testid="pane-funding"]')!;
      const t = (cy: number) => new Touch({ identifier: 1, target: el, clientX: x, clientY: cy });
      el.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [t(y)], changedTouches: [t(y)] }));
      el.dispatchEvent(new TouchEvent("touchend", { bubbles: true, touches: [], changedTouches: [t(y + 60)] }));
    },
    { x: box.x + 10, y: box.y + 10 },
  );
  await expect(head.getByRole("button", { name: "развернуть панель Funding" })).toBeVisible();
  await expect(collapsed).toHaveCount(4);
});

test("телефон: мультичарт недоступен, есть ссылка в терминал", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls, true);
  await page.goto("/multichart");
  await expect(page.getByText("Мультичарт доступен на десктопе")).toBeVisible();
  await expect(page.getByRole("link", { name: "Открыть терминал" })).toHaveAttribute("href", "/chart/BTCUSDT/4h");
  expect(calls.some((c) => c.startsWith("/v1/chart/candles"))).toBe(false);
});

test("вопрос о графике на телефоне: отдельная кнопка, готовый вопрос, ответ виден сразу", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls, true);
  await page.goto("/chart/BTCUSDT/4h");
  await expect(page.getByTestId("terminal").locator("canvas").first()).toBeVisible();
  await page.getByRole("button", { name: "Спросить", exact: true }).tap();
  const sheet = page.getByRole("dialog", { name: "Вопрос о графике" });
  await sheet.getByRole("button", { name: "Какой сейчас тренд на старших таймфреймах?" }).tap();
  const answer = sheet.getByTestId("ask-answer");
  await expect(answer).toContainText("тренд D1 восходящий");
  await expect(answer).toBeInViewport();
  expect(calls.some((c) => c.startsWith("/v1/chart/ask"))).toBe(true);
});

test("вопрос о графике без Premium: понятное объяснение и ссылка на тарифы вместо формы", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls, true, { drawings: [], layout: null, plan: "pro" });
  await page.goto("/chart/BTCUSDT/4h");
  await expect(page.getByTestId("terminal").locator("canvas").first()).toBeVisible();
  await page.getByRole("button", { name: "Спросить", exact: true }).tap();
  const sheet = page.getByRole("dialog", { name: "Вопрос о графике" });
  await expect(sheet).toContainText("доступны с подпиской Premium");
  await expect(sheet.getByRole("link", { name: "Подписка" })).toBeVisible();
  await expect(sheet.getByLabel("текст вопроса")).toHaveCount(0);
});

test("карточка значений на телефоне: индикаторы свёрнуты, крестик закрывает", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls, true);
  await page.goto("/chart/BTCUSDT/4h");
  const term = page.getByTestId("terminal");
  await expect(term.locator("canvas").first()).toBeVisible();
  const box = (await term.boundingBox())!;
  const x = box.x + box.width * 0.5, y = box.y + box.height * 0.5;
  // долгое касание: перекрестие LWC включается после 240 мс
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await page.waitForTimeout(500);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const ohlc = page.getByTestId("ohlc");
  await expect(ohlc).toBeVisible();
  await expect(ohlc).toContainText("O ");
  // значения индикаторов — по кнопке
  await expect(ohlc.getByText("EMA", { exact: false })).toBeHidden();
  await ohlc.getByRole("button", { name: /индикаторы \(\d+\)/ }).tap();
  await expect(ohlc.getByText("EMA", { exact: false })).toBeVisible();
  await ohlc.getByRole("button", { name: "закрыть карточку" }).tap();
  await expect(ohlc).toBeHidden();
});

test("телефон: число свечей от ширины — около 6 px на свечу, а не 2 px при 150 свечах", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls, true);
  await page.goto("/chart/BTCUSDT/4h");
  await expect(page.getByTestId("terminal").locator("canvas").first()).toBeVisible();
  const spacing = () =>
    page.evaluate(() => {
      type TS = { getVisibleLogicalRange(): { from: number; to: number } | null; width(): number };
      const ts = (document.querySelector('[data-testid="terminal"]') as HTMLElement & { __chart: { timeScale(): TS } }).__chart.timeScale();
      const r = ts.getVisibleLogicalRange();
      return r ? ts.width() / (r.to - r.from) : 0;
    });
  await expect.poll(spacing).toBeGreaterThan(5);
  expect(await spacing()).toBeLessThan(7.5);
});

test("телефон: шрифт шкал 10 px остаётся после смены темы", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls, true);
  await page.goto("/chart/BTCUSDT/4h");
  await expect(page.getByTestId("terminal").locator("canvas").first()).toBeVisible();
  type Opts = { layout: { fontSize: number; background: { color?: string } } };
  const opts = () => page.evaluate(() => (document.querySelector('[data-testid="terminal"]') as HTMLElement & { __chart: { options(): Opts } }).__chart.options().layout);
  await expect.poll(async () => (await opts()).fontSize).toBe(10);
  for (const theme of ["light", "dark"]) {
    const bg = (await opts()).background.color;
    await page.evaluate((th) => {
      document.documentElement.dataset.theme = th;
    }, theme);
    // тема применилась (фон графика сменился), а шрифт — по-прежнему телефонный, не 11 px
    await expect.poll(async () => (await opts()).background.color).not.toBe(bg);
    expect((await opts()).fontSize).toBe(10);
  }
});
