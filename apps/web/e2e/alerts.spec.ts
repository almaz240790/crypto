import { expect, test, type Page } from "@playwright/test";

/** Экран алертов (план 2A.6, 2B.13): создание, пауза, удаление, журнал. API — перехват в браузере. */

const ME = { id: 7, email: "trader@example.com", name: "Al", email_verified: true, role: "user", locale: "ru", timezone: "UTC", theme: "system", risk: {} };

async function mock(page: Page, state: { alerts: Record<string, unknown>[]; triggers: Record<string, unknown>[] }, calls: string[]) {
  await page.context().addCookies([{ name: "pl_auth", value: "1", url: "http://localhost:3101" }]);
  await page.route("**/v1/**", (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    calls.push(`${req.method()} ${p}`);
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (p === "/v1/auth/refresh") return json(200, { access_token: "t" });
    if (p === "/v1/auth/me") return json(200, ME);
    if (p === "/v1/instruments") return json(200, [{ id: 1, symbol: "BTCUSDT", base: "BTC", quote: "USDT", tick_size: "0.1", lot_size: "0.001" }]);
    if (p === "/v1/alerts/triggers") return json(200, { items: state.triggers });
    if (p === "/v1/alerts" && req.method() === "GET") return json(200, { items: [...state.alerts].reverse(), active: state.alerts.filter((a) => a.status === "active").length, limit: 3, types: [], frequencies: [] });
    if (p === "/v1/alerts" && req.method() === "POST") {
      const b = req.postDataJSON() as Record<string, unknown>;
      if (state.alerts.filter((a) => a.status === "active").length >= 3) return json(403, { detail: "лимит активных алертов: 3 (тариф free)" });
      const cond = b.condition as Record<string, unknown>;
      const text = b.type === "indicator" ? `BTCUSDT H4: RSI(14) выше ${cond.value}` : `BTCUSDT: цена пересекла ${cond.price} вверх`;
      const a = { id: state.alerts.length + 1, symbol: b.symbol, timeframe: b.timeframe, type: b.type, condition: cond, text, frequency: b.frequency, expires_at: null, status: "active", drawing_client_id: null, note: b.note, last_triggered_at: null, triggers_count: 0, created_at: null, last_trigger: null };
      state.alerts.push(a);
      return json(201, a);
    }
    const m = p.match(/^\/v1\/alerts\/(\d+)$/);
    if (m && req.method() === "PATCH") {
      const a = state.alerts.find((x) => x.id === Number(m[1]))!;
      Object.assign(a, req.postDataJSON() as Record<string, unknown>);
      return json(200, a);
    }
    if (m && req.method() === "DELETE") {
      state.alerts = state.alerts.filter((x) => x.id !== Number(m[1]));
      return route.fulfill({ status: 204, body: "" });
    }
    return json(404, { detail: "нет заглушки" });
  });
}

test("алерты: создать по цене и по индикатору, пауза, удаление, лимит тарифа, журнал", async ({ page }) => {
  const state = {
    alerts: [] as Record<string, unknown>[],
    triggers: [{ id: 9, alert_id: 1, triggered_at: "2026-10-27T10:05:00+00:00", price: "65000", details: {}, notified: true, alert: { id: 1, symbol: "BTCUSDT", text: "BTCUSDT: цена пересекла 65000 вверх", type: "price", status: "triggered", frequency: "once", condition: {}, timeframe: null } }],
  };
  const calls: string[] = [];
  await mock(page, state, calls);
  await page.goto("/alerts");
  await expect(page.getByRole("heading", { name: "Мои алерты" })).toBeVisible();
  await expect(page.getByText("Алертов пока нет")).toBeVisible();
  await expect(page.getByText("65000 вверх")).toBeVisible(); // журнал
  const form = page.getByRole("form", { name: "новый алерт" });
  await form.getByLabel("цена").fill("70000");
  await form.getByRole("button", { name: "Создать алерт" }).click();
  await expect(page.getByRole("status")).toContainText("Алерт создан");
  await expect(page.getByTestId("alert-row")).toHaveCount(1);
  expect(calls).toContain("POST /v1/alerts");
  // индикатор
  await form.getByLabel("тип алерта").selectOption("indicator");
  await form.getByLabel("таймфрейм алерта").selectOption("4h");
  await form.getByLabel("порог").fill("70");
  await form.getByRole("button", { name: "Создать алерт" }).click();
  await expect(page.getByTestId("alert-row")).toHaveCount(2);
  await expect(page.getByTestId("alert-row").nth(0)).toContainText("RSI(14) выше 70");
  // пауза
  await page.getByRole("button", { name: /пауза BTCUSDT H4/ }).click();
  await expect(page.getByTestId("alert-row").nth(0)).toContainText("на паузе");
  // лимит: ещё два — третий активный упирается в лимит
  await form.getByLabel("тип алерта").selectOption("price");
  await form.getByLabel("цена").fill("71000");
  await form.getByRole("button", { name: "Создать алерт" }).click();
  await expect(page.getByRole("status")).toContainText("71000");
  await form.getByLabel("цена").fill("72000");
  await form.getByRole("button", { name: "Создать алерт" }).click();
  await expect(page.getByRole("status")).toContainText("72000");
  await expect(page.getByTestId("alert-row")).toHaveCount(4);
  await form.getByLabel("цена").fill("73000");
  await form.getByRole("button", { name: "Создать алерт" }).click();
  await expect(page.getByRole("status")).toContainText("лимит активных алертов: 3");
  // удаление
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: /удалить BTCUSDT: цена пересекла 70000/ }).click();
  await expect(page.getByTestId("alert-row")).toHaveCount(3);
});
