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
  await expect(page.getByRole("button", { name: "Рисовать", exact: true })).toHaveCount(0);
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
  const seg = (name: string) => page.getByRole("button", { name, exact: true });
  await seg("5м").click();
  const dlg = page.getByRole("dialog", { name: "Минутные таймфреймы" });
  await expect(dlg).toBeVisible();
  // развёрнут только сегмент, у которого открыто окно; он же ссылается на окно
  const dlgId = await dlg.getAttribute("id");
  await expect(seg("5м")).toHaveAttribute("aria-expanded", "true");
  await expect(seg("5м")).toHaveAttribute("aria-controls", dlgId!);
  for (const other of ["1м", "15м"]) {
    await expect(seg(other)).toHaveAttribute("aria-expanded", "false");
    await expect(seg(other)).not.toHaveAttribute("aria-controls", /./);
  }
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
  await expect(seg("5м")).toHaveAttribute("aria-expanded", "false");
  await seg("1м").click();
  await expect(dlg).toBeVisible();
  await expect(dlg.getByRole("link", { name: "Войти" })).toHaveAttribute("href", "/login?next=/chart/BTCUSDT/1m");
  expect(page.url()).toBe(url);
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
  await page.locator("body").press("1");
  await expect(dlg).toBeVisible();
  await expect(seg("1м")).toHaveAttribute("aria-expanded", "true");
  await expect(seg("5м")).toHaveAttribute("aria-expanded", "false");
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
  // чипы тренда «День ↑» / «Неделя ↑»: текст --up не ниже AA 4.5:1 к фону под ним (D17)
  const header = page.getByTestId("terminal-header");
  await expect(header.getByText(/^Неделя/)).toBeVisible();
  const ratios = await header.locator("[data-dir]").evaluateAll((els) => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
    };
    const bg = (el: Element | null): number[] => {
      for (; el; el = el.parentElement) {
        const c = rgb(getComputedStyle(el).backgroundColor);
        if (c.length === 3 || (c.length === 4 && c[3]! > 0)) return c.slice(0, 3);
      }
      return [255, 255, 255];
    };
    return els
      .filter((el) => el.textContent?.trim())
      .map((el) => {
        const a = lum(rgb(getComputedStyle(el).color));
        const b = lum(bg(el));
        return [el.textContent!.trim(), (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)] as const;
      });
  });
  expect(ratios.length).toBeGreaterThanOrEqual(2);
  for (const [text, r] of ratios) expect(r, text).toBeGreaterThanOrEqual(4.5);
  // нажатый инструмент — фон --row-hover и полоса --accent снизу, без рамки (как сегменты и кнопки тулбара)
  const tool = page.getByRole("toolbar", { name: "панель рисования" }).getByRole("button", { name: "Трендовая линия" });
  await tool.click();
  await expect(tool).toHaveAttribute("aria-pressed", "true");
  const st = await tool.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { shadow: cs.boxShadow, border: cs.borderTopColor, bg: cs.backgroundColor };
  });
  expect(st.shadow).toMatch(/inset/);
  expect(st.shadow).toMatch(/-2px/);
  expect(st.border).toBe("rgba(0, 0, 0, 0)");
  expect(st.bg).not.toBe("rgba(0, 0, 0, 0)");
  await page.keyboard.press("Escape");
  // угол «− + →|» непрозрачен, пока курсор над колонкой графика, а не только над самим углом (§3.4)
  const corner = page.locator("[data-corner]");
  const term = await box(page, "[data-testid=terminal]");
  await page.mouse.move(term.x + term.width * 0.3, term.y + term.height * 0.3);
  await expect.poll(() => corner.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  await page.mouse.move(term.x + term.width / 2, 10);
  await expect.poll(() => corner.evaluate((el) => getComputedStyle(el).opacity)).toBe("0.55");
});

test("алерт: цена в форме — по шагу инструмента, без экспоненты и шума float; «Сводка» — закрытие последней свечи", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, `/chart/${SUBCENT}/4h`, true);
  await page.getByRole("button", { name: /^Алерт/ }).click();
  const form = page.getByRole("form", { name: "новый алерт по цене" });
  // шаг 1.000E-7 — ровно 7 знаков после запятой, как у шкалы и шапки
  await expect(form.getByLabel("цена алерта")).toHaveValue(/^0\.\d{7}$/);
  await page.keyboard.press("Escape");
  // разделитель «Найдено → Уровни» и «Сводка» показывают одно и то же закрытие — основу изменения «за свечу 4ч»
  await page.getByTestId("terminal-header").getByRole("button", { name: /^цена / }).click();
  const summary = page.getByRole("dialog", { name: "Сводка" });
  await expect(summary).toContainText("Закрытие последней свечи 4ч");
  // ни подпись, ни значение не обрезаются краем окна (фандинг с отсчётом и чипы тренда — самые широкие)
  const clipped = await summary.evaluate((dlg) => {
    const r = dlg.getBoundingClientRect();
    return [...dlg.querySelectorAll("dt, dd")].filter((el) => el.getBoundingClientRect().right > r.right - 1 || el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent);
  });
  expect(clipped).toEqual([]);
});

