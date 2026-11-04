import { devices, expect, test, type Page } from "@playwright/test";
import { mock } from "./helpers/chart";

/**
 * Управление панелями (ADR-0009, «Управление панелями»; как в TradingView): граница панели с ручкой и курсором
 * row-resize (перетаскивание — высоты, двойной клик — по умолчанию, высоты в настройках), кнопки заголовка
 * «выше / ниже / развернуть / настройки / убрать» (порядок в настройках), «A» у шкалы цены, растянутой вручную,
 * однократная подсказка и цели 44 px под пальцем.
 */

type Host = HTMLElement & { __chart: { panes(): { getHeight(): number; getHTMLElement(): HTMLElement; priceScale(id: string): { options(): { autoScale: boolean } } }[]; timeScale(): { width(): number } } };

const SAVED = {
  layers_v: 5,
  type: "candles",
  indicators: [
    { uid: "ema#1", id: "ema", params: { period: 20 } },
    { uid: "rsi#1", id: "rsi", params: { period: 14 } },
    { uid: "macd#1", id: "macd", params: {} },
  ],
  markup: { preset: "clean", overrides: {} },
  panels: ["oi"],
  scale: "linear",
  overlay: null,
};

/** Настройки — один раз за тест (перезагрузка читает сохранённое); подсказка уже показана, кроме её теста. */
async function open(page: Page, o: { hint?: boolean; saved?: Record<string, unknown> } = {}) {
  await page.addInitScript(
    ({ saved, hint }) => {
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("pl-terminal", JSON.stringify(saved));
      if (!hint) localStorage.setItem("pl-panes-hint", "1");
    },
    { saved: o.saved ?? SAVED, hint: o.hint ?? false },
  );
  await mock(page, []);
  await page.goto("/chart/BTCUSDT/4h");
  await expect(page.getByTestId("terminal").locator("canvas").first()).toBeVisible();
  await expect(page.getByTestId("pane-oi")).toBeVisible();
}

const heights = (page: Page) => page.evaluate(() => (document.querySelector("[data-testid=terminal]") as Host).__chart.panes().map((p) => Math.round(p.getHeight())));
const saved = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("pl-terminal") ?? "{}") as { paneLayout?: { order: string[]; heights: Record<string, number> }; indicators: { uid: string }[]; panels: string[] });
/** Заголовки панелей сверху вниз. */
const order = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-testid^=pane-]:not([data-testid=pane-separator])")].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).map((e) => e.dataset.testid));

async function drag(page: Page, x: number, y: number, dy: number) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + dy / 2, { steps: 3 });
  await page.mouse.move(x, y + dy, { steps: 3 });
  await page.mouse.up();
}

