import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { blockBinance } from "./helpers/binance";

/**
 * Отдельный вход в админку (ADR-0011) с заглушкой API на уровне браузера: первая настройка кода (QR, резервные
 * коды), обычный вход, неверный код, не-админ, ссылка из письма, конец сеанса, раздельный выход, нет ссылки
 * на админку в меню сайта. Компьютер и телефон (390×844, касание).
 */

const ADMIN_EMAIL = "owner@example.com";
const PASSWORD = "correct horse battery";
const GENERIC = "Не получилось войти. Проверьте email и пароль.";
const CODE_FAILED = "Код не подошёл. Введите свежий код из приложения — он меняется каждые 30 секунд.";
const ME = { id: 1, email: ADMIN_EMAIL, name: null, role: "owner", method: "password", started_at: "2026-11-05T10:00:00Z", expires_at: "2026-11-05T18:00:00Z", idle_minutes: 60, backup_codes_left: 10 };
const SITE_ME = { id: 1, email: ADMIN_EMAIL, name: null, email_verified: true, role: "owner", locale: "ru", timezone: "UTC", theme: "system", risk: { deposit: null, risk_pct: "1.00", exchange: "binance", market_type: "futures", default_leverage: 3, experience: null } };
const BACKUP = ["ABCDEFGH23", "BCDEFGHJ34", "CDEFGHJK45", "DEFGHJKL56", "EFGHJKLM67", "FGHJKLMN78", "GHJKLMNP89", "HJKLMNPQ92", "JKLMNPQR23", "KLMNPQRS34"];
// QR версии 1 (21×21): три «глазка» по углам — для снимка достаточно
const eye = (x: number, y: number) => `M${x} ${y}h7v1h-7zM${x} ${y + 6}h7v1h-7zM${x} ${y + 1}h1v5h-1zM${x + 6} ${y + 1}h1v5h-1zM${x + 2} ${y + 2}h3v3h-3z`;
const QR = { size: 21, path: eye(0, 0) + eye(14, 0) + eye(0, 14) + "M8 8h5v1h-5zM9 10h3v1h-3zM8 12h1v1h-1zM12 12h1v1h-1z" };
const SETUP = { secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP", otpauth_url: "otpauth://totp/PlatformSol:owner%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=PlatformSol", qr: QR };

type Opts = { twoFactor?: boolean; mail?: boolean; sessionAlive?: boolean };

/** Заглушка API: состояние сеанса админки и сайта, журнал вызовов. */
async function mockApi(page: Page, calls: string[], opts: Opts = {}) {
  const state = { twoFactor: opts.twoFactor ?? true, session: opts.sessionAlive ?? true };
  await blockBinance(page.context());
  await page.route("**/v1/**", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    calls.push(`${req.method()} ${p}`);
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    const body = () => (req.postDataJSON() ?? {}) as Record<string, string>;
    if (p.startsWith("/v1/admin/") && req.headers()["authorization"]) calls.push(`SITE-TOKEN ${p}`);
    if (p === "/v1/admin/auth/config") return json(200, { mail: opts.mail ?? true, idle_minutes: 60, session_hours: 8 });
    if (p === "/v1/admin/auth/login") {
      const b = body();
      if (b.email === ADMIN_EMAIL && b.password === PASSWORD) return json(200, { step: state.twoFactor ? "code" : "setup", ticket: "ticket-password-1", email: ADMIN_EMAIL });
      return json(401, { detail: GENERIC });
    }
    if (p === "/v1/admin/auth/magic") return json(202, { status: "ok" });
    if (p === "/v1/admin/auth/magic/consume") {
      return body().link === "good-link-123456" ? json(200, { step: state.twoFactor ? "code" : "setup", ticket: "ticket-link-1", email: ADMIN_EMAIL }) : json(400, { detail: "Ссылка недействительна или устарела. Запросите новую." });
    }
    if (p === "/v1/admin/auth/setup") return json(200, SETUP);
    if (p === "/v1/admin/auth/setup/confirm") {
      if (body().code !== "123456") return json(401, { detail: CODE_FAILED });
      state.twoFactor = true;
      state.session = true;
      return json(200, { ...ME, backup_codes: BACKUP });
    }
    if (p === "/v1/admin/auth/verify") {
      const code = body().code;
      if (code !== "123456" && code !== BACKUP[0]) return json(401, { detail: CODE_FAILED });
      state.session = true;
      return json(200, ME);
    }
    if (p === "/v1/admin/auth/me") return state.session ? json(200, ME) : json(401, { detail: "Сеанс админки закончился. Войдите снова." });
    if (p === "/v1/admin/auth/logout") {
      state.session = false;
      return route.fulfill({ status: 204 });
    }
    if (p === "/v1/admin/strategies") return state.session ? json(200, { versions: [], runs: [], requests: [], me: { id: 1, role: "owner" } }) : json(401, { detail: "Сеанс админки закончился. Войдите снова." });
    if (p === "/v1/auth/refresh") return json(200, { access_token: "site.jwt", token_type: "bearer", expires_in: 900 });
    if (p === "/v1/auth/me") return json(200, SITE_ME);
    if (p === "/v1/auth/logout") return route.fulfill({ status: 204 });
    if (p === "/v1/watchlist") return json(200, { id: 1, name: "Основной", items: [] });
    return json(404, { detail: "нет заглушки" });
  });
}

