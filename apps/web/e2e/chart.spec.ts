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
  await page.getByRole("dialog", { name: "Слои" }).getByLabel("Профиль объёма").check();
  await page.getByRole("button", { name: "Готово" }).click();
  // тип графика
  await page.getByLabel("тип графика").selectOption("heikin");
  await expect(strip).toContainText("Heikin Ashi");
  // настройки сохраняются между загрузками
  await page.reload();
  await expect(page.getByRole("button", { name: "Индикаторы (3)" })).toBeVisible();
  await page.getByRole("button", { name: "Слои" }).click();
  await expect(page.getByRole("dialog", { name: "Слои" }).getByLabel("Профиль объёма")).toBeChecked();
});

test("график: смена инструмента и сигналы по инструменту", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls, true);
  await page.goto("/chart/BTCUSDT/4h");
  await expect(page.getByText("сигналов по инструменту: 1")).toBeVisible();
  await page.getByLabel("инструмент", { exact: true }).selectOption("ETHUSDT");
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

test("десктоп: тулбар и горячие клавиши, панель объектов, шаблоны, именованные раскладки, снимок PNG", async ({ page }) => {
  const server = { drawings: [] as Record<string, unknown>[], layout: null as Record<string, unknown> | null, layouts: {} as Record<string, Record<string, unknown>> };
  const calls: string[] = [];
  await mock(page, calls, true, server);
  await page.goto("/chart/BTCUSDT/4h");
  const term = page.getByTestId("terminal");
  await expect(term.locator("canvas").first()).toBeVisible();
  const toolbar = page.getByRole("toolbar", { name: "панель рисования" });
  const objects = page.getByRole("complementary", { name: "панель объектов" });
  await expect(toolbar).toBeVisible();
  await expect(objects).toBeVisible();
  // Alt+H включает горизонтальную линию, клик по графику создаёт рисунок
  await page.keyboard.press("Alt+h");
  await expect(toolbar.getByRole("button", { name: "Горизонтальная линия" })).toHaveAttribute("aria-pressed", "true");
  const box = (await term.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await expect(page.getByTestId("drawings-count")).toHaveText("рисунков: 1");
  await page.keyboard.press("Escape");
  await expect(toolbar.getByRole("button", { name: "Горизонтальная линия" })).toHaveAttribute("aria-pressed", "false");
  // панель объектов: список, блокировка запрещает удаление, разблокировка и удаление
  await objects.getByRole("tab", { name: "Рисунки (1)" }).click();
  await expect(objects).toContainText("Горизонтальная линия");
  await objects.getByRole("button", { name: "заблокировать Горизонтальная линия" }).click();
  await expect(objects.getByRole("button", { name: "удалить Горизонтальная линия" })).toBeDisabled();
  await objects.getByRole("button", { name: "разблокировать Горизонтальная линия" }).click();
  await objects.getByRole("button", { name: "удалить Горизонтальная линия" }).click();
  await expect(page.getByTestId("drawings-count")).toHaveText("рисунков: 0");
  await toolbar.getByRole("button", { name: "отменить" }).click();
  await expect(page.getByTestId("drawings-count")).toHaveText("рисунков: 1");
  // слои из панели
  await objects.getByRole("tab", { name: "Слои" }).click();
  await objects.getByLabel("Ликвидации").check();
  await expect(page.getByRole("button", { name: "Индикаторы (2)" })).toBeVisible();
  // шаблон «Осцилляторы» → три индикатора, панели сброшены
  await objects.getByRole("tab", { name: "Раскладки" }).click();
  await objects.getByRole("button", { name: "Осцилляторы" }).click();
  await expect(page.getByRole("button", { name: "Индикаторы (3)" })).toBeVisible();
  // именованная раскладка: сохранить, применить после «Чистый», удалить
  await objects.getByLabel("имя раскладки").fill("моя");
  await objects.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByRole("status")).toContainText("Раскладка «моя» сохранена");
  expect(Object.keys(server.layouts)).toEqual(["моя"]);
  await objects.getByRole("button", { name: "Чистый" }).click();
  await expect(page.getByRole("button", { name: "Индикаторы (0)" })).toBeVisible();
  await objects.getByRole("button", { name: "моя", exact: true }).click();
  await expect(page.getByRole("button", { name: "Индикаторы (3)" })).toBeVisible();
  await objects.getByRole("button", { name: "удалить раскладку моя" }).click();
  await expect(objects.getByRole("button", { name: "моя", exact: true })).toHaveCount(0);
  expect(Object.keys(server.layouts)).toEqual([]);
  // цифра 6 → D1; скрыть панель объектов
  await page.keyboard.press("6");
  await expect(page).toHaveURL(/\/chart\/BTCUSDT\/1d$/);
  await page.getByRole("button", { name: "Объекты" }).click();
  await expect(objects).toBeHidden();
  // снимок PNG скачивается файлом
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "Снимок" }).click();
  expect((await dl).suggestedFilename()).toMatch(/^platform-BTCUSDT-1d-\d+\.png$/);
});