test.describe("десктоп 1440×900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("граница: курсор row-resize, ручка при наведении, перетаскивание меняет пару панелей, высоты сохраняются; двойной клик — по умолчанию", async ({ page }) => {
    await open(page);
    await expect.poll(() => heights(page)).toEqual([expect.any(Number), 90, 90, 80]);
    const seps = page.getByRole("separator", { name: "граница панелей" });
    await expect(seps).toHaveCount(3);
    const sep = seps.nth(1); // RSI | MACD
    expect(await sep.evaluate((el) => getComputedStyle(el).cursor)).toBe("row-resize");
    const b = (await sep.boundingBox())!;
    expect(b.height).toBeGreaterThanOrEqual(8);
    // ручка и линия видны только при наведении
    const grip = sep.locator("span").last();
    expect(await grip.evaluate((el) => getComputedStyle(el).opacity)).toBe("0");
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await expect.poll(() => grip.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    const before = await heights(page);
    await drag(page, b.x + b.width / 2, b.y + b.height / 2, -30);
    await expect.poll(async () => (await heights(page))[1]).toBeLessThanOrEqual(62);
    const after = await heights(page);
    expect(after[0]).toBe(before[0]);
    expect(after[1]! + after[2]!).toBe(before[1]! + before[2]!);
    expect(after[3]).toBe(80);
    await expect.poll(async () => (await saved(page)).paneLayout?.heights["rsi#1"]).toBe(after[1]);
    // после перезагрузки — те же высоты
    await page.reload();
    await expect(page.getByTestId("pane-oi")).toBeVisible();
    await expect.poll(() => heights(page)).toEqual(after);
    // граница основная | RSI: основная не меньше 55 % (VIEW.desktop.mainMinShare)
    const first = (await seps.first().boundingBox())!;
    await drag(page, first.x + 300, first.y + first.height / 2, -700);
    await expect.poll(async () => (await heights(page))[0]).toBeLessThan(after[0]!);
    const h = await heights(page);
    expect(h[0]! / h.reduce((a, x) => a + x, 0)).toBeGreaterThanOrEqual(0.549);
    // двойной клик — высоты по умолчанию, раскладка без высот
    const again = (await seps.nth(1).boundingBox())!;
    await page.mouse.dblclick(again.x + again.width / 2, again.y + again.height / 2);
    await expect.poll(async () => (await heights(page)).slice(1)).toEqual([90, 90, 80]);
    await expect.poll(async () => (await saved(page)).paneLayout).toBeUndefined();
  });

  test("«выше / ниже»: порядок меняется и переживает перезагрузку; крайние кнопки недоступны", async ({ page }) => {
    await open(page);
    await expect.poll(() => order(page)).toEqual(["pane-rsi", "pane-macd", "pane-oi"]);
    const rsi = page.getByTestId("pane-rsi");
    // кнопки — при наведении на панель
    const up = rsi.getByRole("button", { name: "переместить RSI 14 выше" });
    await expect(up).toBeHidden();
    await rsi.hover();
    await expect(up).toBeVisible();
    await expect(up).toBeDisabled();
    await expect(up).toHaveAttribute("title", "переместить RSI 14 выше");
    await rsi.getByRole("button", { name: "переместить RSI 14 ниже" }).click();
    await expect.poll(() => order(page)).toEqual(["pane-macd", "pane-rsi", "pane-oi"]);
    const oi = page.getByTestId("pane-oi");
    await oi.hover();
    await expect(oi.getByRole("button", { name: "переместить Открытый интерес ниже" })).toBeDisabled();
    await oi.getByRole("button", { name: "переместить Открытый интерес выше" }).click();
    await expect.poll(() => order(page)).toEqual(["pane-macd", "pane-oi", "pane-rsi"]);
    await expect.poll(async () => (await saved(page)).paneLayout?.order).toEqual(["macd#1", "oi", "rsi#1"]);
    await page.reload();
    await expect(page.getByTestId("pane-oi")).toBeVisible();
    await expect.poll(() => order(page)).toEqual(["pane-macd", "pane-oi", "pane-rsi"]);
    // серия RSI — на третьей панели под графиком (порядок самого LWC, не только заголовков)
    const rsiPane = await page.evaluate(() => {
      const ch = (document.querySelector("[data-testid=terminal]") as Host).__chart;
      const head = document.querySelector<HTMLElement>("[data-testid=pane-rsi]")!.getBoundingClientRect().top;
      return ch.panes().findIndex((p) => Math.abs(p.getHTMLElement().getBoundingClientRect().top - head) < 2);
    });
    expect(rsiPane).toBe(3);
  });

  test("«развернуть»: панель на весь график, остальные и основная — заголовки, легенда скрыта; «вернуть панели»", async ({ page }) => {
    await open(page);
    const macd = page.getByTestId("pane-macd");
    await macd.hover();
    await macd.getByRole("button", { name: "развернуть MACD 12 26 9 на весь график" }).click();
    await expect.poll(async () => (await heights(page))[2]).toBeGreaterThan(600);
    const h = await heights(page);
    expect([h[0], h[1], h[3]]).toEqual([24, 24, 24]);
    // легенда (testid «legend», под перекрестием — «ohlc») скрыта
    const legend = page.locator("[data-testid=legend], [data-testid=ohlc]");
    await expect(legend).toBeHidden();
    await expect(page.getByTestId("pane-rsi").getByRole("button", { name: "развернуть панель RSI 14" })).toHaveAttribute("aria-expanded", "false");
    // нажатая кнопка в заголовке развёрнутой панели — «вернуть панели»
    await macd.hover();
    const restore = macd.getByRole("button", { name: "вернуть панели" });
    await expect(restore).toHaveAttribute("aria-pressed", "true");
    await restore.click();
    await expect.poll(async () => (await heights(page)).slice(1)).toEqual([90, 90, 80]);
    await expect(legend).toBeVisible();
    // временный вид: в настройках ничего нет
    expect((await saved(page)).paneLayout).toBeUndefined();
  });

  test("«убрать» убирает индикатор и панель данных; «настройки» — окно параметров экземпляра", async ({ page }) => {
    await open(page);
    const rsi = page.getByTestId("pane-rsi");
    await rsi.hover();
    await rsi.getByRole("button", { name: "настроить RSI 14" }).click();
    const dlg = page.getByRole("dialog", { name: "Параметры RSI 14" });
    await expect(dlg).toBeVisible();
    await dlg.getByLabel(/Период/).fill("21");
    await dlg.getByLabel(/Период/).press("Enter");
    await expect(page.getByTestId("pane-rsi")).toContainText("RSI 21");
    await page.keyboard.press("Escape");
    const oi = page.getByTestId("pane-oi");
    await oi.hover();
    await oi.getByRole("button", { name: "убрать Открытый интерес" }).click();
    await expect(oi).toHaveCount(0);
    await expect.poll(async () => (await saved(page)).panels).toEqual([]);
    const macd = page.getByTestId("pane-macd");
    await macd.hover();
    await macd.getByRole("button", { name: "убрать MACD 12 26 9" }).click();
    await expect(macd).toHaveCount(0);
    await expect.poll(async () => (await saved(page)).indicators.map((i) => i.uid)).toEqual(["ema#1", "rsi#1"]);
    // оставшаяся панель — высоты по умолчанию, основная — остаток
    await expect.poll(async () => (await heights(page)).slice(1)).toEqual([90]);
  });

  test("шкала RSI: курсор ns-resize и подсветка; перетаскивание — «A», клик по «A» — автомасштаб; основная — двойной клик по шкале", async ({ page }) => {
    await open(page);
    const geo = () =>
      page.evaluate(() => {
        const ch = (document.querySelector("[data-testid=terminal]") as Host).__chart;
        const r = ch.panes()[1]!.getHTMLElement().getBoundingClientRect();
        const t = document.querySelector("[data-testid=terminal]")!.getBoundingClientRect();
        return { x: t.left + ch.timeScale().width() + 20, top: r.top, main: t.top + 200, auto: ch.panes().map((p) => p.priceScale("right").options().autoScale) };
      });
    const g = await geo();
    await page.mouse.move(g.x, g.top + 40);
    await expect(page.getByTestId("scale-hover")).toBeVisible();
    // курсор ставит сама шкала LWC (холст наследует его); подсветка поверх — без pointer-events
    const cursor = await page.evaluate(({ x, y }) => getComputedStyle(document.elementFromPoint(x, y)!).cursor, { x: g.x, y: g.top + 40 });
    expect(cursor).toBe("ns-resize");
    await drag(page, g.x, g.top + 30, 40);
    const auto = page.getByRole("button", { name: "автомасштаб: RSI 14" });
    await expect(auto).toBeVisible();
    expect((await geo()).auto[1]).toBe(false);
    await auto.click();
    await expect(auto).toHaveCount(0);
    expect((await geo()).auto[1]).toBe(true);
    // основная панель: растянули — «A»; двойной клик по шкале — автомасштаб, вид по времени не сбрасывается
    await drag(page, g.x, g.main, 80);
    const mainAuto = page.getByRole("button", { name: "автомасштаб: цена" });
    await expect(mainAuto).toBeVisible();
    await page.mouse.dblclick(g.x, g.main);
    await expect(mainAuto).toHaveCount(0);
    expect((await geo()).auto[0]).toBe(true);
  });

  test("подсказка — один раз: с первой панелью под графиком, закрывается; после перезагрузки её нет", async ({ page }) => {
    await open(page, { hint: true });
    const hint = page.getByTestId("panes-hint");
    await expect(hint).toBeVisible();
    await expect(hint).toContainText("Потяните границу — высота панели");
    // плашка поверх графика: колонка графика той же высоты
    await hint.getByRole("button", { name: "закрыть подсказку" }).click();
    await expect(hint).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("pane-oi")).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page.getByTestId("panes-hint")).toHaveCount(0);
  });

  test("«?»: раздел «Как управлять графиком»", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "что на графике" }).click();
    const help = page.getByRole("dialog", { name: "Что на графике" }).getByRole("region", { name: "Как управлять графиком" });
    await expect(help).toContainText("Колесо мыши или щипок");
    await expect(help).toContainText("Шкала цен справа");
    await expect(help).toContainText("«A» или двойной клик по шкале");
    await expect(help).toContainText("Граница между панелями");
    await expect(help).toContainText("Горячие клавиши");
  });
});

