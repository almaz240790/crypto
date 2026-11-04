import { devices, expect, test, type Page } from "@playwright/test";
import { mock } from "./helpers/chart";

/**
 * Управление панелями (ADR-0009, «Управление панелями»; как в TradingView): граница панели с ручкой и курсором
 * row-resize (перетаскивание — высоты, двойной клик — по умолчанию, высоты в настройках), кнопки заголовка
 * «выше / ниже / развернуть / настройки / убрать» (порядок в настройках), «A» у шкалы цены, растянутой вручную,
 * однократная подсказка и цели 44 px под пальцем.
 */

type Host = HTMLElement & { __chart: { panes(): { getHeight(): number; getHTMLElement(): HTMLElement; priceScale(id: string): { options(): { autoScale: boolean } } }[]; timeScale(): { width(): number }; options(): { handleScroll: { vertTouchDrag: boolean } } } };

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
const order = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-testid^=pane-]:not([data-testid=pane-separator]):not([data-testid=pane-grip])")].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).map((e) => e.dataset.testid));
/** Центры ручек границ сверху вниз и что под ними (elementFromPoint): граница или нет. */
const grips = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-testid=pane-grip]")].map((g) => {
      const r = g.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      return { x, y, w: r.width, h: r.height, onSep: !!document.elementFromPoint(x, y)?.closest("[data-testid=pane-separator]") };
    }),
  );
/** Правый край области графика (левый край шкалы цены), px окна. */
const plotRight = (page: Page) => page.evaluate(() => { const h = document.querySelector("[data-testid=terminal]") as Host; return h.getBoundingClientRect().left + h.__chart.timeScale().width(); });

