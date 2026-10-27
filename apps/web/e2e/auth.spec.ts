import { expect, test, type Page } from "@playwright/test";

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

async function mockApi(page: Page, calls: string[]) {
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
  for (const path of ["/billing", "/admin", "/journal", "/watchlist", "/alerts", "/screener", "/calculator", "/settings"]) {
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent(path).replace(/\//g, "%2F")}`));
  }
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
  await expect(page).toHaveURL(/\/signals$/);
  await expect(page.getByTitle("trader@example.com")).toBeVisible();
  expect(calls).toContain("POST /v1/auth/login");
  await page.getByRole("button", { name: "Выйти" }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("вход по ссылке из письма (magic link)", async ({ page }) => {
  const calls: string[] = [];
  await mockApi(page, calls);
  await page.goto("/magic?token=bad");
  await expect(page.getByRole("status")).toContainText("недействительна");
  await page.goto("/magic?token=good");
  await expect(page).toHaveURL(/\/signals$/);
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
  await expect(page).toHaveURL(/\/onboarding$/);
  expect(calls).toContain("POST /v1/auth/register");
  // шаг 1 — опыт
  await page.getByLabel("Торгую давно").check();
  await page.getByRole("button", { name: "Дальше" }).click();
  // шаг 2 — риск
  await page.getByLabel("Риск на сделку, %").fill("0.5");
  await page.getByRole("button", { name: "Дальше" }).click();
  // шаг 3 — уведомления
  await expect(page.getByText("Email-дайджест")).toBeVisible();
  await page.getByRole("button", { name: "Перейти к сигналам" }).click();
  await expect(page).toHaveURL(/\/signals$/);
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
  await expect(page).toHaveURL(/\/signals$/);
  expect(calls).toContain("POST /v1/auth/login/2fa");
});