test("паттерны: вкладка «Найдено», подробности с контекстом и отработкой, слой включается и выключается", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls, true);
  await page.goto("/chart/BTCUSDT/4h");
  await expect(page.getByTestId("terminal").locator("canvas").first()).toBeVisible();
  await expect.poll(() => calls.some((c) => c.startsWith("/v1/chart/patterns?symbol=BTCUSDT&tf=4h"))).toBe(true);
  const objects = page.getByRole("complementary", { name: "панель объектов" });
  await expect(objects.getByRole("tab", { name: "Найдено (4)" })).toHaveAttribute("aria-selected", "true");
  // фигуры (4B.6): подтверждённая с целью и отработкой, формирующаяся без цели
  const figs = objects.getByRole("list", { name: "найденные фигуры" });
  await expect(figs).toContainText("Восходящий канал");
  await expect(figs).toContainText("формируется");
  await figs.getByRole("button", { name: /Двойная вершина/ }).click();
  await expect(figs).toContainText("подтверждена закрытием свечи за линией");
  await expect(figs).toContainText("расчётная цель 94.00, инвалидация 104.20");
  await expect(figs).toContainText("историческая отработка 46 % (n=48, до цели за 20 свечей)");
  await figs.getByRole("button", { name: /Восходящий канал/ }).click();
  await expect(figs).toContainText("геометрия без подтверждения");
  expect(calls.some((c) => c.startsWith("/v1/chart/figures?symbol=BTCUSDT&tf=4h"))).toBe(true);
  const list = objects.getByRole("list", { name: "найденные паттерны" });
  await expect(list).toContainText("Доджи");
  await expect(list).toContainText("Бычье поглощение");
  await expect(list).toContainText("значимый");
  await list.getByRole("button", { name: /Бычье поглощение/ }).click();
  await expect(list).toContainText("подтверждено на закрытии свечи");
  await expect(list).toContainText("после 4 свечей снижения");
  await expect(list).toContainText("снята ликвидность");
  await expect(list).toContainText("историческая отработка 54 % (n=120, 5 свечей)");
  await expect(list).toContainText("не является сигналом");
  // «Объяснить» (2B.15): текст по фактам с подписью и пометкой источника
  await list.getByRole("button", { name: "Объяснить" }).click();
  const expl = list.getByTestId("explanation");
  await expect(expl).toContainText("54 % случаев (n=120)");
  await expect(expl).toContainText("Текст составлен по данным графика");
  await expect(expl).toContainText("Шаблонный текст из фактов");
  expect(calls.some((c) => c.startsWith("/v1/chart/explain"))).toBe(true);
  await list.getByRole("button", { name: /Доджи/ }).click();
  await expect(list).toContainText("мало данных");
  // вопрос о графике (4B.7): текст уходит как данные, ответ с подписью
  const ask = objects.getByRole("form", { name: "вопрос о графике" });
  await ask.getByLabel("текст вопроса").fill("почему зона активна?");
  await ask.getByRole("button", { name: "Спросить" }).click();
  await expect(ask.getByTestId("ask-answer")).toContainText("тренд D1 восходящий");
  await expect(ask.getByTestId("ask-answer")).toContainText("Ответ прошёл проверку");
  expect(calls.some((c) => c.startsWith("/v1/chart/ask"))).toBe(true);
  // слой «Паттерны» в списке слоёв
  await objects.getByRole("tab", { name: "Слои" }).click();
  await expect(objects.getByLabel("Паттерны")).toBeChecked();
  await objects.getByLabel("Паттерны").uncheck();
  await page.reload();
  await page.getByRole("complementary", { name: "панель объектов" }).getByRole("tab", { name: "Слои" }).click();
  await expect(page.getByRole("complementary", { name: "панель объектов" }).getByLabel("Паттерны")).not.toBeChecked();
});

