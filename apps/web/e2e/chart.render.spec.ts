import { devices, expect, test, type Page } from "@playwright/test";
import { RICH_ALERTS, SUBCENT, mock } from "./helpers/chart";
import { census, installCensus, intersects, tickTexts, violations, type Census, type Overlay } from "./helpers/census";

/**
 * Перепись подписей графика на заглушке API (план 2B.2, ADR-0008, §14.3): на холстах нет текста на тексте,
 * шрифт не мельче 11 px, под метками шкалы нет делений, текущая цена не закрыта, подписей не больше бюджета
 * (8 десктоп / 4 телефон), у монеты дешевле цента не меньше 4 делений и нет «0.00». Плюс наведение, выбор,
 * легенда «?» и миграция сохранения v4.
 */

const { defaultBrowserType: _ignored, ...pixel5 } = devices["Pixel 5"];
void _ignored;
const DESKTOP = { viewport: { width: 1440, height: 900 } };

type State = "clean" | "structure" | "levels" | "liquidity" | "detailed" | "custom";
const STATES: State[] = ["clean", "structure", "levels", "liquidity", "detailed", "custom"];
const RADIO: Record<Exclude<State, "custom">, string> = { clean: "Чистый", structure: "Структура", levels: "Уровни и зоны", liquidity: "Карта ликвидаций", detailed: "Подробный" };
/** Подписи флажков слоёв (DesktopPanels.LAYER_LABEL); «Сигналы» — только вошедшим. */
const LAYER_LABELS = ["Структура", "Зоны", "Макс./мин. дня и недели", "Сигналы", "Паттерны", "Фигуры", "Профиль объёма", "Поддержка и сопротивление", "Карта ликвидаций (оценка)"];

const overlayOf = (page: Page) => page.evaluate(() => (document.querySelector('[data-testid="terminal"]') as (HTMLElement & { __overlay?: () => unknown }) | null)?.__overlay?.() as Overlay | undefined);

async function open(page: Page, o: { symbol?: string; fixture?: "default" | "rich"; authed?: boolean; saved?: string } = {}) {
  await installCensus(page);
  await page.addInitScript((saved) => {
    if (saved) localStorage.setItem("pl-terminal", saved);
    else localStorage.setItem("pl-markup-notice", "1");
  }, o.saved ?? "");
  const calls: string[] = [];
  await mock(page, calls, o.authed ?? false, undefined, { fixture: o.fixture ?? "default" });
  await page.goto(`/chart/${o.symbol ?? "BTCUSDT"}/4h`);
  await expect(page.getByTestId("terminal").locator("canvas").first()).toBeVisible();
  await expect.poll(async () => (await overlayOf(page))?.labels.length ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
  return calls;
}

/** Лист «Слои» (кнопка внизу есть и на десктопе, и на телефоне). */
async function layersSheet(page: Page) {
  const sheet = page.getByRole("dialog", { name: "Слои" });
  if (!(await sheet.isVisible())) await page.getByRole("button", { name: "Слои", exact: true }).click();
  await expect(sheet).toBeVisible();
  return sheet;
}

async function closeSheets(page: Page) {
  const btn = page.getByRole("button", { name: "Слои", exact: true });
  if (await page.getByRole("dialog", { name: "Слои" }).isVisible()) await btn.click();
}

/** Пресет — кликом по радиокнопке; «Свой» — все доступные слои включены поверх текущего пресета. */
async function setState(page: Page, state: State) {
  const before = (await overlayOf(page))?.sceneVersion ?? 0;
  const sheet = await layersSheet(page);
  if (state === "custom") {
    for (const name of LAYER_LABELS) {
      const box = sheet.getByRole("checkbox", { name, exact: true });
      if ((await box.count()) && !(await box.isChecked())) await box.check();
    }
    await expect(sheet.getByRole("radio", { name: "Свой", exact: true })).toBeChecked();
  } else {
    const radio = sheet.getByRole("radio", { name: RADIO[state], exact: true });
    if (!(await radio.isChecked())) await radio.check();
    await expect(radio).toBeChecked();
  }
  // новая сцена дошла до кадра (у «Чистого» сразу после загрузки версия та же)
  if (state !== "clean" || before === 0) await expect.poll(async () => (await overlayOf(page))?.sceneVersion ?? 0).toBeGreaterThan(state === "clean" ? 0 : before);
}

async function setTheme(page: Page, theme: "dark" | "light") {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
  // цвет подписей — токены новой темы: перерисовка без пересборки сцены
  await expect.poll(async () => labelColorsMatch(page)).toBe(true);
}

/** Цвета всех подписей и линий равны --chart-* текущей темы (getComputedStyle). */
async function labelColorsMatch(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="terminal"]') as HTMLElement & { __overlay: () => { labels: { tone: string; color: string }[]; objects: { tone: string; color: string }[] } };
    const o = el.__overlay();
    const css = getComputedStyle(el);
    const tok = (tone: string) => {
      const v = css.getPropertyValue(`--chart-${tone}`).trim().toLowerCase();
      return v;
    };
    const norm = (c: string) => c.trim().toLowerCase();
    return o.labels.every((l) => norm(l.color) === tok(l.tone)) && o.objects.every((x) => norm(x.color) === tok(x.tone));
  });
}

