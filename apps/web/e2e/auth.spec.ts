import { expect, test, type Page } from "@playwright/test";
import { blockBinance } from "./helpers/binance";

/** e2e трёх способов входа (план 2.8) с заглушкой API на уровне браузера. */

const ME = {
  id: 7,
  email: "trader@example.com",
  name: null,
  email_verified: true,
  role: "user",
  locale: "ru",
  timezone: "UTC",
  theme: "system",
  risk: { deposit: null, risk_pct: "1.00", exchange: "binance", market_type: "futures", default_leverage: 3, experience: null },
};
const TOKEN = { access_token: "test.jwt.token", token_type: "bearer", expires_in: 900 };
const CLOSED_ROW = {
  id: "c1", symbol: "BTCUSDT", instrument_id: 1, strategy_version: "1.1.0", direction: "long", candle_close_time: "2026-10-25T08:00:00Z",
  created_at: "", entry_market: "100.5", entry_limit: null, stop_loss: "98.5", tp1: "103", tp2: "105.5", tp3: "108",
  rr_tp2: "2.5", score: 77, grade: "A", status: "closed_sl", flags: [], last_event_at: null, result: null,
};

async function mockApi(page: Page, calls: string[]) {
  // после входа — /chart: терминал соединился бы с настоящей Binance (своя заглушка API, mock() из helpers/chart
  // здесь не вызывается) — биржа закрыта, как в остальных спеках
  await blockBinance(page.context());
  await page.route("**/v1/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    calls.push(`${req.method()} ${url.pathname}`);
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    const p = url.pathname;
    if (p === "/v1/auth/login") {
      const b = req.postDataJSON() as { email: string; password: string };
      if (b.email === "2fa@example.com") return json(200, { access_token: "", two_factor: true, ticket: "ticket-1" });
      return b.password === "correct-horse-battery" ? json(200, TOKEN) : json(401, { detail: "неверный email или пароль" });
    }
    if (p === "/v1/auth/login/2fa") {
      const b = req.postDataJSON() as { ticket: string; code: string };
      return b.ticket === "ticket-1" && b.code === "123456" ? json(200, TOKEN) : json(401, { detail: "неверный код" });
    }
    if (p === "/v1/auth/register") return json(201, TOKEN);
    if (p === "/v1/auth/magic/consume") {
      const b = req.postDataJSON() as { token: string };
      return b.token === "good" ? json(200, TOKEN) : json(400, { detail: "ссылка недействительна или устарела" });
    }
    if (p === "/v1/auth/google") return json(200, TOKEN);
    if (p === "/v1/auth/refresh") return json(200, TOKEN);
    if (p === "/v1/auth/me") return json(200, ME);
    if (p === "/v1/me/risk") return json(200, { ...ME, risk: { ...ME.risk, ...(req.postDataJSON() as object) } });
    if (p === "/v1/auth/logout") return route.fulfill({ status: 204 });
    return json(404, { detail: "нет заглушки" });
  });
  await page.route("https://api.pwnedpasswords.com/**", (route) => route.fulfill({ status: 200, body: "" }));
}

test("защищённая страница без входа ведёт на /login", async ({ page }) => {
  await page.goto("/signals");
  await expect(page).toHaveURL(/\/login\?next=%2Fsignals/);
  // каждый защищённый раздел: список PROTECTED и matcher в src/proxy.ts должны совпадать
  for (const path of ["/billing", "/journal", "/watchlist", "/alerts", "/screener", "/calculator", "/settings"]) {
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent(path).replace(/\//g, "%2F")}`));
  }
  // админка — свой вход (ADR-0011), не вход сайта
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login\?next=%2Fadmin$/);
});