test("«Разбор» (резерв): гость и обычный пользователь не проверяют ресурс; владельцу после сбоя — повтор, вкладка и пункт тулбара", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // гость: запроса /v1/chart/topdown нет (сервер ответил бы 404)
  const guestCalls = await open(page);
  await page.waitForTimeout(3200);
  expect(guestCalls.filter((c) => c.startsWith("/v1/chart/topdown"))).toEqual([]);
  // владелец: первый ответ 502 — не окончательный, повтор; 200 — вкладка «Разбор» и пункт тулбара
  const calls: string[] = [];
  await mock(page, calls, true);
  await page.route("**/v1/auth/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: 1, email: "o@example.com", name: null, email_verified: true, role: "owner", locale: "ru", timezone: "UTC", theme: "system", risk: {} }) }));
  let n = 0;
  await page.route("**/v1/chart/topdown**", (r) => (n++ === 0 ? r.fulfill({ status: 502, body: "" }) : r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ preview: true }) })));
  await page.goto("/chart/BTCUSDT/4h");
  const aside = page.getByRole("complementary", { name: "панель объектов" });
  await expect(aside.getByRole("tab", { name: "Разбор" })).toBeVisible({ timeout: 15_000 });
  expect(n).toBe(2);
  await aside.getByRole("tab", { name: "Найдено", exact: false }).first().click();
  await page.getByTestId("terminal-toolbar").getByRole("button", { name: "Разбор" }).click();
  await expect(aside.getByRole("tab", { name: "Разбор" })).toHaveAttribute("aria-selected", "true");
  await expect(aside).toContainText("Разбор появится позже");
});

test("каркас загрузки (HTML сервера, до модуля терминала): строки 44 и 40, колонка рисования; панель — только от 1280 px", async ({ browser }) => {
  for (const [w, h, panel] of [[1440, 900, true], [1100, 760, false]] as const) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, locale: "ru-RU", javaScriptEnabled: false });
    const page = await ctx.newPage();
    await page.goto("/chart/BTCUSDT/4h");
    const sk = page.getByTestId("terminal-skeleton");
    await expect(sk).toContainText("Загрузка графика…");
    const rows = await sk.evaluate((el) => [...el.children].slice(0, 2).map((c) => Math.round(c.getBoundingClientRect().height)));
    expect(rows).toEqual([44, 40]);
    const cols = await sk.locator("[data-objects]").evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
    expect(cols, `${w}: колонки`).toBe(panel ? 3 : 2);
    await ctx.close();
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
  // шапка ячейки: выбор инструмента — как в терминале (имя 13/600, select поверх), таймфрейм — ui Select с TF_LABEL
  const head = page.getByRole("region", { name: /^график / }).first();
  const name = head.locator("[data-compact] span").first();
  await expect(name).toHaveText("BTCUSDT");
  expect(await name.evaluate((el) => [getComputedStyle(el).fontSize, getComputedStyle(el).fontWeight])).toEqual(["13px", "600"]);
  await expect(head.getByLabel("таймфрейм").locator("option:checked")).toHaveText("4ч");
  // под перекрестием — «Откр … Закр …», как в легенде терминала
  await page.mouse.move(cell.x + cell.width * 0.5, cell.y + cell.height * 0.5);
  await expect(head).toContainText(/Откр [\d\s]+(\.\d+)? Закр [\d\s]+/);
  // «ⓘ» в шапке мультичарта: иконка-пояснение без пунктира под ней (D16)
  const info = page.getByLabel("Пояснение");
  expect(await info.evaluate((el) => getComputedStyle(el).borderBottomWidth)).toBe("0px");
  const ib = (await info.boundingBox())!;
  expect(ib.width).toBeGreaterThanOrEqual(28);
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