/** Касание с перемещением (CDP, как пальцем): от (x, y) на dy по вертикали. */
async function touchDrag(page: Page, x: number, y: number, dy: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= 6; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + (dy * i) / 6 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

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
    // ручка и линия видны только при наведении; ручка — у правого края графика, левее «A», не на шкале цены
    const grip = sep.getByTestId("pane-grip");
    const gripOpacity = () => grip.evaluate((el) => getComputedStyle(el, "::before").opacity);
    expect(await gripOpacity()).toBe("0");
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await expect.poll(gripOpacity).toBe("1");
    const gb = (await grip.boundingBox())!;
    expect(gb.x + gb.width).toBeLessThanOrEqual((await plotRight(page)) - 20);
    const before = await heights(page);
    await drag(page, b.x + b.width / 2, b.y + b.height / 2, -30);
    await expect.poll(async () => (await heights(page))[1]).toBeLessThanOrEqual(62);
    const after = await heights(page);
    expect(after[0]).toBe(before[0]);
    expect(after[1]! + after[2]!).toBe(before[1]! + before[2]!);
    expect(after[3]).toBe(80);
    await expect.poll(async () => (await saved(page)).paneLayout?.heights["rsi#1"]).toBe(after[1]);
    // в раскладке — только пара у границы: OI не трогали, у него и дальше высота по умолчанию
    expect(Object.keys((await saved(page)).paneLayout!.heights).sort()).toEqual(["macd#1", "rsi#1"]);
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

  test("граница у свёрнутой панели: зона над линией не закрыта заголовком, перетаскивание меняет пару раскрытых", async ({ page }) => {
    await open(page);
    await page.getByTestId("pane-macd").getByRole("button", { name: "свернуть панель MACD 12 26 9" }).click();
    await expect.poll(async () => (await heights(page))[2]).toBe(24);
    // одна граница на пару раскрытых: основная | RSI и RSI | OI (по низу RSI, над заголовком MACD)
    const seps = page.getByRole("separator", { name: "граница панелей" });
    await expect(seps).toHaveCount(2);
    const line = await page.evaluate(() => (document.querySelector("[data-testid=pane-macd]") as HTMLElement).getBoundingClientRect().top);
    const x = (await plotRight(page)) - 400;
    const hits = await page.evaluate(({ x, y }) => [-8, -6, -4, -2, -1].map((dy) => !!document.elementFromPoint(x, y + dy)?.closest("[data-testid=pane-separator]")), { x, y: line });
    expect(hits).toEqual([true, true, true, true, true]);
    const before = await heights(page);
    await drag(page, x, line - 1, -30);
    await expect.poll(async () => (await heights(page))[1]).toBe(before[1]! - 30);
    const after = await heights(page);
    expect(after[2]).toBe(24);
    expect(after[3]).toBe(before[3]! + 30);
  });

  test("восемь панелей, сжатых окном: граница между панелями двигается, основная на своей доле — граница стоит", async ({ page }) => {
    const ids = ["rsi", "macd", "stoch", "atr", "cci", "obv"];
    await open(page, { saved: { ...SAVED, indicators: [SAVED.indicators[0], ...ids.map((id) => ({ uid: `${id}#1`, id, params: {} }))], panels: ["oi", "funding"] } });
    await expect.poll(async () => (await heights(page)).length).toBe(9);
    const h = await heights(page);
    // planPanes сжал панели ниже paneMinPx 48
    expect(Math.max(...h.slice(1))).toBeLessThan(48);
    const seps = page.getByRole("separator", { name: "граница панелей" });
    await expect(seps.first()).toHaveAttribute("data-dir", "none");
    await expect(seps.nth(1)).toHaveAttribute("data-dir", "both");
    const g = (await grips(page))[1]!;
    await drag(page, g.x, g.y, 12);
    await expect.poll(async () => (await heights(page))[1]).toBe(h[1]! + 12);
    expect((await heights(page))[2]).toBe(h[2]! - 12);
    // в раскладке — только пара, в желаемых px (÷ сжатие): больше экранных
    const l = (await saved(page)).paneLayout!;
    expect(Object.keys(l.heights).sort()).toEqual(["macd#1", "rsi#1"]);
    expect(l.heights["rsi#1"]).toBeGreaterThan(h[1]! + 12);
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
    // кнопки — сразу за именем: перекрестие меняет ширину значений, а кнопки на месте
    const rb = (await rsi.boundingBox())!;
    const xs = new Set<number>();
    for (const x of [200, 400, 600, 800]) {
      await page.mouse.move(x, rb.y + 40);
      xs.add(Math.round((await up.boundingBox())!.x));
    }
    expect(xs.size).toBe(1);
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
    // без заливки: метки шкалы не бледнеют — только полоса --accent по левому краю
    expect(await page.getByTestId("scale-hover").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
    // курсор ставит сама шкала LWC (холст наследует его); подсветка поверх — без pointer-events
    const cursor = await page.evaluate(({ x, y }) => getComputedStyle(document.elementFromPoint(x, y)!).cursor, { x: g.x, y: g.top + 40 });
    expect(cursor).toBe("ns-resize");
    await drag(page, g.x, g.top + 30, 40);
    const auto = page.getByRole("button", { name: "автомасштаб: RSI 14" });
    await expect(auto).toBeVisible();
    expect((await geo()).auto[1]).toBe(false);
    // «A» — в углу области графика у шкалы, не на шкале (не закрывает деления и метку значения)
    const ab = (await auto.boundingBox())!;
    expect(ab.x + ab.width).toBeLessThanOrEqual(await plotRight(page));
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
    // на десктопе кнопки — при наведении: подсказка так и говорит, и пока она видна, кнопки первой панели показаны
    await expect(hint).toContainText("Наведите на панель — в её заголовке кнопки");
    await expect(page.getByTestId("pane-rsi").getByRole("button", { name: "переместить RSI 14 ниже" })).toBeVisible();
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
    await expect(help).toContainText("Кнопки в заголовке панели (при наведении)");
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
    // зона границы во всю ширину — тонкая (палец рядом сдвигает график), ручка 44 × 44 видна всегда
    const sep = page.getByRole("separator", { name: "граница панелей" }).first();
    expect((await sep.boundingBox())!.height).toBeLessThanOrEqual(16);
    expect(await sep.getByTestId("pane-grip").evaluate((el) => getComputedStyle(el, "::before").opacity)).toBe("1");
    // ручка не под заголовком панели: в её центре — граница (а не «настроить MACD»)
    const g = await grips(page);
    expect(g).toHaveLength(3);
    for (const x of g) {
      expect(x.onSep).toBe(true);
      expect(Math.min(x.w, x.h)).toBeGreaterThanOrEqual(44);
    }
    // касание ручки ничего не открывает; перетаскивание пальцем меняет пару RSI | MACD (не ниже 72 px под пальцем)
    await page.touchscreen.tap(g[1]!.x, g[1]!.y);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const before = await heights(page);
    await touchDrag(page, g[1]!.x, g[1]!.y, -30);
    await expect.poll(async () => (await heights(page))[1]).toBe(72);
    expect((await heights(page))[2]).toBe(before[2]! + before[1]! - 72);
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
    expect(ab.x + ab.width).toBeLessThanOrEqual(await plotRight(page));
    // смена темы не выключает вертикальный жест пальцем (сдвиг при растянутой шкале)
    await page.evaluate(() => {
      const el = document.documentElement;
      el.dataset.theme = el.dataset.theme === "light" ? "dark" : "light";
    });
    await expect.poll(() => page.evaluate(() => (document.querySelector("[data-testid=terminal]") as Host).__chart.options().handleScroll.vertTouchDrag)).toBe(true);
  });
});

const { defaultBrowserType: _ignored, ...pixel5 } = devices["Pixel 5"];
void _ignored;

test.describe("телефон", () => {
  test.use({ ...pixel5 });

  test("ручка границы — не под заголовками свёрнутых панелей: касание не открывает «⋯», перетаскивание меняет высоты", async ({ page }) => {
    await open(page);
    // RSI и MACD свёрнуты: одна граница основная | OI по низу основной
    const g = await grips(page);
    expect(g).toHaveLength(1);
    expect(g[0]!.onSep).toBe(true);
    await page.touchscreen.tap(g[0]!.x, g[0]!.y);
    await expect(page.getByRole("menu")).toHaveCount(0);
    const before = await heights(page);
    await touchDrag(page, g[0]!.x, g[0]!.y, -30);
    await expect.poll(async () => (await heights(page))[0]).toBeLessThan(before[0]!);
    const after = await heights(page);
    expect(after.slice(1, 3)).toEqual(before.slice(1, 3));
    // OI растёт на столько же, на сколько сжалась основная (высоты LWC округлены — ±1 px)
    expect(Math.abs(after[3]! - before[3]! - (before[0]! - after[0]!))).toBeLessThanOrEqual(1);
    // «?»: кнопки панели на телефоне — в «⋯»
    await page.getByRole("button", { name: "что на графике" }).click();
    await expect(page.getByRole("region", { name: "Как управлять графиком" })).toContainText("Кнопка «⋯» в заголовке панели");
  });

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
