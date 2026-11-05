import { expect, test, type Page } from "@playwright/test";

/**
 * Главная (ADR-0006): кнопка «Открыть график» — одна (на первом экране), последнего блока «Откройте график
 * прямо сейчас» нет, картинки из public/landing грузятся, страница не прокручивается вбок, а пункты блока
 * «Честный инструмент» видны целиком — без обрезанного соседнего слайда на телефоне.
 */

const CHART = "/chart/BTCUSDT/4h";

/** Вошедший пользователь: кука-флаг и ответы auth (как в pwa.spec). */
async function signIn(page: Page, baseURL: string) {
  await page.context().addCookies([{ name: "pl_auth", value: "1", url: baseURL }]);
  await page.route("**/v1/**", (route) => {
    const p = new URL(route.request().url()).pathname;
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (p === "/v1/auth/refresh") return json(200, { access_token: "t" });
    if (p === "/v1/auth/me") return json(200, { id: 1, email: "a@b.c", name: null, email_verified: true, role: "user", locale: "ru", timezone: "UTC", theme: "system", risk: {} });
    return json(404, { detail: "нет" });
  });
}

test("одна кнопка «Открыть график» — на первом экране; последнего блока и «Посмотреть на BTC» нет", async ({ page }) => {
  await page.goto("/");
  const main = page.getByRole("main");
  const open = page.getByRole("link", { name: "Открыть график", exact: true });
  await expect(open).toHaveCount(1);
  await expect(main.getByRole("region", { name: /Технический анализ/ }).getByRole("link", { name: "Открыть график" })).toHaveAttribute("href", CHART);
  await expect(page.getByRole("link", { name: "Посмотреть на BTC" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /Откройте график/ })).toHaveCount(0);
  // «Зарегистрироваться» — другое действие, остаётся
  await expect(main.getByRole("link", { name: "Зарегистрироваться" })).toHaveAttribute("href", "/register");
  // последний блок перед подвалом — «Честный инструмент» (тёмный), а не салатовый «Основы»: иначе он слился бы с подвалом
  await expect(main.locator(":scope > section").last()).toHaveAttribute("aria-labelledby", "h-trust");
  // новость в полосе сверху — про цену с биржи и позицию, без обещаний доходности
  await expect(main.getByRole("link", { name: "цена прямо с биржи в реальном времени" })).toHaveAttribute("href", CHART);
});

test("вошедший: в шапке главной нет второй «Открыть график», на других страницах — есть", async ({ page, baseURL }) => {
  await signIn(page, baseURL!);
  await page.goto("/");
  const header = page.getByRole("banner");
  // шапка перешла в вид для вошедшего: «Регистрации» нет
  await expect(header.getByRole("link", { name: "Регистрация" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Открыть график", exact: true })).toHaveCount(1);
  await expect(header.getByRole("navigation", { name: "разделы" }).getByRole("link", { name: "График" })).toBeVisible();
  await page.goto("/pricing");
  await expect(header.getByRole("link", { name: /Открыть график/ })).toBeVisible();
});

const VIEWPORTS = [
  { name: "телефон 390", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  { name: "планшет 768", viewport: { width: 768, height: 1024 }, isMobile: false, hasTouch: false },
  { name: "компьютер 1440", viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false },
] as const;

for (const v of VIEWPORTS) {
  test.describe(v.name, () => {
    test.use({ viewport: v.viewport, isMobile: v.isMobile, hasTouch: v.hasTouch });

    test("картинки загружены, без прокрутки вбок, пункты «Честный инструмент» целиком", async ({ page }) => {
      await page.goto("/");
      const imgs = page.locator('main img[src^="/landing/"]');
      await expect(imgs).toHaveCount(4);
      for (const img of await imgs.all()) {
        await expect(img).not.toHaveAttribute("alt", "");
        await img.scrollIntoViewIfNeeded();
        await expect.poll(() => img.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : 0))).toBeGreaterThan(0);
      }
      const page_ = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      expect(page_.scroll).toBeLessThanOrEqual(page_.client);

      const list = page.getByRole("list", { name: /Честный/ });
      await list.scrollIntoViewIfNeeded();
      // список не листается вбок: ничего не спрятано за краем
      expect(await list.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      const items = list.getByRole("listitem");
      await expect(items).toHaveCount(4);
      for (const li of await items.all()) {
        const box = (await li.locator("p").boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(v.viewport.width);
        await expect(li.locator("p")).toBeVisible();
      }
    });
  });
}