test("«Найдено»: вкладка = Уровни + Фигуры + Паттерны, разделы, таблица уровней с «Закрытие последней свечи 4ч», вопрос — в конце", async ({ page }) => {
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
  await expect(levels).toContainText("Закрытие последней свечи 4ч");
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

/** Сохранение с множеством индикаторов: окно «Индикаторы» выше окна браузера (прокрутка внутри окна). */
const MANY_INDICATORS = { layers_v: 5, type: "candles", indicators: ["ema", "sma", "supertrend", "bb", "ichimoku", "keltner", "rsi", "macd", "stoch", "atr", "volume"].map((id) => ({ id, params: {} })), markup: { preset: "clean", overrides: {} }, panels: [], scale: "linear", overlay: null };

test("«Индикаторы» выше окна: колесо и Tab прокручивают окно, нижние флажки достижимы", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.addInitScript((v) => localStorage.setItem("pl-terminal", JSON.stringify(v)), MANY_INDICATORS);
  await open(page);
  await page.getByRole("button", { name: /^Индикаторы/ }).click();
  const dlg = page.getByRole("dialog", { name: "Индикаторы" });
  await expect(dlg).toBeVisible();
  expect(await dlg.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(40);
  const d = (await dlg.boundingBox())!;
  await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2);
  await page.mouse.wheel(0, 400);
  await expect.poll(() => dlg.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  // последний флажок «Под графиком» — в видимой части окна после фокуса с клавиатуры
  const last = dlg.getByRole("checkbox").last();
  await last.focus();
  await expect.poll(async () => {
    const b = (await last.boundingBox())!;
    return b.y + b.height <= d.y + d.height + 1;
  }).toBe(true);
});

test("период, введённый в поле, применяется и при клике мимо окна — в «Индикаторах» и в «Параметрах» легенды", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  const t = await box(page, "[data-testid=terminal]");
  const outside = { x: t.x + t.width - 160, y: t.y + t.height - 160 };
  await page.getByRole("button", { name: /^Индикаторы/ }).click();
  const dlg = page.getByRole("dialog", { name: "Индикаторы" });
  await dlg.getByLabel("Период EMA 50").fill("21");
  await page.mouse.click(outside.x, outside.y);
  await expect(dlg).toHaveCount(0);
  const legend = page.getByTestId("legend");
  await expect(legend).toContainText("EMA 21");
  await legend.getByText("EMA 21").hover();
  await page.getByRole("button", { name: "настроить EMA 21" }).click();
  const params = page.getByRole("dialog", { name: "Параметры EMA 21" });
  await params.getByLabel("Период EMA 21").fill("77");
  await page.mouse.click(outside.x, outside.y);
  await expect(params).toHaveCount(0);
  await expect(legend).toContainText("EMA 77");
});

test("ресайз 1320 → 900 шагом 4 px после загрузки данных: тулбар и вкладки панели не шире своей строки, бейдж «Объекты» виден", async ({ page }) => {
  await page.setViewportSize({ width: 1320, height: 800 });
  await open(page);
  const badge = page.getByTestId("terminal-toolbar").locator("[data-overflow-item=objects] [class*=badge]");
  await expect(badge).toBeVisible();
  const frame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  for (let w = 1320; w >= 900; w -= 4) {
    await page.setViewportSize({ width: w, height: 800 });
    await frame();
    const over = await page.evaluate(() => {
      const tb = document.querySelector<HTMLElement>("[data-testid=terminal-toolbar]")!;
      const tabs = document.querySelector<HTMLElement>('[role=tablist][aria-label="вкладки панели объектов"]');
      return { tb: tb.scrollWidth - tb.clientWidth, tabs: tabs && tabs.offsetWidth > 0 ? tabs.scrollWidth - tabs.clientWidth : 0 };
    });
    expect(over.tb, `тулбар на ${w} px`).toBeLessThanOrEqual(0);
    expect(over.tabs, `вкладки на ${w} px`).toBeLessThanOrEqual(1);
  }
  // в компактном виде «Объекты» — иконка и число найденного (панель на 900–1279 закрыта)
  await expect(page.getByTestId("terminal-toolbar").locator("[data-overflow-item=objects]")).toHaveAttribute("data-compact", "true");
  await expect(badge).toBeVisible();
});

test("«⋯ Ещё» → «Горячие клавиши»: цифры подписаны таймфреймами, Esc закрывает", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  await page.getByRole("button", { name: "Ещё" }).click();
  await page.getByRole("menuitem", { name: "Горячие клавиши" }).click();
  const dlg = page.getByRole("dialog", { name: "Горячие клавиши" });
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText("1 1м");
  await expect(dlg).toContainText("5 4ч");
  await expect(dlg).toContainText("Alt+H");
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
});

test("«Разметка»: меню не шире 360 px, пояснения переносятся", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await open(page);
  await page.getByRole("button", { name: /^Разметка/ }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  expect((await menu.boundingBox())!.width).toBeLessThanOrEqual(361);
});

