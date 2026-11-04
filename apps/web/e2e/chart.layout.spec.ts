import { expect, test, type Page } from "@playwright/test";
import { SUBCENT, mock } from "./helpers/chart";

/**
 * Раскладка терминала на десктопе (план 2B.9, PR C1): рейка 56 px вместо сайдбара, шапка 44 px, тулбар 40 px,
 * терминал заполняет высоту окна, правая панель встроена от 1280 px и выдвигается поверх графика уже;
 * шапка и тулбар сворачиваются по приоритету и ничего не обрезают. Телефон (< 900 px) — PR C2.
 */

async function open(page: Page, path = "/chart/BTCUSDT/4h", authed = false) {
  const calls: string[] = [];
  await mock(page, calls, authed);
  await page.goto(path);
  await expect(page.getByTestId("terminal").locator("canvas").first()).toBeVisible();
  await expect(page.getByLabel("состояние")).toContainText("цена");
  return calls;
}

const box = async (page: Page, sel: string) => (await page.locator(sel).first().boundingBox())!;

test("1440×900, гость: рейка 56, шапка 44, тулбар 40, график 1044 × ≥ 812, страница без прокрутки, нижней строки нет", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  expect(Math.abs((await box(page, "[data-testid=app-rail]")).width - 56)).toBeLessThanOrEqual(1);
  expect(Math.abs((await box(page, "[data-testid=terminal-header]")).height - 44)).toBeLessThanOrEqual(1);
  expect(Math.abs((await box(page, "[data-testid=terminal-toolbar]")).height - 40)).toBeLessThanOrEqual(1);
  await expect.poll(async () => Math.round((await box(page, "[data-testid=terminal]")).width)).toBeGreaterThanOrEqual(1042);
  const term = await box(page, "[data-testid=terminal]");
  expect(term.width).toBeLessThanOrEqual(1046);
  expect(term.height).toBeGreaterThanOrEqual(812);
  expect(await page.evaluate(() => document.scrollingElement!.scrollHeight)).toBe(900);
  // действия нижней строки переехали в тулбар и панели: дублей нет
  await expect(page.getByRole("button", { name: "Рисовать" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Слои", exact: true })).toHaveCount(0);
  // разделы — иконками рейки, подпись — имя ссылки
  const rail = page.getByTestId("app-rail");
  await expect(rail.getByRole("link", { name: "График" })).toHaveAttribute("aria-current", "page");
});

test("шапка: цена 20 px моноширинным (tabular), изменение «за свечу 4ч», подписи — не моноширинным", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await open(page);
  const header = page.getByTestId("terminal-header");
  const price = header.getByRole("button", { name: /^цена / });
  const css = await price.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { size: cs.fontSize, family: cs.fontFamily, numeric: cs.fontVariantNumeric };
  });
  expect(css.size).toBe("20px");
  expect(css.family).toMatch(/Plex Mono/i);
  expect(css.numeric).toContain("tabular-nums");
  await expect(header).toContainText("за свечу 4ч");
  // на 1600 «Ход за свечу» не прячется
  await expect(header.locator("[data-overflow-item=atr]")).toBeVisible();
  await expect(header.locator("[data-overflow-item=atr]")).toContainText("Ход за свечу");
  // слова — Manrope: моноширинный только у чисел (цена — число)
  const wordFonts = await header.locator("[data-overflow-item]:not([data-overflow-item=price])").evaluateAll((els) => els.map((el) => getComputedStyle(el).fontFamily));
  expect(wordFonts.length).toBeGreaterThan(2);
  for (const f of wordFonts) expect(f).not.toMatch(/^"?IBM Plex Mono/i);
  // «Сводка» по клику на цену: все факты, в том числе отсчёт до закрытия
  await price.click();
  const summary = page.getByRole("dialog", { name: "Сводка" });
  await expect(summary).toContainText("До закрытия свечи");
  await expect(summary).toContainText("Ход за свечу");
  await page.keyboard.press("Escape");
  await expect(summary).toHaveCount(0);
});

for (const width of [900, 1024, 1100, 1280, 1440, 1920]) {
  test(`${width} px: шапка и тулбар в одну строку, ничего не обрезано, «Снимок» доступен`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    for (const symbol of ["BTCUSDT", SUBCENT]) {
      await open(page, `/chart/${symbol}/4h`);
      for (const row of ["terminal-header", "terminal-toolbar"]) {
        const container = (await box(page, `[data-testid=${row}]`))!;
        const items = await page.getByTestId(row).locator("[data-overflow-item]").evaluateAll((els) =>
          els
            .map((el) => el.getBoundingClientRect())
            .filter((r) => r.width > 0)
            .map((r) => ({ top: r.top, bottom: r.bottom, right: r.right })),
        );
        expect(items.length).toBeGreaterThan(2);
        for (const r of items) {
          expect(r.right, `${row}: правый край`).toBeLessThanOrEqual(container.x + container.width + 0.5);
          expect(r.top, `${row}: одна строка`).toBeGreaterThanOrEqual(container.y - 0.5);
          expect(r.bottom, `${row}: одна строка`).toBeLessThanOrEqual(container.y + container.height + 0.5);
        }
      }
      expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= innerWidth)).toBe(true);
      // имя инструмента целиком
      const name = page.getByTestId("terminal-header").locator("[data-overflow-item=symbol] span").first();
      await expect(name).toHaveText(symbol);
      expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      // «Снимок» — кнопкой или пунктом «⋯»
      const snap = page.getByRole("button", { name: "Снимок" });
      if (!(await snap.isVisible())) {
        await page.getByRole("button", { name: "Ещё" }).click();
        await expect(page.getByRole("menuitem", { name: "Снимок" })).toBeVisible();
        await page.keyboard.press("Escape");
      }
    }
  });
}

