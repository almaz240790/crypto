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

test("рисование: трендовая линия двумя кликами, отмена, удаление клавишей, позиция в журнал", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls, true);
  await page.goto("/chart/BTCUSDT/4h");
  const term = page.getByTestId("terminal");
  await expect(term.locator("canvas").first()).toBeVisible();
  const count = page.getByTestId("drawings-count");
  await expect(count).toHaveText("рисунков: 0");
  await page.getByRole("button", { name: "Рисовать" }).click();
  await page.getByRole("dialog", { name: "Рисование" }).getByRole("button", { name: "Трендовая линия" }).click();
  await expect(page.getByRole("button", { name: /Рисую: Трендовая линия/ })).toBeVisible();
  const box = (await term.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.4);
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.3);
  await expect(count).toHaveText("рисунков: 1");
  await expect(page.getByRole("region", { name: "выбранный рисунок" })).toContainText("Трендовая линия");
  await page.getByRole("button", { name: "закончить рисование" }).click();
  await page.getByRole("button", { name: "отменить" }).click();
  await expect(count).toHaveText("рисунков: 0");
  await page.getByRole("button", { name: "повторить" }).click();
  await expect(count).toHaveText("рисунков: 1");
  // выбор кликом по телу и удаление клавишей
  await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.35);
  await expect(page.getByRole("region", { name: "выбранный рисунок" })).toBeVisible();
  await page.keyboard.press("Delete");
  await expect(count).toHaveText("рисунков: 0");
  // позиция long: вход, стоп, цель → карточка с R:R и ссылкой в журнал
  await page.getByRole("button", { name: "Рисовать" }).click();
  await page.getByRole("dialog", { name: "Рисование" }).getByRole("button", { name: "Позиция Long" }).click();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.6);
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.3);
  await expect(count).toHaveText("рисунков: 1");
  const card = page.getByRole("region", { name: "выбранный рисунок" });
  await expect(card).toContainText("R:R");
  await expect(card.getByRole("link", { name: "в журнал" })).toHaveAttribute("href", /\/journal\?symbol=BTCUSDT&direction=long&entry=/);
  // сохраняется между загрузками
  await page.reload();
  await expect(page.getByTestId("drawings-count")).toHaveText("рисунков: 1");
});

test("синхронизация рисунков: запись на сервер, второе устройство видит, конфликт решается по времени", async ({ page, browser }) => {
  const server = { drawings: [] as Record<string, unknown>[], layout: null as Record<string, unknown> | null };
  const calls: string[] = [];
  await mock(page, calls, true, server);
  await page.goto("/chart/BTCUSDT/4h");
  const term = page.getByTestId("terminal");
  await expect(term.locator("canvas").first()).toBeVisible();
  await page.getByRole("button", { name: "Рисовать" }).click();
  await page.getByRole("dialog", { name: "Рисование" }).getByRole("button", { name: "Горизонтальная линия" }).click();
  const box = (await term.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await expect(page.getByTestId("drawings-count")).toHaveText("рисунков: 1");
  // запись уходит с задержкой 600 мс — ждём появления на «сервере», а не мгновенного индикатора
  await expect.poll(() => server.drawings.length, { timeout: 10000 }).toBe(1);
  expect(server.drawings[0]!.type).toBe("hline");
  await expect(page.getByTestId("drawings-sync")).toHaveText("синхронизировано");
  // второе устройство: чистый контекст, те же серверные данные
  const ctx2 = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page2 = await ctx2.newPage();
  await mock(page2, [], true, server);
  await page2.goto("/chart/BTCUSDT/4h");
  await expect(page2.getByTestId("drawings-count")).toHaveText("рисунков: 1");
  // на втором устройстве удаляем (новее) — первое после перезагрузки тоже без рисунка
  page2.once("dialog", (d) => d.accept());
  await page2.getByRole("button", { name: "Рисовать" }).click();
  await page2.getByRole("dialog", { name: "Рисование" }).getByRole("button", { name: "удалить все" }).click();
  await expect(page2.getByTestId("drawings-count")).toHaveText("рисунков: 0");
  await expect.poll(() => (server.drawings[0]?.deleted_at ? 1 : 0)).toBe(1);
  await ctx2.close();
  await page.reload();
  await expect(page.getByTestId("drawings-count")).toHaveText("рисунков: 0");
});

test("перекрестие: наведение показывает OHLCV и значения индикаторов", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls);
  await page.goto("/chart/BTCUSDT/4h");
  const term = page.getByTestId("terminal");
  await expect(term.locator("canvas").first()).toBeVisible();
  const box = (await term.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.4);
  const ohlc = page.getByTestId("ohlc");
  await expect(ohlc).toBeVisible();
  await expect(ohlc).toContainText("O ");
  await expect(ohlc).toContainText("EMA");
  await page.mouse.move(box.x - 50, box.y - 50);
  await expect(ohlc).toBeHidden();
});