function check(c: Census, what: string, o: { phone: boolean; pepe: boolean }) {
  expect(violations(c), what).toEqual([]);
  const placed = c.overlay.labels.filter((l) => !l.bypassBudget).length;
  expect(placed, `${what}: подписей`).toBeLessThanOrEqual(o.phone ? 4 : 8);
  // отсчёт до закрытия — сразу под меткой цены
  const last = c.lastLabel.rect;
  expect(c.countdownDom, `${what}: отсчёт`).not.toBeNull();
  if (last && c.countdownDom) expect(Math.abs(c.countdownDom.y - (last.y + last.h)), `${what}: отсчёт под ценой`).toBeLessThanOrEqual(3);
  if (o.pepe) {
    const ticks = tickTexts(c);
    expect(ticks.length, `${what}: делений`).toBeGreaterThanOrEqual(4);
    for (const t of ticks) expect(t, what).not.toMatch(/^0\.0+$/);
  }
}

async function runMatrix(page: Page, o: { symbol: string; fixture: "default" | "rich"; authed: boolean; phone: boolean }) {
  await open(page, o);
  const pepe = o.symbol === SUBCENT;
  for (const theme of ["dark", "light"] as const) {
    await setTheme(page, theme);
    for (const state of STATES) {
      // «Свой» поверх «Подробного»; после него — снова пресет (выбор пресета снимает поправки)
      if (state === "custom") {
        // гостю слой «Сигналы» не показывается (M24)
        const sheet = await layersSheet(page);
        await expect(sheet.getByRole("checkbox", { name: "Сигналы", exact: true })).toHaveCount(o.authed ? 1 : 0);
      }
      await setState(page, state);
      const c = await census(page);
      check(c, `${o.fixture}/${o.symbol}/${theme}/${state}`, { phone: o.phone, pepe });
      if (state === "clean" && o.fixture === "default" && !pepe && !o.phone) {
        // «Чистый»: не больше 1 S и 1 R на шкале, не больше 3 подписей, без тепловой карты
        expect(c.overlay.axis.filter((a) => a.style === "outline").length).toBeLessThanOrEqual(2);
        expect(c.overlay.labels.length).toBeLessThanOrEqual(3);
        expect(c.overlay.heatRects).toHaveLength(0);
      }
      if (state === "liquidity" && !o.phone && !pepe) checkGutter(c);
      if (state === "custom" && o.fixture === "rich" && !o.phone) {
        // алерт на цене входа сигнала — одна метка на шкале (склейка), алерт у цены — сдвинут, а не поверх неё
        expect(c.overlay.axis.some((a) => a.merged.length > 0)).toBe(true);
      }
    }
  }
}

/** Точка области свечей, далёкая от всех объектов, подписей и свечей: клик или тап «мимо». */
function emptyPoint(c: Census): { x: number; y: number } {
  const o = c.overlay;
  const pad = (r: { x: number; y: number; w: number; h: number }, d: number) => ({ x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d });
  const busy = [...o.objects.filter((x) => x.rect && x.kind !== "box").map((x) => pad(x.rect!, 18)), ...o.labels.map((l) => pad(l.rect, 8)), ...o.candles.map((r) => pad(r, 4))];
  const boxes = o.objects.filter((x) => x.rect && x.kind === "box").map((x) => x.rect!);
  for (let y = 40; y < c.plot.height * 0.8; y += 6)
    for (let x = 30; x < c.plot.width - 30; x += 6) {
      const p = { x: x - 1, y: y - 1, w: 2, h: 2 };
      if (!busy.some((r) => intersects(r, p)) && !boxes.some((r) => intersects(r, p))) return { x: c.plot.left + x, y: c.plot.top + y };
    }
  throw new Error("нет пустого места на графике");
}