test("1280×720: правая панель встроена и открыта, 300 px", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await open(page);
  const aside = page.getByRole("complementary", { name: "панель объектов" });
  await expect(aside).toBeVisible();
  expect(Math.round((await aside.boundingBox())!.width)).toBe(300);
  await expect(page.getByRole("button", { name: "Объекты" })).toHaveAttribute("aria-pressed", "true");
});

test("1024×768: панель закрыта; «Объекты» выдвигает её поверх графика, ширина графика та же; Esc и ✕ закрывают", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await open(page);
  const aside = page.getByRole("complementary", { name: "панель объектов" });
  await expect(aside).toBeHidden();
  const w0 = (await box(page, "[data-testid=terminal]")).width;
  await page.getByRole("button", { name: "Объекты" }).click();
  await expect(aside).toBeVisible();
  expect(Math.abs((await box(page, "[data-testid=terminal]")).width - w0)).toBeLessThanOrEqual(1);
  await page.locator("body").press("Escape");
  await expect(aside).toBeHidden();
  await page.getByRole("button", { name: "Объекты" }).click();
  await aside.getByRole("button", { name: "закрыть панель объектов" }).click();
  await expect(aside).toBeHidden();
});

test("ресайз 1280 → 800 → 1280: график не перемонтируется (тот же узел)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page);
  const before = await page.getByTestId("terminal").elementHandle();
  await page.setViewportSize({ width: 800, height: 800 });
  await expect(page.getByTestId("terminal-header")).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByTestId("terminal-header")).toBeVisible();
  const after = await page.getByTestId("terminal").elementHandle();
  expect(await page.evaluate(([a, b]) => a === b, [before, after])).toBe(true);
});

test("закрытый минутный ТФ у гостя: клик и клавиша «1» открывают «Минутные таймфреймы», адрес не меняется", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  const url = page.url();
  // порядок у гостя: доступные, затем закрытые
  const order = await page.getByRole("navigation", { name: "таймфрейм" }).locator("a, button").allTextContents();
  expect(order.map((x) => x.trim())).toEqual(["1ч", "4ч", "1Д", "1Н", "1м", "5м", "15м"]);
  await page.getByRole("button", { name: "1м", exact: true }).click();
  const dlg = page.getByRole("dialog", { name: "Минутные таймфреймы" });
  await expect(dlg).toBeVisible();
  await expect(dlg.getByRole("link", { name: "Войти" })).toHaveAttribute("href", "/login?next=/chart/BTCUSDT/1m");
  expect(page.url()).toBe(url);
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
  await page.locator("body").press("1");
  await expect(dlg).toBeVisible();
  expect(page.url()).toBe(url);
});

test("светлая тема: активный ТФ отличается от фона группы, тулбар и панель непрозрачны", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  const tf = page.getByRole("navigation", { name: "таймфрейм" });
  const active = await tf.locator('[aria-current="page"]').evaluate((el) => getComputedStyle(el).backgroundColor);
  const group = await tf.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(active).not.toBe(group);
  for (const sel of ["[data-testid=terminal-toolbar]", "[data-testid=terminal-header]", 'aside[aria-label="панель объектов"]', '[role="toolbar"][aria-label="панель рисования"]']) {
    expect(await page.locator(sel).evaluate((el) => getComputedStyle(el).backgroundColor), sel).not.toBe("rgba(0, 0, 0, 0)");
  }
});

test("рейка: «развернуть меню» открывает весь сайдбар; Esc закрывает и возвращает фокус", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  const btn = page.getByRole("button", { name: "развернуть меню" });
  await btn.click();
  const menu = page.getByRole("dialog", { name: "меню" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("link", { name: "Регистрация" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(btn).toBeFocused();
});

test("мультичарт: рейка и заливка высоты без прокрутки страницы", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const calls: string[] = [];
  await mock(page, calls);
  await page.goto("/multichart");
  await expect(page.getByRole("region", { name: /^график / }).first().locator("canvas").first()).toBeVisible();
  await expect(page.getByTestId("app-rail")).toBeVisible();
  expect(await page.evaluate(() => document.scrollingElement!.scrollHeight)).toBe(900);
  const cell = (await page.getByRole("region", { name: /^график / }).first().boundingBox())!;
  expect(cell.y + cell.height).toBeGreaterThan(880);
});