test.describe("палец: планшет 1024×768", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 1024, height: 768 } });

  test("кнопки заголовка видны всегда, все цели панели — не меньше 44 × 44; граница 44 px с ручкой", async ({ page }) => {
    await open(page);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const rsi = page.getByTestId("pane-rsi");
    await expect(rsi.getByRole("button", { name: "переместить RSI 14 ниже" })).toBeVisible();
    const sizes = await page.locator("[data-testid^=pane-] button").evaluateAll((els) => els.filter((e) => e.getClientRects().length > 0).map((e) => [e.getAttribute("aria-label"), e.getBoundingClientRect().width, e.getBoundingClientRect().height] as const));
    expect(sizes.length).toBeGreaterThanOrEqual(15);
    for (const [name, w, h] of sizes) {
      expect(w, String(name)).toBeGreaterThanOrEqual(44);
      expect(h, String(name)).toBeGreaterThanOrEqual(44);
    }
    const sep = page.getByRole("separator", { name: "граница панелей" }).first();
    expect((await sep.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await sep.locator("span").last().evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    // «A» под пальцем — тоже 44
    await page.evaluate(() => {
      const ch = (document.querySelector("[data-testid=terminal]") as HTMLElement & { __chart: { panes(): { priceScale(id: string): { applyOptions(o: object): void } }[] } }).__chart;
      ch.panes()[1]!.priceScale("right").applyOptions({ autoScale: false });
      window.dispatchEvent(new PointerEvent("pointerup"));
    });
    const auto = page.getByRole("button", { name: "автомасштаб: RSI 14" });
    await expect(auto).toBeVisible();
    const ab = (await auto.boundingBox())!;
    expect(Math.min(ab.width, ab.height)).toBeGreaterThanOrEqual(44);
  });
});

const { defaultBrowserType: _ignored, ...pixel5 } = devices["Pixel 5"];
void _ignored;

test.describe("телефон", () => {
  test.use({ ...pixel5 });

  test("действия панели — в меню «⋯» (44 px): «ниже» меняет порядок", async ({ page }) => {
    await open(page);
    const rsi = page.getByTestId("pane-rsi");
    const more = rsi.getByRole("button", { name: "действия с панелью RSI 14" });
    const b = (await more.boundingBox())!;
    expect(Math.min(b.width, b.height)).toBeGreaterThanOrEqual(44);
    await more.click();
    await page.getByRole("menuitem", { name: "Ниже" }).click();
    await expect.poll(() => order(page)).toEqual(["pane-macd", "pane-rsi", "pane-oi"]);
  });
});