test("алерты на графике: из горизонтальной линии и из листа «Алерт», линия алерта на графике", async ({ page }) => {
  const server = { drawings: [] as Record<string, unknown>[], layout: null as Record<string, unknown> | null, alerts: [] as Record<string, unknown>[] };
  const calls: string[] = [];
  await mock(page, calls, true, server);
  await page.goto("/chart/BTCUSDT/4h");
  const term = page.getByTestId("terminal");
  await expect(term.locator("canvas").first()).toBeVisible();
  await expect(page.getByTestId("drawings-count")).toHaveText("рисунков: 0");
  await page.keyboard.press("Alt+h");
  await expect(page.getByRole("button", { name: /Рисую: Горизонтальная линия/ })).toBeVisible();
  const box = (await term.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.55);
  await expect(page.getByTestId("drawings-count")).toHaveText("рисунков: 1");
  await page.getByRole("button", { name: "алерт на уровне" }).click();
  await expect(page.getByRole("status")).toContainText("Алерт создан: BTCUSDT: цена пересекла");
  expect(server.alerts).toHaveLength(1);
  expect(server.alerts[0]!.drawing_client_id).toBeTruthy();
  await expect(page.getByRole("button", { name: "Алерт (1)" })).toBeVisible();
  // лист: цена подставлена, создаём второй
  await page.getByRole("button", { name: "Алерт (1)" }).click();
  const form = page.getByRole("form", { name: "новый алерт по цене" });
  await expect(form.getByLabel("цена алерта")).not.toHaveValue("");
  await form.getByLabel("цена алерта").fill("120");
  await form.getByLabel("условие цены").selectOption("cross_up");
  await form.getByRole("button", { name: "Создать алерт" }).click();
  await expect(page.getByRole("button", { name: "Алерт (2)" })).toBeVisible();
  expect(server.alerts[1]!.condition).toEqual({ op: "cross_up", price: "120" });
});

test("панели индикаторов: заголовок 24 px, сворачивание и раскрытие", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls);
  await page.goto("/chart/BTCUSDT/4h");
  await expect(page.getByTestId("terminal").locator("canvas").first()).toBeVisible();
  await page.getByRole("button", { name: /Индикаторы/ }).click();
  await page.getByRole("dialog", { name: "Индикаторы" }).getByLabel(/RSI/).check();
  await page.getByRole("button", { name: "Готово" }).click();
  const head = page.getByTestId("pane-rsi");
  await expect(head).toContainText("RSI");
  const paneHeight = () => page.evaluate(() => (document.querySelector('[data-testid="terminal"]') as HTMLElement & { __chart: { panes(): { getHeight(): number }[] } }).__chart.panes()[1]!.getHeight());
  expect(await paneHeight()).toBeGreaterThan(24);
  await head.getByRole("button", { name: "свернуть панель RSI" }).click();
  await expect(head.getByRole("button", { name: "развернуть панель RSI" })).toHaveAttribute("aria-expanded", "false");
  await expect.poll(paneHeight).toBeLessThanOrEqual(24);
  // в свёрнутой панели серия и метка последнего значения скрыты
  const lastLabel = () => page.evaluate(() => (document.querySelector('[data-testid="terminal"]') as HTMLElement & { __chart: { panes(): { getSeries(): { options(): { lastValueVisible: boolean; visible: boolean } }[] }[] } }).__chart.panes()[1]!.getSeries()[0]!.options());
  expect(await lastLabel()).toMatchObject({ visible: false, lastValueVisible: false });
  await head.getByRole("button", { name: "развернуть панель RSI" }).click();
  await expect.poll(paneHeight).toBeGreaterThan(24);
  expect(await lastLabel()).toMatchObject({ visible: true, lastValueVisible: true });
  // удаление индикатора убирает заголовок
  await page.getByRole("button", { name: /Индикаторы/ }).click();
  await page.getByRole("dialog", { name: "Индикаторы" }).getByLabel(/RSI/).uncheck();
  await page.getByRole("button", { name: "Готово" }).click();
  await expect(head).toHaveCount(0);
});