test("ширина панели из прошлой сессии (600 px) после сужения окна — не больше 40 % окна; предпочтение не теряется", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pl-objects-w", "600"));
  await page.setViewportSize({ width: 1920, height: 900 });
  await open(page);
  const aside = page.getByRole("complementary", { name: "панель объектов" });
  const w = async () => Math.round((await aside.boundingBox())!.width);
  await expect.poll(w).toBe(600);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(w).toBe(512);
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.getByRole("button", { name: "Объекты" }).click();
  await expect.poll(w).toBe(400);
  await page.setViewportSize({ width: 1920, height: 900 });
  await expect.poll(w).toBe(600);
});

test("вход, /v1/billing/me не отвечает: минутные ТФ не заперты, клавиша «1» ведёт на 1м (решает сервер свечей)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const calls: string[] = [];
  await mock(page, calls, true);
  await page.route("**/v1/billing/me", (r) => {
    calls.push("billing-fail");
    return r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "недоступно" }) });
  });
  await page.goto("/chart/BTCUSDT/4h");
  await expect(page.getByTestId("terminal").locator("canvas").first()).toBeVisible();
  // первый сбой и повтор через 3 с — оба неудачны
  await expect.poll(() => calls.filter((c) => c === "billing-fail").length, { timeout: 8000 }).toBe(2);
  const nav = page.getByRole("navigation", { name: "таймфрейм" });
  await expect(nav.locator("[data-locked]")).toHaveCount(0);
  expect((await nav.locator("a, button").allTextContents()).map((x) => x.trim())).toEqual(["1м", "5м", "15м", "1ч", "4ч", "1Д", "1Н"]);
  await page.locator("body").press("1");
  await expect(page).toHaveURL(/\/chart\/BTCUSDT\/1m$/);
});

test("легенда: больше трёх наложений — «ещё N»; свечи не под легендой (верхнее поле шкалы цены); значения непрозрачные", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  // только наложения: панелей под графиком нет, основная панель — во всю высоту
  await page.addInitScript((v) => localStorage.setItem("pl-terminal", JSON.stringify(v)), { ...MANY_INDICATORS, indicators: ["ema", "sma", "supertrend", "bb", "ichimoku", "keltner"].map((id) => ({ id, params: {} })) });
  await open(page);
  const legend = page.getByTestId("legend");
  const rows = legend.locator("[class*=legendRow]");
  // шесть наложений: три строки и «ещё 3»
  await expect(rows).toHaveCount(3);
  const more = legend.getByRole("button", { name: "ещё 3" });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  // верхнее поле шкалы цены — под низ легенды (доля панели, не больше 0.35)
  const fit = () =>
    page.evaluate(() => {
      const host = document.querySelector<HTMLElement>("[data-testid=terminal]")! as HTMLElement & { __chart: { priceScale(id: string): { options(): { scaleMargins: { top: number } } }; panes(): { getHeight(): number }[] } };
      const lg = document.querySelector<HTMLElement>("[data-testid=legend]")!.getBoundingClientRect();
      const top = host.__chart.priceScale("right").options().scaleMargins.top;
      const h = host.__chart.panes()[0]!.getHeight();
      return { top, free: top * h, legendBottom: lg.bottom - host.getBoundingClientRect().top };
    });
  await expect.poll(async () => (await fit()).top).toBeGreaterThan(0.08);
  let f = await fit();
  expect(f.free).toBeGreaterThanOrEqual(f.legendBottom);
  // раскрыта — шесть строк, поле растёт, но не больше 35 % панели
  await more.click();
  await expect(rows).toHaveCount(6);
  await expect(legend.getByRole("button", { name: "свернуть" })).toHaveAttribute("aria-expanded", "true");
  await expect.poll(async () => (await fit()).top).toBeGreaterThan(f.top);
  f = await fit();
  expect(f.top).toBeLessThanOrEqual(0.35);
  // поле — до низа легенды, если легенда не выше 35 % панели
  expect(f.free + 1).toBeGreaterThanOrEqual(Math.min(f.legendBottom, 0.35 * (f.free / f.top)));
  // значения в строках — непрозрачным цветом (линии полос на графике бледнее, в легенде — нет)
  const colors = await rows.locator(".num").evaluateAll((els) => els.map((e) => getComputedStyle(e).color));
  expect(colors.length).toBeGreaterThan(6);
  for (const c of colors) expect(c, c).not.toMatch(/rgba\([^)]*,\s*0?\.\d+\)/);
});

