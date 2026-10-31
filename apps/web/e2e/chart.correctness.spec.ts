import { expect, test, type Page } from "@playwright/test";
import { FIRST_PAGE, H4, SUBCENT, T0, mock } from "./helpers/chart";

/**
 * Корректность графика (ADR-0006, PR «График: корректность»): формат цен по шагу инструмента, история слева
 * без каскада и без сдвига вида, закрытие свечи без сброса вида, число свечей от ширины, панели деривативов
 * не сдвигают начальный вид, карта ликвидаций на 1W без подмены объёмом, светлая тема перечитывается сразу.
 */

type Range = { from: number; to: number };
type SeriesInfo = { type: string; len: number; first: number | null; last: number | null; color: string | null; pf: { type: string; precision?: number; minMove: number } };

async function ready(page: Page) {
  await expect(page.getByTestId("terminal").locator("canvas").first()).toBeVisible();
  await expect(page.getByLabel("состояние")).toContainText("цена");
}

/** Серии панели: тип, число точек, цвет и формат цены — из __chart (LWC). */
function seriesOf(page: Page, pane = 0): Promise<SeriesInfo[]> {
  return page.evaluate((pane) => {
    type S = { seriesType(): string; data(): { time: number }[]; options(): { color?: string; priceFormat: { type: string; precision?: number; minMove: number } } };
    const ch = (document.querySelector('[data-testid="terminal"]') as HTMLElement & { __chart: { panes(): { getSeries(): S[] }[] } }).__chart;
    return (ch.panes()[pane]?.getSeries() ?? []).map((s) => {
      const d = s.data();
      const pf = s.options().priceFormat;
      return { type: s.seriesType(), len: d.length, first: d[0]?.time ?? null, last: d.at(-1)?.time ?? null, color: s.options().color ?? null, pf: { type: pf.type, precision: pf.precision, minMove: pf.minMove } };
    });
  }, pane);
}

/** Формат значения той же функцией, что рисует шкалу серии. */
function formatWith(page: Page, pane: number, index: number, value: number): Promise<string> {
  return page.evaluate(
    ({ pane, index, value }) => {
      type S = { options(): { priceFormat: { formatter?: (v: number) => string } } };
      const ch = (document.querySelector('[data-testid="terminal"]') as HTMLElement & { __chart: { panes(): { getSeries(): S[] }[] } }).__chart;
      return ch.panes()[pane]!.getSeries()[index]!.options().priceFormat.formatter?.(value) ?? "нет форматтера";
    },
    { pane, index, value },
  );
}

const logical = (page: Page) =>
  page.evaluate(() => (document.querySelector('[data-testid="terminal"]') as HTMLElement & { __chart: { timeScale(): { getVisibleLogicalRange(): Range | null } } }).__chart.timeScale().getVisibleLogicalRange());
const timeRange = (page: Page) =>
  page.evaluate(() => (document.querySelector('[data-testid="terminal"]') as HTMLElement & { __chart: { timeScale(): { getVisibleRange(): Range | null } } }).__chart.timeScale().getVisibleRange());
const setLogical = (page: Page, r: Range) =>
  page.evaluate((r) => (document.querySelector('[data-testid="terminal"]') as HTMLElement & { __chart: { timeScale(): { setVisibleLogicalRange(r: Range): void } } }).__chart.timeScale().setVisibleLogicalRange(r), r);
const barSpacing = (page: Page) =>
  page.evaluate(() => {
    const ts = (document.querySelector('[data-testid="terminal"]') as HTMLElement & { __chart: { timeScale(): { getVisibleLogicalRange(): Range | null; width(): number } } }).__chart.timeScale();
    const r = ts.getVisibleLogicalRange();
    return r ? ts.width() / (r.to - r.from) : 0;
  });
const mainLen = async (page: Page) => (await seriesOf(page))[0]?.len ?? 0;
const olderCalls = (calls: string[]) => calls.filter((c) => c.startsWith("/v1/chart/candles") && c.includes("before=")).length;

test("монета дешевле цента (шаг 1e-7): деления шкалы, цена в шапке, уровни и перекрестие — не «0.00»", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls);
  await page.goto(`/chart/${SUBCENT}/4h`);
  await ready(page);
  const strip = page.getByLabel("состояние");
  // шаг из API в записи «1.000E-7»: 7 знаков, а не 6 и не 2
  await expect(strip).toContainText(/цена\s0\.00\d{5}(?!\d)/);
  await expect(strip).not.toContainText(/цена\s0\.00(?!\d)/);
  const main = (await seriesOf(page))[0]!;
  expect(main.pf).toMatchObject({ precision: 7, minMove: 1e-7 });
  expect(await formatWith(page, 0, 0, 0.004928)).toBe("0.0049280");
  // уровни в «Найдено» — с точностью инструмента
  const levels = page.getByRole("complementary", { name: "панель объектов" }).getByRole("list", { name: "уровни поддержки и сопротивления" });
  await expect(levels).toContainText("сопротивление");
  const prices = await levels.locator("span.num").allTextContents();
  expect(prices.length).toBeGreaterThan(0);
  for (const p of prices) expect(p).toMatch(/^0\.00\d{5}(–0\.00\d{5})?$/);
  // карточка перекрестия
  const box = (await page.getByTestId("terminal").boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.4);
  await expect(page.getByTestId("ohlc")).toContainText(/O\s0\.00\d{5}/);
});