test("рисунок копируется на другой инструмент", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls);
  await page.goto("/chart/BTCUSDT/4h");
  const term = page.getByTestId("terminal");
  await expect(term.locator("canvas").first()).toBeVisible();
  await expect(page.getByTestId("drawings-count")).toHaveText("рисунков: 0");
  await page.keyboard.press("Alt+h");
  await expect(page.getByRole("button", { name: /Рисую: Горизонтальная линия/ })).toBeVisible();
  const box = (await term.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.55);
  await expect(page.getByTestId("drawings-count")).toHaveText("рисунков: 1");
  await page.getByLabel("скопировать на инструмент").selectOption("ETHUSDT");
  await expect(page.getByRole("status")).toContainText("Рисунок скопирован на ETHUSDT");
  expect(calls.some((c) => c.startsWith("/v1/chart/candles?symbol=ETHUSDT"))).toBe(true);
  // исходный инструмент не изменился, у цели появился рисунок
  await expect(page.getByTestId("drawings-count")).toHaveText("рисунков: 1");
  await page.goto("/chart/ETHUSDT/4h");
  await expect(page.getByTestId("drawings-count")).toHaveText("рисунков: 1");
  await expect(page.getByRole("button", { name: "Объекты" })).toBeVisible();
});

test("мультичарт: 2 и 4 графика, смена инструмента и таймфрейма, ссылка в терминал", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls);
  await page.goto("/multichart");
  const cells = page.getByRole("region", { name: /^график / });
  await expect(cells).toHaveCount(2);
  await expect(cells.first().locator("canvas").first()).toBeVisible();
  await expect.poll(() => calls.some((c) => c.startsWith("/v1/chart/candles?symbol=ETHUSDT&tf=4h"))).toBe(true);
  await page.getByRole("button", { name: "4", exact: true }).click();
  await expect(cells).toHaveCount(4);
  await expect(cells.nth(3)).toHaveAttribute("aria-label", "график BNBUSDT 1d");
  // смена инструмента и таймфрейма в первой ячейке
  await cells.first().getByLabel("инструмент").selectOption("ETHUSDT");
  await cells.first().getByLabel("таймфрейм").selectOption("1d");
  await expect(cells.first()).toHaveAttribute("aria-label", "график ETHUSDT 1d");
  await expect.poll(() => calls.some((c) => c.startsWith("/v1/chart/candles?symbol=ETHUSDT&tf=1d"))).toBe(true);
  await expect(cells.first().getByRole("link", { name: "открыть в терминале" })).toHaveAttribute("href", "/chart/ETHUSDT/1d");
  // раскладка сохраняется
  await page.reload();
  await expect(page.getByRole("region", { name: /^график / })).toHaveCount(4);
  await expect(page.getByRole("region", { name: /^график / }).first()).toHaveAttribute("aria-label", "график ETHUSDT 1d");
});