test("наложенный инструмент — строкой легенды «ETHUSDT · наложение» со значением; «убрать наложение» снимает его", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.addInitScript(() => localStorage.setItem("pl-terminal", JSON.stringify({ layers_v: 5, type: "candles", indicators: [{ id: "ema", params: { period: 50 } }], markup: { preset: "clean", overrides: {} }, panels: [], scale: "percent", overlay: "ETHUSDT" })));
  await open(page);
  const row = page.getByTestId("legend-overlay");
  await expect(row).toContainText("ETHUSDT");
  await expect(row).toContainText("наложение");
  await expect(row.locator(".num")).toHaveText(/^\d[\d\s]*\.\d+$/);
  await row.hover();
  await row.getByRole("button", { name: "убрать наложение" }).click();
  await expect(page.getByTestId("legend-overlay")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("pl-terminal") ?? "{}").overlay)).toBeNull();
});

test("заголовки панелей объёма и OBV — компактно, как их шкала; в «Индикаторах» объём — «Объём», последним; точка экземпляра — у первой строки полей", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.addInitScript((v) => localStorage.setItem("pl-terminal", JSON.stringify(v)), { ...MANY_INDICATORS, indicators: ["macd", "volume", "obv"].map((id) => ({ id, params: {} })) });
  await open(page);
  await expect(page.getByTestId("pane-volume")).toContainText("1.00K");
  await expect(page.getByTestId("pane-volume")).not.toContainText("1 000.00");
  await expect(page.getByTestId("pane-obv")).toContainText(/\d(\.\d+)?K/);
  await page.getByRole("button", { name: /^Индикаторы/ }).click();
  const dlg = page.getByRole("dialog", { name: "Индикаторы" });
  const below = dlg.getByRole("group", { name: "Под графиком" });
  expect((await below.getByRole("checkbox").evaluateAll((els) => els.map((e) => e.closest("label")!.textContent!.trim())))).toEqual(["RSI", "MACD", "Stochastic", "ATR", "CCI", "OBV", "Объём"]);
  // MACD: три поля переносятся на несколько строк; точка — на уровне первого поля
  const dot = await dlg.getByLabel("Быстрая MACD 12 26 9").evaluate((input) => {
    const inst = input.closest("[class*=instance]")!;
    const d = inst.querySelector("[class*=dot]")!.getBoundingClientRect();
    const i = input.getBoundingClientRect();
    return Math.abs(d.top + d.height / 2 - (i.top + i.height / 2));
  });
  expect(dot).toBeLessThanOrEqual(1.5);
});

test("режим рисования: чип справа сверху не закрывает строку OHLC легенды; карточка рисунка — над шкалой времени", async ({ page }) => {
  for (const [w, h] of [[1440, 900], [1024, 768]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await open(page);
    const term = page.getByTestId("terminal");
    const t = (await term.boundingBox())!;
    await page.getByRole("toolbar", { name: "панель рисования" }).getByRole("button", { name: "Трендовая линия" }).click();
    await page.mouse.move(t.x + t.width * 0.5, t.y + t.height * 0.5);
    await expect(page.getByTestId("ohlc")).toContainText("Объём");
    await expect(page.getByTestId("draw-chip")).toContainText("Трендовая линия");
    const chip = (await page.getByTestId("draw-chip").boundingBox())!;
    const ohlc = (await page.getByTestId("ohlc").boundingBox())!;
    const overlap = chip.x < ohlc.x + ohlc.width && ohlc.x < chip.x + chip.width && chip.y < ohlc.y + ohlc.height && ohlc.y < chip.y + chip.height;
    expect(overlap, `${w}: чип ${JSON.stringify(chip)} легенда ${JSON.stringify(ohlc)}`).toBe(false);
    // левее шкалы цены: правый край чипа — в области свечей
    const plotW = await term.evaluate((el) => (el as HTMLElement & { __chart: { timeScale(): { width(): number } } }).__chart.timeScale().width());
    expect(chip.x + chip.width).toBeLessThanOrEqual(t.x + plotW);
    // рисунок → карточка выбранного рисунка: нижний край выше шкалы времени
    await page.mouse.click(t.x + t.width * 0.3, t.y + t.height * 0.4);
    await page.mouse.click(t.x + t.width * 0.6, t.y + t.height * 0.3);
    const card = page.getByRole("region", { name: "выбранный рисунок" });
    await expect(card).toBeVisible();
    const axisH = await term.evaluate((el) => (el as HTMLElement & { __chart: { timeScale(): { height(): number } } }).__chart.timeScale().height());
    const c = (await card.boundingBox())!;
    expect(c.y + c.height).toBeLessThanOrEqual(t.y + t.height - axisH);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  }
});

test("карточка выбранного рисунка — из компонентов ui, слева снизу, не шире 720 px; лимит рисунков — по центру, угол скрыт", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  const term = page.getByTestId("terminal");
  const t = (await term.boundingBox())!;
  await page.keyboard.press("Alt+h");
  await page.mouse.click(t.x + t.width * 0.4, t.y + t.height * 0.5);
  const card = page.getByRole("region", { name: "выбранный рисунок" });
  await expect(card).toBeVisible();
  const c = (await card.boundingBox())!;
  expect(c.width).toBeLessThanOrEqual(720);
  expect(c.x - t.x).toBeLessThanOrEqual(12);
  // прежних .chip нет: кнопки, поле и список — ui (Button, IconButton, Select)
  expect(await card.locator("[class*=chip]").count()).toBe(0);
  for (const name of ["алерт на уровне", "заблокировать", "удалить", "снять выделение"]) await expect(card.getByRole("button", { name })).toBeVisible();
  await expect(card.getByLabel("скопировать на инструмент")).toBeVisible();
  // гостю — 10 рисунков: одиннадцатый показывает карточку лимита по центру снизу, угол «− + →|» на это время скрыт.
  // Инструмент — на один рисунок, поэтому остальные — «рисовать серию» (раньше инструмент оставался сам)
  await page.getByRole("toolbar", { name: "панель рисования" }).getByRole("button", { name: "рисовать серию" }).click();
  await page.keyboard.press("Alt+h");
  for (let i = 1; i < 11; i++) await page.mouse.click(t.x + t.width * 0.4, t.y + t.height * (0.15 + i * 0.05));
  const limit = page.getByRole("alert").filter({ hasText: "Лимит рисунков" });
  await expect(limit).toBeVisible();
  await expect(page.locator("[data-corner]")).toHaveCount(0);
  const l = (await limit.boundingBox())!;
  expect(Math.abs(l.x + l.width / 2 - (t.x + t.width / 2))).toBeLessThanOrEqual(t.width * 0.15);
  // вместе с карточкой рисунка — стопкой, не поверх неё
  const c2 = (await card.boundingBox())!;
  expect(l.y + l.height).toBeLessThanOrEqual(c2.y + 0.5);
  await limit.getByRole("button", { name: "понятно" }).click();
  await expect(limit).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-corner]")).toHaveCount(1);
});