async function hint(context: BrowserContext, name: string) {
  return (await context.cookies()).find((c) => c.name === name)?.value ?? null;
}

/** Страница входа ожила (гидратация и настройки получены): до этого ввод в поля React не увидит. */
async function ready(page: Page) {
  await expect(page.getByText(/Нет пароля\? Войти по ссылке на почту|Вход по ссылке на почту сейчас недоступен/)).toBeVisible();
}

async function noSideScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

async function firstTimeSetup(page: Page, calls: string[]) {
  await mockApi(page, calls, { twoFactor: false });
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login\?next=%2Fadmin$/);
  await expect(page.getByRole("heading", { name: "Вход в админку" })).toBeVisible();
  await ready(page);
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Пароль").fill(PASSWORD);
  await page.getByRole("button", { name: "Продолжить" }).click();
  await expect(page.getByRole("heading", { name: "Защитите вход кодом из телефона" })).toBeVisible();
  await expect(page.getByTestId("admin-qr").locator("svg")).toBeVisible();
  const add = page.getByRole("link", { name: "Добавить код на этом устройстве" });
  await expect(add).toHaveAttribute("href", SETUP.otpauth_url);
  await page.getByRole("button", { name: "Не получается? Ввести ключ вручную" }).click();
  await expect(page.getByTestId("admin-secret")).toHaveText("JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP");
  // неверный первый код — подсказка, шаг не меняется
  await page.getByLabel("Код из приложения").fill("000000");
  await page.getByRole("button", { name: "Включить защиту и войти" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(CODE_FAILED);
  await page.getByLabel("Код из приложения").fill("123 456");
  await page.getByRole("button", { name: "Включить защиту и войти" }).click();
  await expect(page.getByRole("heading", { name: "Сохраните резервные коды" })).toBeVisible();
  await expect(page.getByTestId("backup-codes").getByRole("listitem")).toHaveCount(10);
  const go = page.getByRole("button", { name: "Перейти в админку" });
  await expect(go).toBeDisabled();
  await page.getByLabel(/Я сохранил\(а\) коды/).check();
  await go.click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByTestId("admin-who")).toContainText(ADMIN_EMAIL);
  await expect(page.getByRole("button", { name: "Выйти из админки" })).toBeVisible();
  expect(calls).toContain("POST /v1/admin/auth/setup/confirm");
  expect(calls.filter((c) => c.startsWith("SITE-TOKEN"))).toEqual([]);
}