/** Карта ликвидаций в полосе справа: не на свечах, свободная зона после последней свечи. */
function checkGutter(c: Census) {
  const o = c.overlay;
  expect(o.gutter?.mode).toBe("reserved");
  expect(o.free).not.toBeNull();
  expect(o.heatRects.length).toBeGreaterThan(0);
  for (const r of o.heatRects) expect(r.x).toBeGreaterThanOrEqual(o.gutter!.x0 - 0.5);
  expect(o.gutter!.x0).toBeGreaterThanOrEqual(o.free!.x0);
  const lastCandle = o.candles.at(-1)!;
  expect(o.free!.x0).toBeGreaterThanOrEqual(lastCandle.x + lastCandle.w + 2 - 0.5);
  // ни одна сумма ликвидаций не лежит на свече
  for (const l of o.labels.filter((x) => x.layer === "liq_map")) for (const r of o.candles) expect(intersects(l.rect, r)).toBe(false);
}

test.describe("перепись подписей: десктоп 1440×900", () => {
  test.use(DESKTOP);
  test.describe.configure({ timeout: 120_000 });

  test("заглушка по умолчанию: все пресеты и «Свой», тёмная и светлая тема", async ({ page }) => {
    await runMatrix(page, { symbol: "BTCUSDT", fixture: "default", authed: false, phone: false });
  });

  test("насыщенная разметка (rich): все пресеты и «Свой» со всеми 9 слоями", async ({ page }) => {
    await runMatrix(page, { symbol: "BTCUSDT", fixture: "rich", authed: true, phone: false });
  });

  test("1000PEPEUSDT (шаг 1e-7): не меньше 4 делений, нет «0.00»", async ({ page }) => {
    await runMatrix(page, { symbol: SUBCENT, fixture: "default", authed: false, phone: false });
  });

  test("«Карта ликвидаций»: свободная зона держится в пикселях после масштаба у правого края", async ({ page }) => {
    await open(page);
    await setState(page, "liquidity");
    await closeSheets(page);
    const width = async () => {
      const o = (await census(page)).overlay;
      return o.free ? o.free.x1 - o.free.x0 : 0;
    };
    // свободная зона — rightOffsetPixels 104 px; масштаб у правого края держит её в пикселях (±3 px)
    const w0 = await width();
    expect(w0).toBeGreaterThanOrEqual(98);
    expect(w0).toBeLessThanOrEqual(106);
    await page.keyboard.press("+");
    await expect.poll(async () => Math.abs((await width()) - w0)).toBeLessThanOrEqual(3);
    await page.keyboard.press("-");
    await expect.poll(async () => Math.abs((await width()) - w0)).toBeLessThanOrEqual(3);
    checkGutter(await census(page));
  });

  test("смена темы: цвета подписей — новые --chart-*, сцена не пересобирается", async ({ page }) => {
    await open(page, { fixture: "rich", authed: true });
    await setState(page, "detailed");
    const v = (await overlayOf(page))!.sceneVersion;
    await setTheme(page, "light");
    await setTheme(page, "dark");
    expect((await overlayOf(page))!.sceneVersion).toBe(v);
  });

  test("наведение на «Поддержку»: подсказка с ценой по шагу, касаниями и расстоянием; уход курсора прячет её", async ({ page }) => {
    await open(page);
    const c = await census(page);
    const sup = c.overlay.labels.find((l) => l.text === "Поддержка");
    expect(sup, "подпись «Поддержка» на графике").toBeDefined();
    const x = c.plot.left + sup!.rect.x + sup!.rect.w / 2;
    const y = c.plot.top + sup!.rect.y + sup!.rect.h / 2;
    await page.mouse.move(x - 40, y - 60);
    await page.mouse.move(x, y, { steps: 4 });
    const tip = page.getByTestId("object-tooltip");
    await expect(tip).toBeVisible();
    await expect(tip).toHaveAttribute("role", "tooltip");
    await expect(tip).toContainText("Поддержка");
    await expect(tip).toContainText("касаний:");
    await expect(tip).toContainText("% от цены");
    // цена по шагу инструмента (BTCUSDT — 0.1): один знак после точки
    await expect(tip).toContainText(/\d\.\d(?!\d)/);
    // подсказка не заходит на ценовую шкалу
    const tb = (await tip.boundingBox())!;
    expect(tb.x + tb.width).toBeLessThanOrEqual(c.plot.left + c.plot.width + 0.5);
    await page.mouse.move(c.plot.left + 20, c.plot.top + c.plot.height - 4);
    await page.mouse.move(c.plot.left + c.plot.width + c.plot.axisWidth + 40, c.plot.top + 10);
    await expect(tip).toHaveCount(0);
  });

  test("с инструментом рисования подсказки объектов нет", async ({ page }) => {
    await open(page);
    const c = await census(page);
    const sup = c.overlay.labels.find((l) => l.text === "Поддержка")!;
    await page.getByRole("button", { name: "Горизонтальная линия" }).first().click();
    await page.mouse.move(c.plot.left + sup.rect.x + sup.rect.w / 2, c.plot.top + sup.rect.y + sup.rect.h / 2, { steps: 3 });
    await page.waitForTimeout(200);
    await expect(page.getByTestId("object-tooltip")).toHaveCount(0);
  });

  test("клик по зоне выбирает её и строку «Найдено»; клик мимо и Esc снимают выбор", async ({ page }) => {
    await open(page);
    const c = await census(page);
    const zone = c.overlay.objects.find((o) => o.kind === "box" && o.layer === "zones" && o.rect && o.rect.w > 20 && o.rect.h > 6);
    expect(zone, "зона на графике").toBeDefined();
    // внутри зоны, но не на подписи и не на линии
    const r = zone!.rect!;
    const free = c.overlay.labels.map((l) => l.rect);
    let px = r.x + 6;
    while (free.some((f) => intersects(f, { x: px - 3, y: r.y + r.h / 2 - 3, w: 6, h: 6 })) && px < r.x + r.w - 6) px += 10;
    await page.mouse.click(c.plot.left + px, c.plot.top + r.y + r.h / 2);
    const objects = page.getByRole("complementary", { name: "панель объектов" });
    const levels = objects.getByRole("list", { name: "уровни поддержки и сопротивления" });
    await expect(levels.locator("li[data-selected]")).toHaveCount(1);
    await expect.poll(async () => (await overlayOf(page))!.objects.find((o) => o.id === zone!.id)?.emphasis).toBe("selected");
    // клик мимо — снять (LWC не засчитывает второй клик в окне двойного клика, 500 мс)
    await page.waitForTimeout(600);
    const off = emptyPoint(await census(page));
    await page.mouse.click(off.x, off.y);
    await expect(levels.locator("li[data-selected]")).toHaveCount(0);
    // строка списка выбирает объект на графике; Esc снимает
    await levels.getByRole("button").filter({ hasText: "сопротивление" }).first().click();
    await expect(levels.locator("li[data-selected]")).toHaveCount(1);
    await expect.poll(async () => (await overlayOf(page))!.objects.some((o) => o.emphasis === "selected" && o.layer === "sr")).toBe(true);
    await page.keyboard.press("Escape");
    await expect(levels.locator("li[data-selected]")).toHaveCount(0);
  });

  test("кнопка «?» открывает «Что на графике»: для «Чистого» — цена, поддержка, сопротивление, зона и выделение", async ({ page }) => {
    await open(page);
    const chip = page.getByRole("button", { name: "что на графике" });
    await expect(chip).toHaveAttribute("aria-haspopup", "dialog");
    await chip.click();
    const dialog = page.getByRole("dialog", { name: "Что на графике" });
    await expect(dialog).toBeVisible();
    const words = await dialog.locator("li span:nth-of-type(1)").allTextContents();
    expect(words[0]).toBe("Цена");
    expect(words.at(-1)).toBe("Выделение");
    expect(words).toContain("Поддержка");
    expect(words).toContain("Сопротивление");
    expect(words.filter((w) => w === "Спрос" || w === "Предложение" || w === "Зона")).toHaveLength(1);
    expect(words).toHaveLength(5);
    // у каждой строки — одна строка пояснения
    for (const e of await dialog.locator("li span:nth-of-type(2)").allTextContents()) expect(e.length).toBeGreaterThan(10);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await chip.click();
    await page.mouse.click(700, 450);
    await expect(dialog).toHaveCount(0);
  });

  test("сохранение v4: загружается «Чистый», уведомление показывается один раз", async ({ page }) => {
    const v4 = JSON.stringify({ type: "candles", indicators: [{ id: "ema", params: { period: 50 } }], layers: { structure: true, zones: true, liq_map: true }, layers_v: 4, panels: [], scale: "linear", overlay: null });
    await open(page, { saved: v4 });
    await expect(page.getByRole("status")).toContainText("Разметка графика обновлена");
    const sheet = await layersSheet(page);
    await expect(sheet.getByRole("radio", { name: "Чистый", exact: true })).toBeChecked();
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("pl-terminal") ?? "{}"));
    expect(saved).toMatchObject({ layers_v: 5, markup: { preset: "clean", overrides: {} } });
    expect(saved.layers).toBeUndefined();
    await page.reload();
    await expect(page.getByTestId("terminal").locator("canvas").first()).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page.getByText("Разметка графика обновлена")).toHaveCount(0);
  });
});