test("панели: фандинг в процентах с 4 знаками, OI компактно; общий для графика priceFormatter не задан", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls);
  await page.goto("/chart/BTCUSDT/4h");
  await ready(page);
  await page.getByRole("button", { name: /Индикаторы/ }).click();
  const dlg = page.getByRole("dialog", { name: "Индикаторы" });
  await dlg.getByLabel(/Funding/).check();
  await dlg.getByLabel(/Open interest/).check();
  await page.getByRole("button", { name: "Готово" }).click();
  await expect(page.getByTestId("pane-oi")).toBeVisible();
  // панели 1 и 2: фандинг и OI (порядок добавления)
  await expect.poll(async () => (await seriesOf(page, 1))[0]?.len ?? 0).toBeGreaterThan(0);
  expect(await formatWith(page, 1, 0, 0.01)).toBe("0.0100 %");
  expect(await formatWith(page, 2, 0, 7_817_858_292)).toBe("7.82B");
  const localization = await page.evaluate(() => (document.querySelector('[data-testid="terminal"]') as HTMLElement & { __chart: { options(): { localization: { priceFormatter?: unknown } } } }).__chart.options().localization.priceFormatter ?? null);
  expect(localization).toBeNull();
  // точки панелей — только на времени свечей: точка раньше первой свечи отброшена
  const oi = (await seriesOf(page, 2))[0]!;
  expect(oi.first).toBe(T0);
});

test("с панелью OI график открывается на последних свечах, без подгрузки истории", async ({ page }) => {
  const calls: string[] = [];
  await page.addInitScript(() => {
    const layers = { structure: true, zones: true, levels: false, signals: false, patterns: false, figures: true, volume_profile: false, sr: true, liq_map: true };
    localStorage.setItem("pl-terminal", JSON.stringify({ type: "candles", indicators: [{ id: "ema", params: { period: 50 } }], layers, layers_v: 4, panels: ["oi"], scale: "linear", overlay: null }));
  });
  await mock(page, calls);
  await page.goto("/chart/BTCUSDT/4h");
  await ready(page);
  await expect(page.getByTestId("pane-oi")).toBeVisible();
  await page.waitForTimeout(1500);
  const r = (await timeRange(page))!;
  // последняя (текущая) свеча в кадре; раньше вид уезжал на одну порцию (84 дня на H4) в прошлое
  expect(r.to).toBeGreaterThanOrEqual(T0 + FIRST_PAGE * H4);
  expect(olderCalls(calls)).toBe(0);
  expect(await mainLen(page)).toBe(FIRST_PAGE + 1);
});

test("история слева: один запрос на подход к краю, вид остаётся на тех же свечах, индикатор считается и по ней", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls);
  await page.goto("/chart/BTCUSDT/4h");
  await ready(page);
  await expect.poll(() => mainLen(page)).toBe(FIRST_PAGE + 1);
  // пользователь у левого края: на экране свечи 20…120 первой порции
  await setLogical(page, { from: 20, to: 120 });
  await expect.poll(() => mainLen(page)).toBe(FIRST_PAGE + 1 + 500);
  // раньше одна прокрутка к краю запускала каскад (21 запрос) и уводила вид на годы назад
  await page.waitForTimeout(1500);
  expect(olderCalls(calls)).toBe(1);
  expect(await timeRange(page)).toEqual({ from: T0 + 20 * H4, to: T0 + 120 * H4 });
  const lr = (await logical(page))!;
  expect(lr.from).toBeCloseTo(520, 1);
  // одна модель свечей: EMA пересчитана и на подгруженной истории, свежий край не выгружен
  const series = await seriesOf(page);
  const ema = series.filter((s) => s.type === "Line").sort((a, b) => b.len - a.len)[0]!;
  expect(ema.first!).toBeLessThan(T0);
  expect(series[0]!.last).toBe(T0 + FIRST_PAGE * H4);
  // отошли от края и вернулись — следующая порция
  await setLogical(page, { from: 300, to: 400 });
  await setLogical(page, { from: 10, to: 110 });
  await expect.poll(() => mainLen(page)).toBe(FIRST_PAGE + 1 + 1000);
  await page.waitForTimeout(800);
  expect(olderCalls(calls)).toBe(2);
});

