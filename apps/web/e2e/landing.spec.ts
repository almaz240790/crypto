import { expect, test, type Page } from "@playwright/test";

/**
 * Главная (ADR-0006): кнопка «Открыть график» — одна (на первом экране), последнего блока «Откройте график
 * прямо сейчас» нет, картинки из public/landing грузятся, страница не прокручивается вбок, а пункты блока
 * «Честный инструмент» видны целиком — без обрезанного соседнего слайда на телефоне. В полосе «Уровни, зоны
 * и ликвидации» шкала графика с полосой ликвидаций и список с ликвидациями ничем не закрыты; на компьютере
 * текст полос стоит по центру по высоте, без большой пустоты под ним.
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
  // «Смена ↑/↓» в «Основах» — с неразрывным пробелом: стрелка не уходит одна на новую строку (iPhone 375)
  await expect(main.getByRole("listitem").filter({ hasText: "CHoCH" })).toContainText("«Смена\u00a0↑» или «Смена\u00a0↓»");
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

/**
 * Точки картинки (доли ширины и высоты) → экран, с учётом поворота карточки и сжатия блока карточек: невидимая
 * «тень» с теми же размерами и transform, в ней метки. true — точка внутри полосы и сверху лежит сама картинка.
 */
async function visiblePoints(page: Page, src: string, pts: [number, number][]): Promise<boolean[]> {
  return page.evaluate(
    ({ src, pts }) => {
      const img = document.querySelector<HTMLImageElement>(`main img[src^="${src}"]`)!;
      const cs = getComputedStyle(img);
      const ghost = document.createElement("div");
      Object.assign(ghost.style, {
        position: "absolute",
        left: `${img.offsetLeft}px`,
        top: `${img.offsetTop}px`,
        width: `${img.offsetWidth}px`,
        height: `${img.offsetHeight}px`,
        transform: cs.transform,
        transformOrigin: cs.transformOrigin,
        visibility: "hidden",
        pointerEvents: "none",
      });
      img.parentElement!.appendChild(ghost);
      const band = img.closest("section")!.getBoundingClientRect();
      const out = pts.map(([fx, fy]) => {
        const m = document.createElement("i");
        Object.assign(m.style, { position: "absolute", left: `${fx * 100}%`, top: `${fy * 100}%`, width: "1px", height: "1px" });
        ghost.appendChild(m);
        const r = m.getBoundingClientRect();
        const inside = r.top > band.top && r.top < band.bottom && r.left > 0 && r.left < innerWidth;
        return inside && document.elementFromPoint(r.left, r.top) === img;
      });
      ghost.remove();
      return out;
    },
    { src, pts },
  );
}

const grid = (xs: number[], ys: number[]) => xs.flatMap((x) => ys.map((y) => [x, y] as [number, number]));

// «Уровни, зоны и ликвидации»: правая треть графика (шкала, полоса ликвидаций и метки сумм) и список с ликвидациями
// ничем не закрыты и не уходят за край полосы — на телефоне, планшете, в сжатых диапазонах 901–1279 и на компьютере
for (const width of [390, 768, 1024, 1180, 1440]) {
  test(`${width}: полоса ликвидаций с метками сумм и список ликвидаций видны целиком`, async ({ page }) => {
    const mobile = width < 900;
    await page.setViewportSize({ width, height: 1200 });
    await page.goto("/");
    const band = page.getByRole("region", { name: /Уровни, зоны и ликвидации/ });
    await band.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 20));
    for (const src of ["/landing/liq.", "/landing/levels."]) {
      await expect.poll(() => page.locator(`main img[src^="${src}"]`).evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
    }
    const ys = Array.from({ length: 10 }, (_, i) => 0.05 + i * 0.1);
    const liq = await visiblePoints(page, "/landing/liq.", grid([0.7, 0.8, 0.9], ys));
    expect(liq.filter((v) => !v), `закрытые точки шкалы графика (${mobile ? "телефон" : "компьютер"})`).toHaveLength(0);
    const lv = await visiblePoints(page, "/landing/levels.", grid([0.1, 0.5, 0.9], ys.map((y) => Math.min(y, 0.94))));
    expect(lv.filter((v) => !v), "закрытые точки списка уровней").toHaveLength(0);
  });
}

// Компьютер: текст полос — по центру по высоте, под ним нет большой пустоты до подписи к картинке
for (const width of [1024, 1440]) {
  test(`${width}: текст полос по центру, до подписи не больше 260 px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    const bands = await page.evaluate(() =>
      [...document.querySelectorAll("main > section")]
        .filter((sec) => sec.querySelector("p[class*=fine]"))
        .map((sec) => {
          const top = sec.getBoundingClientRect().top;
          const copy = sec.querySelector("h2")!.parentElement!;
          const kids = [...copy.children].filter((k) => !/fine/.test(k.className));
          const fine = copy.querySelector("p[class*=fine]")!.getBoundingClientRect();
          const first = kids[0].getBoundingClientRect(), last = kids[kids.length - 1].getBoundingClientRect();
          return { h: sec.querySelector("h2")!.textContent, height: sec.getBoundingClientRect().height, mid: (first.top + last.bottom) / 2 - top, gap: fine.top - last.bottom };
        }),
    );
    expect(bands).toHaveLength(3);
    for (const b of bands) {
      expect(b.gap, b.h!).toBeLessThanOrEqual(260);
      expect(b.gap, b.h!).toBeGreaterThan(40);
      expect(Math.abs(b.mid - b.height * 0.475), b.h!).toBeLessThan(24);
    }
  });
}