test("вход по email и паролю", async ({ page }) => {
  const calls: string[] = [];
  await mockApi(page, calls);
  await page.goto("/login");
  await page.getByLabel("Email").fill("trader@example.com");
  await page.getByLabel("Пароль").fill("wrong-password-1");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "неверный" })).toBeVisible();
  await page.getByLabel("Пароль").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).toHaveURL(/\/chart(\/|$)/);
  await expect(page.getByTitle("trader@example.com")).toBeVisible();
  expect(calls).toContain("POST /v1/auth/login");
  // на графике вместо сайдбара — рейка (план 2B.9): «Выйти» в развёрнутом меню
  await page.getByRole("button", { name: "развернуть меню" }).click();
  await page.getByRole("dialog", { name: "меню" }).getByRole("button", { name: "Выйти" }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("вход по ссылке из письма (magic link)", async ({ page }) => {
  const calls: string[] = [];
  await mockApi(page, calls);
  await page.goto("/magic?token=bad");
  await expect(page.getByRole("status")).toContainText("недействительна");
  await page.goto("/magic?token=good");
  await expect(page).toHaveURL(/\/chart(\/|$)/);
  expect(calls.filter((c) => c === "POST /v1/auth/magic/consume")).toHaveLength(2);
});

test("вход через Google (callback)", async ({ page }) => {
  const calls: string[] = [];
  await mockApi(page, calls);
  await page.goto("/auth/google?code=abc&state=%2Fonboarding");
  await expect(page).toHaveURL(/\/onboarding$/);
  expect(calls).toContain("POST /v1/auth/google");
});

test("регистрация и онбординг", async ({ page }) => {
  const calls: string[] = [];
  await mockApi(page, calls);
  await page.goto("/register");
  await page.getByLabel("Email").fill("new@example.com");
  await page.getByLabel("Пароль").fill("long-enough-password");
  await page.getByLabel("Страна").selectOption("DE");
  await page.getByLabel(/Я принимаю условия/).check();
  await page.getByRole("button", { name: "Создать аккаунт" }).click();
  // после регистрации — сразу на график (ADR-0006); онбординг доступен по ссылке
  await expect(page).toHaveURL(/\/chart(\/|$)/);
  expect(calls).toContain("POST /v1/auth/register");
  await page.goto("/onboarding");
  // шаг 1 — опыт
  await page.getByLabel("Торгую давно").check();
  await page.getByRole("button", { name: "Дальше" }).click();
  // шаг 2 — риск
  await page.getByLabel("Риск на сделку, %").fill("0.5");
  await page.getByRole("button", { name: "Дальше" }).click();
  // шаг 3 — уведомления
  await expect(page.getByText("Email-дайджест")).toBeVisible();
  await page.getByRole("button", { name: "Открыть график" }).click();
  await expect(page).toHaveURL(/\/chart(\/|$)/);
  expect(calls.filter((c) => c === "PATCH /v1/me/risk")).toHaveLength(2);
});

test("вход с 2FA: второй шаг с кодом из приложения", async ({ page }) => {
  const calls: string[] = [];
  await mockApi(page, calls);
  await page.goto("/login");
  await page.getByLabel("Email").fill("2fa@example.com");
  await page.getByLabel("Пароль").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  const form = page.getByRole("form", { name: "код двухфакторной защиты" });
  await expect(form).toBeVisible();
  await form.getByLabel("Код из приложения").fill("000000");
  await form.getByRole("button", { name: "Подтвердить" }).click();
  await expect(form.getByRole("alert")).toContainText("неверный код");
  await form.getByLabel("Код из приложения").fill("123456");
  await form.getByRole("button", { name: "Подтвердить" }).click();
  await expect(page).toHaveURL(/\/chart(\/|$)/);
  expect(calls).toContain("POST /v1/auth/login/2fa");
});

test("аккаунт заблокирован во время сеанса: обновление токена — 401, сайт тихо становится гостем; вход — понятный отказ", async ({ page }) => {
  const BLOCKED = "Аккаунт заблокирован. Напишите в поддержку.";
  const calls: string[] = [];
  let blocked = false;
  await blockBinance(page.context());
  await page.route("**/v1/**", async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const bearer = req.headers()["authorization"];
    calls.push(`${req.method()} ${p}${bearer ? " bearer" : ""}`);
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    // сервер: вход и обновление заблокированного — отказ; его access-токен истёк
    if (p === "/v1/auth/login") return blocked ? json(403, { detail: BLOCKED }) : json(200, TOKEN);
    if (p === "/v1/auth/refresh") return blocked ? json(401, { detail: BLOCKED }) : json(200, TOKEN);
    if (blocked && bearer) return json(401, { detail: "недействительный токен" });
    if (p === "/v1/auth/me") return bearer ? json(200, ME) : json(401, { detail: "нужен токен" });
    if (p === "/v1/signals/summary") return json(200, { active: 0, today_new: 0, next_h4_close: new Date(Date.now() + 3600e3).toISOString(), now: "", scope: "live" });
    if (p === "/v1/signals") return json(200, { items: [CLOSED_ROW], sparklines: {}, prices: {}, total: 1, scope: "live", limit: 50, offset: 0, restrictions: null });
    return json(404, { detail: "нет заглушки" });
  });
  await page.goto("/login");
  await page.getByLabel("Email").fill("trader@example.com");
  await page.getByLabel("Пароль").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).toHaveURL(/\/chart(\/|$)/);
  await page.goto("/signals");
  await expect(page.getByTitle("trader@example.com")).toBeVisible();

  // админ заблокировал аккаунт; токен истёк — следующий запрос ленты: 401 → refresh 401 → гость
  blocked = true;
  await page.getByRole("button", { name: "сортировать по: Инструмент" }).click();
  await expect.poll(() => calls.filter((c) => c === "POST /v1/auth/refresh").length).toBeGreaterThan(1);
  await expect(page.getByTitle("trader@example.com")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Войти" }).first()).toBeVisible();
  // тихо: лента на месте (ответ гостя), без текста ошибки на странице
  await expect(page.getByText("1 сигналов")).toBeVisible();
  await expect(page.getByText(/недействительный токен|заблокирован/)).toHaveCount(0);
  expect((await page.context().cookies()).some((c) => c.name === "pl_auth" && c.value === "1")).toBe(false);

  // попытка войти снова — понятный отказ, без перехода
  await page.goto("/login");
  await page.getByLabel("Email").fill("trader@example.com");
  await page.getByLabel("Пароль").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.locator("form").getByRole("alert")).toHaveText(BLOCKED);
  await expect(page).toHaveURL(/\/login$/);
});

test("язык: переключатель EN переводит шапку и форму входа, cookie сохраняется", async ({ page }) => {
  const calls: string[] = [];
  await mockApi(page, calls);
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Войти", exact: true })).toBeVisible();
  await page.getByRole("group", { name: "язык" }).getByRole("button", { name: "EN" }).click();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "sections" }).getByRole("link", { name: "Subscription" })).toBeVisible();
  const cookies = await page.context().cookies();
  expect(cookies.find((c) => c.name === "pl_locale")?.value).toBe("en");
});