test.describe("перепись подписей: телефон (Pixel 5)", () => {
  test.use(pixel5);
  test.describe.configure({ timeout: 120_000 });

  test("заглушка по умолчанию: все пресеты и «Свой», обе темы", async ({ page }) => {
    await runMatrix(page, { symbol: "BTCUSDT", fixture: "default", authed: false, phone: true });
  });

  test("насыщенная разметка (rich): не больше 4 подписей", async ({ page }) => {
    await runMatrix(page, { symbol: "BTCUSDT", fixture: "rich", authed: true, phone: true });
  });

  test("1000PEPEUSDT: деления по шагу, без «0.00»", async ({ page }) => {
    await runMatrix(page, { symbol: SUBCENT, fixture: "default", authed: false, phone: true });
  });

  test("тап по «Поддержке» закрепляет карточку внизу графика, тап мимо открепляет", async ({ page }) => {
    await open(page);
    const c = await census(page);
    const sup = c.overlay.labels.find((l) => l.text === "Поддержка" || l.text === "Подд.");
    expect(sup, "подпись поддержки").toBeDefined();
    await page.touchscreen.tap(c.plot.left + sup!.rect.x + sup!.rect.w / 2, c.plot.top + sup!.rect.y + sup!.rect.h / 2);
    const tip = page.getByTestId("object-tooltip");
    await expect(tip).toBeVisible();
    await expect(tip).toHaveAttribute("data-pinned", "true");
    await expect(tip).toHaveAttribute("data-docked", "true");
    await expect(tip).toContainText("Поддержка");
    await expect(tip).toContainText("касаний:");
    // карточка — внизу колонки графика, во всю ширину
    const tb = (await tip.boundingBox())!;
    const chart = (await page.getByTestId("terminal").boundingBox())!;
    expect(chart.y + chart.height - (tb.y + tb.height)).toBeLessThanOrEqual(12);
    // тап мимо объектов — открепить (второй тап в окне двойного тапа LWC не засчитывает)
    await page.waitForTimeout(600);
    const off = emptyPoint(c);
    await page.touchscreen.tap(off.x, off.y);
    await expect(tip).toHaveCount(0);
    // крестик карточки тоже открепляет
    await page.waitForTimeout(600);
    await page.touchscreen.tap(c.plot.left + sup!.rect.x + sup!.rect.w / 2, c.plot.top + sup!.rect.y + sup!.rect.h / 2);
    await expect(tip).toBeVisible();
    await tip.getByRole("button", { name: "закрыть подсказку" }).tap();
    await expect(tip).toHaveCount(0);
  });
});