test.describe("вход в админку — компьютер", () => {
  test("первый вход: QR-код, неверный и верный код, резервные коды, админка", async ({ page }) => {
    const calls: string[] = [];
    await firstTimeSetup(page, calls);
  });

  test("обычный вход: пароль → неверный код → резервный код; в шапке — кто вошёл", async ({ page }) => {
    const calls: string[] = [];
    await mockApi(page, calls);
    await page.goto("/admin/login");
    await ready(page);
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Пароль").fill(PASSWORD);
    await page.getByRole("button", { name: "Продолжить" }).click();
    await expect(page.getByRole("heading", { name: "Код из приложения" })).toBeVisible();
    await expect(page.getByText(`Вход для ${ADMIN_EMAIL}`)).toBeVisible();
    await page.getByLabel("Код", { exact: true }).fill("111111");
    await page.getByRole("button", { name: "Войти в админку" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toHaveText(CODE_FAILED);
    await page.getByLabel("Код", { exact: true }).fill(BACKUP[0]!.toLowerCase());
    await page.getByRole("button", { name: "Войти в админку" }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByTestId("admin-who")).toContainText("владелец");
    expect(await hint(page.context(), "pl_admin_hint")).toBe("1");
  });

  test("не-админ и неверный пароль — одна и та же ошибка, второй шаг не открывается", async ({ page }) => {
    const calls: string[] = [];
    await mockApi(page, calls);
    await page.goto("/admin/login");
    await ready(page);
    for (const [email, password] of [["trader@example.com", PASSWORD], [ADMIN_EMAIL, "wrong password"]] as const) {
      await page.getByLabel("Email").fill(email);
      await page.getByLabel("Пароль").fill(password);
      await page.getByRole("button", { name: "Продолжить" }).click();
      await expect(page.getByRole("main").getByRole("alert")).toHaveText(GENERIC);
      await expect(page.getByRole("heading", { name: "Вход в админку" })).toBeVisible();
    }
    expect(calls.filter((c) => c === "POST /v1/admin/auth/login")).toHaveLength(2);
    expect(calls.some((c) => c.includes("/verify") || c.includes("/setup"))).toBe(false);
  });

  test("вход по ссылке из письма; без почты на сервере — честная подсказка", async ({ page }) => {
    const calls: string[] = [];
    await mockApi(page, calls);
    await page.goto("/admin/login");
    await ready(page);
    await page.getByRole("button", { name: "Нет пароля? Войти по ссылке на почту" }).click();
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByRole("button", { name: "Прислать ссылку" }).click();
    await expect(page.getByRole("heading", { name: "Проверьте почту" })).toBeVisible();
    await page.goto("/admin/login?link=good-link-123456");
    await expect(page.getByRole("heading", { name: "Код из приложения" })).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/login$/); // токен ссылки убран из адреса
    await page.goto("/admin/login?link=bad-link-1234567");
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Ссылка недействительна");
    const calls2: string[] = [];
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await mockApi(page, calls2, { mail: false });
    await page.goto("/admin/login");
    await ready(page);
    await expect(page.getByText("Вход по ссылке на почту сейчас недоступен")).toBeVisible();
    await expect(page.getByRole("button", { name: "Нет пароля? Войти по ссылке на почту" })).toHaveCount(0);
  });

  test("/admin без сеанса админки — на /admin/login, даже если вошли на сайт; сеанс кончился — подсказка", async ({ page }) => {
    const calls: string[] = [];
    await mockApi(page, calls, { sessionAlive: false });
    await page.context().addCookies([{ name: "pl_auth", value: "1", domain: "localhost", path: "/" }]);
    await page.goto("/admin?tab=users");
    await expect(page).toHaveURL(/\/admin\/login\?next=%2Fadmin%3Ftab%3Dusers$/);
    // подсказка осталась от прошлого сеанса, но API говорит «закончился»
    await page.context().addCookies([{ name: "pl_admin_hint", value: "1", domain: "localhost", path: "/admin" }]);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/admin\/login\?next=%2Fadmin&ended=1$/);
    await expect(page.getByRole("status")).toContainText("Сеанс админки закончился");
    expect(await hint(page.context(), "pl_admin_hint")).toBeNull();
    expect(calls.filter((c) => c.startsWith("SITE-TOKEN"))).toEqual([]);
  });

  test("выход из админки не выводит с сайта, выход с сайта не закрывает админку", async ({ page }) => {
    const calls: string[] = [];
    await mockApi(page, calls);
    await page.context().addCookies([
      { name: "pl_auth", value: "1", domain: "localhost", path: "/" },
      { name: "pl_admin_hint", value: "1", domain: "localhost", path: "/admin" },
    ]);
    await page.goto("/admin");
    await page.getByRole("button", { name: "Выйти из админки" }).click();
    await expect(page).toHaveURL(/\/admin\/login$/);
    expect(calls).toContain("POST /v1/admin/auth/logout");
    expect(calls).not.toContain("POST /v1/auth/logout");
    expect(await hint(page.context(), "pl_auth")).toBe("1");
    expect(await hint(page.context(), "pl_admin_hint")).toBeNull();
    // сайт: «Выйти» — только выход с сайта
    await page.context().addCookies([{ name: "pl_admin_hint", value: "1", domain: "localhost", path: "/admin" }]);
    await page.goto("/watchlist");
    await page.getByRole("button", { name: "Выйти", exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    expect(calls).toContain("POST /v1/auth/logout");
    expect(calls.filter((c) => c === "POST /v1/admin/auth/logout")).toHaveLength(1);
    expect(await hint(page.context(), "pl_admin_hint")).toBe("1");
  });

  test("в меню сайта у владельца нет ссылки на админку", async ({ page }) => {
    const calls: string[] = [];
    await mockApi(page, calls);
    await page.context().addCookies([{ name: "pl_auth", value: "1", domain: "localhost", path: "/" }]);
    await page.goto("/watchlist");
    await expect(page.getByTitle(ADMIN_EMAIL)).toBeVisible();
    await expect(page.getByRole("link", { name: "Админка" })).toHaveCount(0);
    await expect(page.locator('a[href^="/admin"]')).toHaveCount(0);
  });
});

test.describe("вход в админку — телефон", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

  test("первый вход на iPhone: кнопка «Добавить код на этом устройстве» выше QR, без бокового скролла", async ({ page }) => {
    const calls: string[] = [];
    await mockApi(page, calls, { twoFactor: false });
    await page.goto("/admin/login");
    await ready(page);
    await noSideScroll(page);
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Пароль").fill(PASSWORD);
    await page.getByRole("button", { name: "Продолжить" }).click();
    const add = page.getByRole("link", { name: "Добавить код на этом устройстве" });
    await expect(add).toBeVisible();
    const qr = page.getByTestId("admin-qr");
    const [a, q] = [await add.boundingBox(), await qr.boundingBox()];
    expect(a!.y).toBeLessThan(q!.y);
    expect(a!.height).toBeGreaterThanOrEqual(44);
    await noSideScroll(page);
    await page.getByLabel("Код из приложения").fill("123456");
    await page.getByRole("button", { name: "Включить защиту и войти" }).click();
    await expect(page.getByTestId("backup-codes")).toBeVisible();
    await noSideScroll(page);
    await page.getByLabel(/Я сохранил\(а\) коды/).check();
    await page.getByRole("button", { name: "Перейти в админку" }).click();
    await expect(page.getByRole("button", { name: "Выйти из админки" })).toBeVisible();
    await noSideScroll(page);
  });

  test("обычный вход и неверный код на телефоне", async ({ page }) => {
    const calls: string[] = [];
    await mockApi(page, calls);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/admin\/login/);
    await ready(page);
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Пароль").fill(PASSWORD);
    await page.getByRole("button", { name: "Продолжить" }).click();
    await page.getByLabel("Код", { exact: true }).fill("000000");
    await page.getByRole("button", { name: "Войти в админку" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toHaveText(CODE_FAILED);
    await page.getByLabel("Код", { exact: true }).fill("123456");
    await page.getByRole("button", { name: "Войти в админку" }).click();
    await expect(page.getByTestId("admin-who")).toContainText(ADMIN_EMAIL);
    await noSideScroll(page);
  });

  test("не-админ на телефоне получает общую ошибку", async ({ page }) => {
    const calls: string[] = [];
    await mockApi(page, calls);
    await page.goto("/admin/login");
    await ready(page);
    await page.getByLabel("Email").fill("trader@example.com");
    await page.getByLabel("Пароль").fill(PASSWORD);
    await page.getByRole("button", { name: "Продолжить" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toHaveText(GENERIC);
  });
});