test("панель рисования на низком окне (1366×640): отменить и повторить видны, остальное — прокруткой и «ещё инструменты»", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 640 });
  await open(page);
  const tools = page.getByRole("toolbar", { name: "панель рисования" });
  const vh = 640;
  for (const name of ["отменить", "повторить"]) {
    const b = (await tools.getByRole("button", { name }).boundingBox())!;
    expect(b.y + b.height, name).toBeLessThanOrEqual(vh);
  }
  const more = tools.getByRole("button", { name: "ещё инструменты" });
  await expect(more).toBeVisible();
  const list = tools.locator("[class*=toolList]");
  await more.click();
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  // долистали до конца — «ещё инструменты» пропадает, «скрыть все рисунки» в видимой части
  await list.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(more).toHaveCount(0);
  const hide = (await tools.getByRole("button", { name: "скрыть все рисунки" }).boundingBox())!;
  const lb = (await list.boundingBox())!;
  expect(hide.y + hide.height).toBeLessThanOrEqual(lb.y + lb.height + 1);
  // на высоком окне прокрутки нет
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(more).toHaveCount(0);
});

test.describe("палец на десктопной раскладке (iPad 1024 и 1366)", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("кнопки панели рисования — 44 × 44, полоса разделителя панели объектов — 44 px", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await open(page);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    await expect(page.locator("[data-layout]").first()).toHaveAttribute("data-layout", "desktop");
    const sizes = await page.getByRole("toolbar", { name: "панель рисования" }).getByRole("button").evaluateAll((els) => els.map((e) => [e.getAttribute("aria-label"), e.getBoundingClientRect().width, e.getBoundingClientRect().height] as const));
    expect(sizes.length).toBeGreaterThanOrEqual(15);
    for (const [name, w, h] of sizes) {
      expect(w, String(name)).toBeGreaterThanOrEqual(44);
      expect(h, String(name)).toBeGreaterThanOrEqual(44);
    }
    await page.setViewportSize({ width: 1366, height: 1024 });
    const sep = page.getByRole("separator", { name: "ширина панели объектов" });
    await expect(sep).toBeVisible();
    expect((await sep.boundingBox())!.width).toBeGreaterThanOrEqual(44);
  });
});

