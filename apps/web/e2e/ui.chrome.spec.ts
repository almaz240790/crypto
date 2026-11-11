import { devices, expect, test, type Page } from "@playwright/test";

/**
 * Элементы терминала на витрине /ui (план 2B.9): клавиатура и фокус Menu, Popover и вкладок
 * SegmentedControl, закрытый таймфрейм с окном, зоны касания 44 px под pointer: coarse.
 */

const focusedName = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute("aria-label") || document.activeElement?.textContent?.trim() || "");

test("Menu: стрелки, Home/End, буквы, Enter выбирает и возвращает фокус, Esc закрывает", async ({ page }) => {
  await page.goto("/ui");
  const trigger = page.getByRole("button", { name: "Разметка: Чистый" });
  await expect(trigger).toHaveAttribute("aria-haspopup", "menu");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(menu.getByRole("menuitemradio", { name: "Чистый" })).toBeFocused();
  await expect(menu.getByRole("menuitemradio", { name: "Чистый" })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitemradio", { name: "Структура" })).toBeFocused();
  await page.keyboard.press("End");
  await expect(menu.getByRole("menuitem", { name: "Настроить слои…" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitemradio", { name: "Чистый" })).toBeFocused();
  // недоступный пункт фокусируется, но не выбирается
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(menu.getByRole("menuitemradio", { name: /^Свой/ })).toBeFocused();
  await expect(menu.getByRole("menuitemradio", { name: /^Свой/ })).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Enter");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Home");
  // кириллица не на раскладке US: keyboard.type вставляет текст без keydown — событие клавиши напрямую
  await menu.locator(":focus").dispatchEvent("keydown", { key: "п", bubbles: true });
  await expect(menu.getByRole("menuitemradio", { name: "Подробный" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  const chosen = page.getByRole("button", { name: "Разметка: Подробный" });
  await expect(chosen).toBeFocused();
  // с клавиатуры: ↑ открывает на последнем пункте, Esc закрывает и возвращает фокус на кнопку
  await page.keyboard.press("ArrowUp");
  await expect(menu.getByRole("menuitem", { name: "Настроить слои…" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(chosen).toBeFocused();
  // клик снаружи закрывает
  await chosen.click();
  await expect(menu).toBeVisible();
  await page.getByRole("heading", { name: "Дизайн-система" }).click();
  await expect(menu).toBeHidden();
});

test("Popover: фокус внутрь, Esc закрывает и возвращает фокус на кнопку, клик снаружи закрывает", async ({ page }) => {
  await page.goto("/ui");
  const view = page.getByRole("button", { name: "Вид", exact: true });
  await expect(view).toHaveAttribute("aria-haspopup", "dialog");
  await view.click();
  const dialog = page.getByRole("dialog", { name: "Вид" });
  await expect(dialog).toBeVisible();
  await expect(view).toHaveAttribute("aria-expanded", "true");
  await expect(dialog.getByLabel("тип графика")).toBeFocused();
  // окно у кнопки: под ней и в пределах окна браузера
  const [b, d] = [await view.boundingBox(), await dialog.boundingBox()];
  expect(d!.y).toBeGreaterThanOrEqual(b!.y + b!.height);
  expect(d!.x + d!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await dialog.getByLabel("тип графика").selectOption("heikin");
  await expect(dialog.getByText("Паттерны считаются по обычным свечам")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(view).toBeFocused();
  await view.click();
  await expect(dialog).toBeVisible();
  await page.getByRole("heading", { name: "Дизайн-система" }).click();
  await expect(dialog).toBeHidden();
});

test("SegmentedControl: вкладки стрелками, переключатель, закрытый таймфрейм открывает окно без перехода", async ({ page }) => {
  await page.goto("/ui");
  const tabs = page.getByRole("tablist", { name: "разделы найденного" });
  const levels = tabs.getByRole("tab", { name: "Уровни (6)" });
  await expect(levels).toHaveAttribute("aria-selected", "true");
  await levels.focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.getByRole("tab", { name: "Фигуры (1)" })).toBeFocused();
  await expect(tabs.getByRole("tab", { name: "Фигуры (1)" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toContainText("фигуры");
  await page.keyboard.press("End");
  await expect(tabs.getByRole("tab", { name: "Паттерны (2)" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(levels).toBeFocused();
  // в порядке Tab — одна вкладка
  await expect(tabs.locator('[tabindex="0"]')).toHaveCount(1);

  const group = page.getByRole("group", { name: "число графиков" });
  await group.getByRole("button", { name: "4" }).click();
  await expect(group.getByRole("button", { name: "4" })).toHaveAttribute("aria-pressed", "true");
  await expect(group.getByRole("button", { name: "2" })).toHaveAttribute("aria-pressed", "false");

  const tf = page.getByRole("navigation", { name: "таймфрейм" });
  await expect(tf.getByRole("link", { name: "4ч" })).toHaveAttribute("aria-current", "page");
  expect((await tf.locator("a, button").allInnerTexts()).map((x) => x.trim())).toEqual(["1ч", "4ч", "1Д", "1Н", "1м", "5м", "15м"]);
  const url = page.url();
  const m1 = tf.getByRole("button", { name: "1м", exact: true });
  await expect(m1).toHaveAttribute("data-locked", "true");
  await m1.click();
  const locked = page.getByRole("dialog", { name: "Минутные таймфреймы" });
  await expect(locked).toBeVisible();
  await expect(locked.getByRole("link", { name: "Войти" })).toBeFocused();
  expect(page.url()).toBe(url);
  await page.keyboard.press("Escape");
  await expect(locked).toBeHidden();
  await expect(m1).toBeFocused();
  // в активном сегменте фон отличается от фона ряда (светлая тема тоже)
  for (const theme of ["dark", "light"]) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    const [seg, box] = await tf.getByRole("link", { name: "4ч" }).evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el.parentElement!).backgroundColor]);
    expect(seg, theme).not.toBe(box);
  }
});

test("IconButton: имя, нажатое состояние", async ({ page }) => {
  await page.goto("/ui");
  const magnet = page.getByRole("button", { name: "магнит к OHLC" });
  await expect(magnet).toHaveAttribute("aria-pressed", "true");
  await magnet.click();
  await expect(magnet).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Снимок", exact: true }).click();
  await expect(page.getByTestId("ui-demo-log")).toHaveText("последнее действие: Снимок");
  await expect(page.getByRole("button", { name: "отменить" })).toBeDisabled();
  expect(await focusedName(page)).not.toBe("отменить");
});

const { defaultBrowserType: _ignored, ...pixel5 } = devices["Pixel 5"];
void _ignored;

test.describe("под pointer: coarse", () => {
  test.use({ ...pixel5 });

  test("кнопки-иконки, сегменты и пункты меню — не меньше 44 × 44", async ({ page }) => {
    await page.goto("/ui");
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const sizes = async (sel: string) => page.locator(sel).evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => [e.getAttribute("aria-label") ?? e.textContent?.trim(), e.getBoundingClientRect().width, e.getBoundingClientRect().height] as const));
    const icon = await sizes('[data-testid="ui-chrome-demo"] [title][aria-label]:is(button, a)');
    expect(icon.length).toBeGreaterThanOrEqual(9);
    const tf = await sizes('nav[aria-label="таймфрейм"] :is(a, button)');
    expect(tf).toHaveLength(7);
    await page.getByRole("button", { name: /^Разметка:/ }).click();
    const items = await sizes('[role="menu"] [role^="menuitem"]');
    expect(items.length).toBeGreaterThanOrEqual(6);
    for (const [name, w, h] of [...icon, ...tf, ...items]) {
      expect(w, String(name)).toBeGreaterThanOrEqual(44);
      expect(h, String(name)).toBeGreaterThanOrEqual(44);
    }
  });
});
