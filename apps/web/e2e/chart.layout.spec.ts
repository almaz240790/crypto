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

/** Серии графика: тип, цвет, число точек, панель (через __chart, как в correctness-спеке). */
const seriesOf = (page: Page) =>
  page.evaluate(() => {
    const chart = (document.querySelector('[data-testid="terminal"]') as HTMLElement & { __chart: { panes(): { getSeries(): { seriesType(): string; options(): { color?: string; visible?: boolean }; data(): unknown[]; priceLines(): { options(): { price: number } }[] }[] }[] } }).__chart;
    return chart.panes().map((p, pane) => p.getSeries().map((s) => ({ pane, type: s.seriesType(), color: s.options().color ?? null, len: s.data().length, levels: s.priceLines().map((l) => l.options().price) })));
  });

test("экземпляры индикаторов: EMA 50, 21 и 200 через «Индикаторы», три линии разного цвета, после перезагрузки те же, четвёртой нет", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  await page.getByRole("button", { name: /Индикаторы/ }).click();
  const dlg = page.getByRole("dialog", { name: "Индикаторы" });
  // по умолчанию — EMA 50; «+ ещё EMA» добавляет экземпляр со свободным периодом (20), период правится полем
  await expect(dlg.getByLabel("Период EMA 50")).toHaveValue("50");
  await dlg.getByRole("button", { name: "+ ещё EMA" }).click();
  await dlg.getByLabel("Период EMA 20").fill("21");
  await dlg.getByLabel("Период EMA 20").press("Enter");
  await expect(dlg.getByLabel("Период EMA 21")).toHaveValue("21");
  // третий — снова первый свободный из 20, 50, 200 (20: занят 21, а не 20); ставим 200
  await dlg.getByRole("button", { name: "+ ещё EMA" }).click();
  await dlg.getByLabel("Период EMA 20", { exact: true }).fill("200");
  await dlg.getByLabel("Период EMA 20", { exact: true }).press("Enter");
  await expect(dlg.getByLabel("Период EMA 200")).toHaveValue("200");
  await expect(dlg.getByRole("button", { name: "+ ещё EMA" })).toBeDisabled();
  await dlg.getByRole("button", { name: "Готово" }).click();
  await expect(page.getByRole("button", { name: "Индикаторы (3)" })).toBeVisible();
  const emaLines = async () => (await seriesOf(page)).flat().filter((s) => s.pane === 0 && s.type === "Line" && s.len > 0);
  await expect.poll(async () => (await emaLines()).length).toBe(3);
  expect(new Set((await emaLines()).map((s) => s.color)).size).toBe(3);
  // легенда графика: строка на каждый экземпляр
  const legend = page.getByTestId("legend");
  for (const name of ["EMA 50", "EMA 21", "EMA 200"]) await expect(legend).toContainText(name);
  // сохраняются экземплярами ema#1…ema#3
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("pl-terminal") ?? "{}").indicators as { uid: string; params: { period: number } }[]);
  expect(saved.map((i) => `${i.uid}:${i.params.period}`)).toEqual(["ema#1:50", "ema#2:21", "ema#3:200"]);
  await page.reload();
  await expect(page.getByTestId("terminal").locator("canvas").first()).toBeVisible();
  await expect.poll(async () => (await emaLines()).length).toBe(3);
  await expect(page.getByTestId("legend")).toContainText("EMA 21");
  // «убрать EMA 21» в легенде
  await page.getByTestId("legend").getByText("EMA 21").hover();
  await page.getByRole("button", { name: "убрать EMA 21" }).click();
  await expect.poll(async () => (await emaLines()).length).toBe(2);
});