test.describe("ландшафт телефона шире 900 px (932×430, палец): одна раскладка — десктоп, не смесь с телефонной", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("рейка, шапка, тулбар и панель рисования; строк телефона и ⤢ нет; страница ровно в окно", async ({ page }) => {
    await page.setViewportSize({ width: 932, height: 430 });
    await open(page);
    // запрос ландшафта телефона совпадает, но раскладка выбирается по ширине — как CSS рейки и колонки рисования
    expect(await page.evaluate(() => matchMedia("(orientation: landscape) and (max-height: 520px) and (pointer: coarse)").matches)).toBe(true);
    await expect(page.locator("[data-layout]").first()).toHaveAttribute("data-layout", "desktop");
    await expect(page.getByTestId("app-rail")).toBeVisible();
    await expect(page.getByTestId("terminal-header")).toBeVisible();
    await expect(page.getByTestId("terminal-toolbar")).toBeVisible();
    await expect(page.getByRole("toolbar", { name: "панель рисования" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^(скрыть|показать) панели$/ })).toHaveCount(0);
    // exact: в панели рисования есть «рисовать серию»
    await expect(page.getByRole("button", { name: "Рисовать", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.scrollingElement!.scrollHeight)).toBe(430);
    // имя инструмента целиком и ничем не закрыто: в его центре — сам выбор инструмента
    const symbol = page.getByTestId("terminal-header").locator("[data-overflow-item=symbol]");
    await expect(symbol.locator("span").first()).toHaveText("BTCUSDT");
    const hit = await symbol.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    });
    expect(hit).toBe(true);
    // график не меньше трети окна по высоте и не уходит под край
    const term = await box(page, "[data-testid=terminal]");
    expect(term.height).toBeGreaterThanOrEqual(200);
    expect(term.y + term.height).toBeLessThanOrEqual(430 + 0.5);
  });
});

test.describe("ландшафт телефона 932×430, палец: легенда и окно «?» в пределах графика и экрана", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 932, height: 430 } });

  const ALL = ["ema", "sma", "vwap", "supertrend", "bb", "ichimoku", "keltner", "rsi", "macd", "stoch", "atr", "volume", "cci", "obv"];
  /** Основная панель, низ легенды и поля шкалы цены (относительно графика). */
  const fit = (page: Page) =>
    page.evaluate(() => {
      const host = document.querySelector("[data-testid=terminal]") as HTMLElement & { __chart: { priceScale(id: string): { options(): { scaleMargins: { top: number; bottom: number } } }; panes(): { getHTMLElement(): HTMLElement }[] } };
      const r0 = host.getBoundingClientRect();
      const main = host.__chart.panes()[0]!.getHTMLElement().getBoundingClientRect();
      const lg = document.querySelector("[data-testid=legend]")!.getBoundingClientRect();
      return { mainBottom: main.bottom - r0.top, legendBottom: lg.bottom - r0.top, margins: host.__chart.priceScale("right").options().scaleMargins };
    });

  test("легенда не ниже основной панели: «ещё N» — в строке символа и нажимается, раскрытая прокручивается; свечам с объёмом — не меньше 60 % высоты", async ({ page }) => {
    await page.addInitScript((v) => localStorage.setItem("pl-terminal", JSON.stringify(v)), { ...MANY_INDICATORS, indicators: ALL.map((id) => ({ id, params: {} })) });
    await open(page);
    const legend = page.getByTestId("legend");
    const more = legend.getByRole("button", { name: /^ещё \d+$/ });
    await expect(more).toBeVisible();
    await expect(legend.locator("[class*=legendRow]")).toHaveCount(0);
    await expect.poll(async () => (await fit(page)).margins.top).toBeGreaterThan(0.08);
    let f = await fit(page);
    expect(f.legendBottom).toBeLessThanOrEqual(f.mainBottom);
    expect(1 - f.margins.top - f.margins.bottom).toBeGreaterThanOrEqual(0.6 - 1e-6);
    // в центре «ещё N» — она сама (не строка панелей под легендой); касание раскрывает список
    const b = (await more.boundingBox())!;
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("button")?.textContent?.trim(), { x: b.x + b.width / 2, y: b.y + b.height / 2 })).toMatch(/^ещё \d+$/);
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
    await expect(legend.getByRole("button", { name: "свернуть" })).toHaveAttribute("aria-expanded", "true");
    expect(await legend.locator("[class*=legendRow]").count()).toBeGreaterThan(3);
    await page.waitForTimeout(300);
    f = await fit(page);
    expect(f.legendBottom).toBeLessThanOrEqual(f.mainBottom);
    // раскрытая легенда поле не растит: ложится на старые свечи, свечам — те же 60 %
    expect(1 - f.margins.top - f.margins.bottom).toBeGreaterThanOrEqual(0.6 - 1e-6);
  });

  test("окно «?» не ниже экрана: последняя строка «Как управлять графиком» видна после прокрутки окна", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "что на графике" }).first().tap();
    const dlg = page.getByRole("dialog", { name: "Что на графике" });
    await expect(dlg).toBeVisible();
    const r = await dlg.evaluate((d) => {
      d.scrollTop = d.scrollHeight;
      const last = d.querySelector("section[aria-label='Как управлять графиком']")!.lastElementChild!.getBoundingClientRect();
      return { bottom: d.getBoundingClientRect().bottom, last: last.bottom, h: innerHeight };
    });
    expect(r.bottom).toBeLessThanOrEqual(r.h);
    expect(r.last).toBeLessThanOrEqual(r.bottom);
  });
});