test("масштаб: кнопки «+/−», клавиши, колесо и трекпад, сброс", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls);
  await page.goto("/chart/BTCUSDT/4h");
  const term = page.getByTestId("terminal");
  await expect(term.locator("canvas").first()).toBeVisible();
  await expect(page.getByLabel("состояние")).toContainText("цена");
  type Host = HTMLElement & { __chart: { timeScale(): { getVisibleLogicalRange(): { from: number; to: number } | null } } };
  const range = async () => (await page.evaluate(() => (document.querySelector('[data-testid="terminal"]') as Host).__chart.timeScale().getVisibleLogicalRange())) ?? { from: 0, to: 0 };
  const width = async () => { const r = await range(); return r.to - r.from; };
  await expect.poll(width).toBeGreaterThan(50);
  const w0 = await width();
  await page.getByRole("button", { name: "приблизить" }).click();
  await expect.poll(width).toBeLessThan(w0 * 0.9);
  await page.getByRole("button", { name: "отдалить" }).click();
  await expect.poll(width).toBeGreaterThan(w0 * 0.95);
  await page.keyboard.press("+");
  await expect.poll(width).toBeLessThan(w0 * 0.9);
  // колесо: вертикальное — масштаб, горизонтальное — прокрутка без изменения масштаба
  const box = (await term.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  const w1 = await width();
  await page.mouse.wheel(0, -200);
  await expect.poll(width).toBeLessThan(w1 * 0.8);
  const w2 = await width();
  const from2 = (await range()).from;
  await page.mouse.wheel(-200, 0);
  await expect.poll(async () => (await range()).from).toBeLessThan(from2);
  expect(Math.abs((await width()) - w2)).toBeLessThan(0.5);
  await page.getByRole("button", { name: "показать последние свечи" }).click();
  await expect.poll(width).toBeGreaterThan(w0 * 0.95);
});

test("десктоп: ширина панели объектов меняется перетаскиванием и сохраняется", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls);
  await page.goto("/chart/BTCUSDT/4h");
  await expect(page.getByTestId("terminal").locator("canvas").first()).toBeVisible();
  const aside = page.getByRole("complementary", { name: "панель объектов" });
  const w0 = (await aside.boundingBox())!.width;
  expect(Math.round(w0)).toBe(300);
  const sep = aside.getByRole("separator", { name: "ширина панели объектов" });
  const box = (await sep.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 120, box.y + 200, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await aside.boundingBox())!.width)).toBe(420);
  await sep.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => Math.round((await aside.boundingBox())!.width)).toBe(400);
  await page.reload();
  await expect(page.getByTestId("terminal").locator("canvas").first()).toBeVisible();
  await expect.poll(async () => Math.round((await page.getByRole("complementary", { name: "панель объектов" }).boundingBox())!.width)).toBe(400);
});

test("шкала: логарифмическая и процентная, наложение второго инструмента", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls);
  await page.goto("/chart/BTCUSDT/4h");
  await expect(page.getByTestId("terminal").locator("canvas").first()).toBeVisible();
  await expect(page.getByLabel("состояние")).toContainText("цена");
  type Host = HTMLElement & { __chart: { priceScale(id: string): { options(): { mode: number } }; panes(): { getSeries(): { seriesType(): string }[] }[] } };
  const mode = () => page.evaluate(() => (document.querySelector('[data-testid="terminal"]') as Host).__chart.priceScale("right").options().mode);
  const lines = () => page.evaluate(() => (document.querySelector('[data-testid="terminal"]') as Host).__chart.panes()[0]!.getSeries().filter((s) => s.seriesType() === "Line").length);
  expect(await mode()).toBe(0);
  await page.getByLabel("шкала").selectOption("log");
  await expect.poll(mode).toBe(1);
  const before = await lines();
  await page.getByLabel("наложение").selectOption("ETHUSDT");
  await expect.poll(() => calls.some((c) => c.startsWith("/v1/chart/candles?symbol=ETHUSDT&tf=4h"))).toBe(true);
  await expect.poll(lines).toBe(before + 1);
  await page.getByLabel("шкала").selectOption("percent");
  await expect.poll(mode).toBe(2);
  await page.getByLabel("наложение").selectOption("");
  await expect.poll(lines).toBe(before);
  await page.reload();
  await expect(page.getByTestId("terminal").locator("canvas").first()).toBeVisible();
  await expect(page.getByLabel("шкала")).toHaveValue("percent");
});