test("панели индикаторов: RSI с уровнями 30/70 пунктиром, MACD — 0; заголовок «RSI 14»; основная панель не меньше 55 %", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.setItem("pl-terminal", JSON.stringify({ layers_v: 5, type: "candles", indicators: [{ id: "rsi", params: { period: 14 } }, { id: "macd", params: {} }, { id: "stoch", params: {} }, { id: "cci", params: {} }], markup: { preset: "clean", overrides: {} }, panels: ["oi", "funding"], scale: "linear", overlay: null })));
  await open(page);
  await expect(page.getByTestId("pane-rsi")).toContainText("RSI 14");
  await expect(page.getByTestId("pane-macd")).toContainText("MACD 12 26 9");
  const panes = async () => (await seriesOf(page)).map((p) => p[0]?.levels ?? []);
  await expect.poll(async () => (await panes())[1]).toEqual([30, 70]);
  const all = await panes();
  expect(all[2]).toEqual([0]);
  expect(all[3]).toEqual([20, 80]);
  expect(all[4]).toEqual([-100, 100]);
  // шесть панелей под графиком не сжимают свечи меньше 55 % (VIEW.desktop.mainMinShare, PaneManager)
  const share = await page.evaluate(() => {
    const chart = (document.querySelector('[data-testid="terminal"]') as HTMLElement & { __chart: { panes(): { getHeight(): number }[] } }).__chart;
    const h = chart.panes().map((p) => p.getHeight());
    return h[0]! / h.reduce((a, b) => a + b, 0);
  });
  expect(share).toBeGreaterThanOrEqual(0.54);
});

test("«Найдено»: вкладка = Уровни + Фигуры + Паттерны, разделы, таблица уровней с «Текущая цена», вопрос — в конце", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, "/chart/BTCUSDT/4h", true);
  const aside = page.getByRole("complementary", { name: "панель объектов" });
  const n = (s: string) => Number(/\((\d+)\)/.exec(s)?.[1] ?? NaN);
  const sections = aside.getByRole("tablist", { name: "разделы найденного" });
  await expect(sections.getByRole("tab", { name: /^Уровни/ })).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(async () => {
      const total = n((await aside.getByRole("tab", { name: /^Найдено/ }).textContent()) ?? "");
      const parts = await sections.getByRole("tab").allTextContents();
      return total === parts.map(n).reduce((a, b) => a + b, 0);
    })
    .toBe(true);
  const levels = aside.getByRole("list", { name: "уровни поддержки и сопротивления" });
  await expect(levels).toContainText("Текущая цена");
  // классы: num — только у цен, расстояние — pct
  for (const p of await levels.locator("span.num").allTextContents()) expect(p).toMatch(/^\d[\d\s]*\.\d$/);
  await expect(levels.locator("[class*=pct]").first()).toContainText("%");
  // фигуры и паттерны — без многоточия
  await sections.getByRole("tab", { name: /^Фигуры/ }).click();
  const ellipsis = await aside.locator("li *").evaluateAll((els) => els.filter((e) => getComputedStyle(e).textOverflow === "ellipsis").length);
  expect(ellipsis).toBe(0);
  // вопрос о графике — последним в прокрутке панели
  const ask = aside.getByRole("form", { name: "вопрос о графике" });
  await expect(ask).toBeVisible();
  const askBox = (await ask.boundingBox())!;
  const listBox = (await aside.getByRole("list", { name: "найденные фигуры" }).boundingBox())!;
  expect(askBox.y).toBeGreaterThan(listBox.y);
  // гостю — одна строка со ссылкой «Войдите»
});

test("легенда графика: без рамки, «ohlc» только под перекрестием; гостю «Найдено» предлагает войти одной строкой", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  const legend = page.getByTestId("legend");
  await expect(legend).toContainText("BTCUSDT · 4ч · Binance");
  await expect(page.getByTestId("ohlc")).toHaveCount(0);
  expect(await legend.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("0px");
  const t = (await box(page, "[data-testid=terminal]"))!;
  await page.mouse.move(t.x + t.width * 0.5, t.y + t.height * 0.4);
  await expect(page.getByTestId("ohlc")).toContainText("Закр");
  await page.mouse.move(t.x - 40, t.y + 10);
  await expect(page.getByTestId("ohlc")).toHaveCount(0);
  const aside = page.getByRole("complementary", { name: "панель объектов" });
  await expect(aside.getByRole("link", { name: "Войдите" })).toBeVisible();
  await expect(aside.getByLabel("текст вопроса")).toHaveCount(0);
});

for (const width of [1280, 1024]) {
  test(`${width} px: вкладки правой панели в одну строку, ни одна не обрезана`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await open(page);
    if (width < 1280) await page.getByRole("button", { name: "Объекты" }).click();
    const aside = page.getByRole("complementary", { name: "панель объектов" });
    const row = aside.getByRole("tablist", { name: "вкладки панели объектов" });
    await expect(row).toBeVisible();
    expect(await row.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    for (const name of [/^Найдено/, /^Рисунки/, "Слои", "Раскладки"]) await expect(row.getByRole("tab", { name })).toBeVisible();
  });
}