test.describe("iPhone с сайтом на главном экране: отступ под статус-бар (--safe-top = 59 px)", () => {
  test.use({ hasTouch: true, isMobile: true });

  for (const [w, h] of [[390, 844], [1440, 900]] as const) {
    test(`${w}×${h}: страница ровно в окно без прокрутки, верх каркаса — с y = 59, тост не сжимает график`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      // сохранение v4 — один раз показывает тост «Разметка графика обновлена»
      await page.addInitScript(() => {
        if (sessionStorage.getItem("seeded")) return;
        sessionStorage.setItem("seeded", "1");
        localStorage.setItem("pl-terminal", JSON.stringify({ type: "candles", indicators: [{ id: "ema", params: { period: 50 } }], layers: { structure: true, zones: true, liq_map: true }, layers_v: 4, panels: [], scale: "linear", overlay: null }));
      });
      // статус-бар iPhone: env(safe-area-inset-top) в браузере — 0, поэтому отступ задаётся напрямую
      const safeTop = () => page.evaluate(() => new Promise((r) => {
        document.documentElement.style.setProperty("--safe-top", "59px");
        requestAnimationFrame(() => requestAnimationFrame(r));
      }));
      await open(page);
      await safeTop();
      const status = page.getByRole("status");
      await expect(status).toContainText("Разметка графика обновлена");
      const geo = () =>
        page.evaluate(() => {
          const shell = document.querySelector<HTMLElement>("[data-rail]")!;
          const term = document.querySelector<HTMLElement>("[data-testid=terminal]")!.getBoundingClientRect();
          return { scroll: document.scrollingElement!.scrollHeight, inner: innerHeight, top: shell.getBoundingClientRect().top, chartH: Math.round(term.height), chartTop: Math.round(term.top) };
        });
      const withToast = await geo();
      expect(withToast.top).toBe(59);
      expect(withToast.scroll).toBe(withToast.inner);
      // тост — плашка поверх колонки графика: без него график той же высоты и на том же месте
      const toastBox = (await status.boundingBox())!;
      expect(toastBox.y).toBeGreaterThanOrEqual(withToast.chartTop - 1);
      await page.reload();
      await expect(page.getByTestId("terminal").locator("canvas").first()).toBeVisible();
      await safeTop();
      await expect(page.getByRole("status")).toHaveCount(0);
      const without = await geo();
      expect(without.chartH).toBe(withToast.chartH);
      expect(without.chartTop).toBe(withToast.chartTop);
      expect(without.scroll).toBe(without.inner);
    });
  }
});

test.describe("ландшафт телефона уже 900 px (844×390, палец): ⤢ «скрыть панели» не закрывает выбор инструмента (TSA-5)", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 844, height: 390 } });

  test("кнопка левее выбора инструмента, касание по началу выбора — сам выбор; ⤢ прячет и возвращает панели", async ({ page }) => {
    await open(page, "/chart/BTCUSDT/4h", true);
    const root = page.locator("[data-layout]").first();
    await expect(root).toHaveAttribute("data-layout", "phone");
    const fs = page.getByRole("button", { name: "скрыть панели" });
    const picker = root.getByLabel("инструмент", { exact: true });
    await expect(fs).toBeVisible();
    const b = (await fs.boundingBox())!;
    const p = (await picker.boundingBox())!;
    expect(b.x + b.width).toBeLessThanOrEqual(p.x);
    // в начале выбора (где была кнопка) — сам выбор инструмента
    const hit = await picker.evaluate((el, r) => el.contains(document.elementFromPoint(r.x + 10, r.y + r.height / 2)), p);
    expect(hit).toBe(true);
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
    await expect(root).toHaveAttribute("data-bars", "hidden");
    const show = page.getByRole("button", { name: "показать панели" });
    await expect(show).toBeVisible();
    await show.tap();
    await expect(root).toHaveAttribute("data-bars", "shown");
  });
});