test("закрытие свечи по WebSocket: масштаб, прокрутка и подгруженная история сохраняются", async ({ page }) => {
  const calls: string[] = [];
  const sockets: { send(m: string): void }[] = [];
  await page.routeWebSocket(/\/v1\/ws/, (ws) => {
    sockets.push(ws);
    ws.onMessage(() => {});
  });
  await mock(page, calls);
  await page.goto("/chart/BTCUSDT/4h");
  await ready(page);
  await expect(page.getByLabel("состояние")).toContainText("онлайн");
  // подгрузили историю и встали в середину
  await setLogical(page, { from: 30, to: 130 });
  await expect.poll(() => mainLen(page)).toBe(FIRST_PAGE + 1 + 500);
  await setLogical(page, { from: 600, to: 680 });
  await page.waitForTimeout(300);
  const view = (await timeRange(page))!;
  // минутная свеча из следующего интервала H4: текущая закрывается, начинается новая
  const t = T0 + (FIRST_PAGE + 1) * H4;
  sockets[0]!.send(JSON.stringify({ t: "candle", s: "BTCUSDT", tf: "1m", c: { t, o: "101", h: "102", l: "100", c: "101.5", v: "5" } }));
  await expect.poll(() => mainLen(page)).toBe(FIRST_PAGE + 2 + 500);
  await page.waitForTimeout(300);
  expect(await timeRange(page)).toEqual(view);
  const lr = (await logical(page))!;
  expect(lr.from).toBeCloseTo(600, 1);
  expect(lr.to).toBeCloseTo(680, 1);
  const main = (await seriesOf(page))[0]!;
  expect(main.first).toBe(T0 - 500 * H4);
  expect(main.last).toBe(t);
});

test("сброс вида: число свечей от ширины (около 8 px на свечу), а не 150 — при загрузке, кнопкой и двойным кликом", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls);
  await page.goto("/chart/BTCUSDT/4h");
  await ready(page);
  await expect.poll(() => barSpacing(page)).toBeGreaterThan(7);
  expect(await barSpacing(page)).toBeLessThan(9);
  await page.getByRole("button", { name: "отдалить" }).click();
  await page.getByRole("button", { name: "отдалить" }).click();
  await expect.poll(() => barSpacing(page)).toBeLessThan(6);
  await page.getByRole("button", { name: "показать последние свечи" }).click();
  await expect.poll(() => barSpacing(page)).toBeGreaterThan(7);
  await page.getByRole("button", { name: "приблизить" }).click();
  await page.getByRole("button", { name: "приблизить" }).click();
  await expect.poll(() => barSpacing(page)).toBeGreaterThan(10);
  const box = (await page.getByTestId("terminal").boundingBox())!;
  await page.mouse.dblclick(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await expect.poll(() => barSpacing(page)).toBeLessThan(9);
  expect(await barSpacing(page)).toBeGreaterThan(7);
});

test("1W: открытый интерес не совпадает со свечами — карты ликвидаций нет, вместо неё короткое пояснение", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls);
  await page.goto("/chart/BTCUSDT/1w");
  await ready(page);
  const objects = page.getByRole("complementary", { name: "панель объектов" });
  await expect(objects.getByTestId("liq-unavailable")).toContainText("Карта ликвидаций на этом таймфрейме недоступна");
  await expect(objects.getByRole("list", { name: "уровни поддержки и сопротивления" })).not.toContainText("Ликвидации");
  await objects.getByRole("tab", { name: "Слои" }).click();
  await expect(objects).toContainText("нет данных открытого интереса на этом таймфрейме");
  // на 4h данные совпадают — карта есть, пояснения нет
  await page.goto("/chart/BTCUSDT/4h");
  await ready(page);
  const objects4h = page.getByRole("complementary", { name: "панель объектов" });
  await expect(objects4h.getByRole("list", { name: "уровни поддержки и сопротивления" })).toContainText("Ликвидации");
  await expect(objects4h.getByTestId("liq-unavailable")).toHaveCount(0);
});

test("светлая тема: слои, индикаторы и фигуры перечитывают токены сразу после переключения", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls);
  await page.goto("/chart/BTCUSDT/4h");
  await ready(page);
  const token = (name: string) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim().toLowerCase(), name);
  const lineColors = async () => (await seriesOf(page)).filter((s) => s.type === "Line").map((s) => (s.color ?? "").toLowerCase());
  await expect.poll(async () => (await lineColors()).length).toBeGreaterThan(1);
  const darkInd = await token("--ind-1");
  const darkAccent = await token("--accent");
  expect(await lineColors()).toContain(darkInd);
  expect(await lineColors()).toContain(darkAccent);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  const lightInd = await token("--ind-1");
  const lightAccent = await token("--accent");
  expect(lightInd).not.toBe(darkInd);
  // EMA (--ind-1) и линия фигуры (--accent) — в светлой палитре, тёмной не осталось
  await expect.poll(lineColors).toContain(lightInd);
  await expect.poll(lineColors).toContain(lightAccent);
  expect(await lineColors()).not.toContain(darkAccent);
  expect(await lineColors()).not.toContain(darkInd);
});