test("алерты rich: обе линии на графике", async ({ page }) => {
  await open(page, { fixture: "rich", authed: true });
  await expect.poll(async () => (await overlayOf(page))!.objects.filter((o) => o.layer === "alerts").length).toBe(RICH_ALERTS.length);
});

/**
 * Снимки-эталоны (§14.3): 4 вида для проверки владельцем. Обновляются только намеренно
 * (PW_BASELINES=1 npx playwright test chart.render --update-snapshots). Сравнение включается переменной
 * PW_BASELINES: сглаживание текста на холсте отличается между сборками Chromium (headless shell в CI и
 * полный Chrome локально), и порог 0.2 % пикселей иначе ложно срабатывает.
 */
test.describe("снимки-эталоны", () => {
  test.skip(!process.env.PW_BASELINES, "сравнение снимков — по PW_BASELINES=1");
  const shot = async (page: Page, name: string) => {
    await page.mouse.move(1, 1);
    await census(page);
    await expect(page.getByTestId("terminal")).toHaveScreenshot(name, { maxDiffPixelRatio: 0.002, mask: [page.getByTestId("countdown")], animations: "disabled" });
  };

  test.describe("десктоп", () => {
    test.use(DESKTOP);
    test("«Чистый», тёмная и светлая тема", async ({ page }) => {
      await open(page);
      await shot(page, "desktop-dark-clean.png");
      await setTheme(page, "light");
      await shot(page, "desktop-light-clean.png");
    });
    test("«Подробный» на насыщенной разметке", async ({ page }) => {
      await open(page, { fixture: "rich", authed: true });
      await setState(page, "detailed");
      await closeSheets(page);
      await shot(page, "desktop-dark-detailed-rich.png");
    });
  });

  test.describe("телефон", () => {
    test.use(pixel5);
    test("«Чистый», тёмная тема", async ({ page }) => {
      await open(page);
      await shot(page, "phone-dark-clean.png");
    });
  });
});
