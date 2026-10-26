import { expect, test, type Page } from "@playwright/test";

/** Тарифы и оплата (план 3.13): выбор срока, расчёт с промокодом, оформление, история, сверка. */

const ME = { id: 7, email: "trader@example.com", name: "Al", email_verified: true, role: "user", locale: "ru", timezone: "UTC", theme: "system", risk: {} };
const PLANS = {
  plans: [
    { code: "pro", title: "Pro", prices: { "1": "29.00", "3": "78.30", "12": "249.00" }, price_month: "29.00", price_year: "249.00" },
    { code: "premium", title: "Premium", prices: { "1": "79.00", "3": "213.30", "12": "690.00" }, price_month: "79.00", price_year: "690.00" },
  ],
  billing_enabled: true,
};
const PAYMENT = {
  id: "pay_abc123", plan: "pro", months: 12, price_usd: "249.00", discount_usd: "49.80", balance_applied_usd: "0.00", amount_due_usd: "199.20", promo_code: "WELCOME20",
  provider: "nowpayments", status: "pending", invoice_url: "https://nowpayments.io/payment/?iid=1", pay_currency: null, actually_paid: null, actually_paid_usd: null, tx_hash: null,
  expires_at: null, paid_at: null, created_at: "2026-10-26T10:00:00Z",
};

async function mock(page: Page, calls: string[], state: { payments: Record<string, unknown>[]; enabled: boolean }) {
  await page.context().addCookies([{ name: "pl_auth", value: "1", url: "http://localhost:3101" }]);
  await page.route("**/v1/**", (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    calls.push(`${req.method()} ${p}`);
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (p === "/v1/auth/refresh") return json(200, { access_token: "t" });
    if (p === "/v1/auth/me") return json(200, ME);
    if (p === "/v1/billing/plans") return json(200, { ...PLANS, billing_enabled: state.enabled });
    if (p === "/v1/billing/me") return json(200, { plan: "free", billing_enabled: state.enabled, balance_usd: "0.00", subscription: null });
    if (p === "/v1/billing/quote") {
      const b = req.postDataJSON() as { plan: string; months: number; promo_code: string | null };
      if (b.promo_code && b.promo_code !== "WELCOME20") return json(400, { detail: "промокод не найден" });
      const price = (PLANS.plans.find((x) => x.code === b.plan)!.prices as Record<string, string>)[String(b.months)];
      const discount = b.promo_code ? (Number(price) * 0.2).toFixed(2) : "0.00";
      return json(200, { plan: b.plan, months: b.months, price, discount, balance_applied: "0.00", amount_due: (Number(price) - Number(discount)).toFixed(2), promo_code: b.promo_code });
    }
    if (p === "/v1/billing/checkout") {
      if (!state.enabled) return json(503, { detail: "оплата ещё не включена" });
      state.payments.unshift(PAYMENT);
      return json(201, { payment: PAYMENT, paid_from_balance: false });
    }
    if (p === "/v1/billing/payments") return json(200, state.payments);
    if (p === "/v1/billing/payments/pay_abc123/refresh") {
      state.payments[0] = { ...PAYMENT, status: "paid", actually_paid: "199.5", pay_currency: "usdttrc20", tx_hash: "0xabcdef1234567890", paid_at: "2026-10-26T10:20:00Z" };
      return json(200, state.payments[0]);
    }
    return json(404, { detail: "нет заглушки" });
  });
}

test("тарифы: срок, промокод, переход к оплате", async ({ page }) => {
  const calls: string[] = [];
  const state = { payments: [] as Record<string, unknown>[], enabled: true };
  await mock(page, calls, state);
  await page.goto("/pricing");
  await expect(page.getByRole("heading", { name: "Тарифы" })).toBeVisible();
  await expect(page.getByText("249.00")).toBeVisible();
  await page.getByRole("button", { name: "1 месяц" }).click();
  await expect(page.getByText("29.00")).toBeVisible();
  await page.getByRole("button", { name: "12 месяцев" }).click();
  await page.getByRole("button", { name: "Выбрать Pro" }).click();
  await expect(page.getByText(/^К оплате/)).toBeVisible();
  await expect(page.getByText("249.00 USD").first()).toBeVisible();
  await page.getByLabel("Промокод").fill("nope");
  await page.getByRole("button", { name: "Применить" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "промокод" })).toContainText("промокод не найден");
  await page.getByLabel("Промокод").fill("welcome20");
  await page.getByRole("button", { name: "Применить" }).click();
  await expect(page.getByText("−49.80 USD")).toBeVisible();
  await expect(page.getByText("199.20 USD")).toBeVisible();
  // переход к оплате уводит на страницу провайдера — перехватываем навигацию
  await page.route("https://nowpayments.io/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<title>provider</title>ok" }));
  await page.getByRole("button", { name: "Перейти к оплате" }).click();
  await expect(page).toHaveURL(/nowpayments\.io/);
  expect(calls).toContain("POST /v1/billing/checkout");
});

test("тарифы: оплата выключена — кнопки заблокированы", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls, { payments: [], enabled: false });
  await page.goto("/pricing");
  await expect(page.getByText("Оплата пока не включена")).toBeVisible();
  await expect(page.getByRole("button", { name: "Выбрать Pro" })).toBeDisabled();
});

test("биллинг: история и ручная сверка", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls, { payments: [PAYMENT], enabled: true });
  await page.goto("/billing?paid=pay_abc123");
  await expect(page.getByRole("status").filter({ hasText: "обрабатывается" })).toBeVisible();
  await expect(page.getByText("Текущий тариф")).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: "pay_abc123" });
  await expect(row).toContainText("ожидает оплаты");
  await page.getByLabel("проверить оплату pay_abc123").click();
  await expect(row).toContainText("оплачен");
  await expect(row).toContainText("199.5 usdttrc20");
  await expect(row).toContainText("0xabcdef12");
  expect(calls).toContain("POST /v1/billing/payments/pay_abc123/refresh");
});
