import { expect, test, type Page } from "@playwright/test";

/** Админка (план 3.15): заявка на смену статуса и четырёхглазое подтверждение, отмена сигнала, аудит. */

const OWNER = { id: 1, email: "owner@example.com", name: null, email_verified: true, role: "owner", locale: "ru", timezone: "UTC", theme: "system", risk: {} };
const VERSIONS = [
  { id: 1, strategy: "trend-ob-retest", name: "Trend OB retest", version: "1.0.0", status: "forward", params: { a: 1 }, created_by: null, approved_by: null, activated_at: null, signals: 3 },
  { id: 2, strategy: "trend-ob-retest", name: "Trend OB retest", version: "1.1.0", status: "forward", params: { a: 2 }, created_by: null, approved_by: null, activated_at: null, signals: 1 },
];

async function mock(page: Page, calls: string[]) {
  await page.context().addCookies([{ name: "pl_auth", value: "1", url: "http://localhost:3101" }]);
  const state = { requests: [] as Record<string, unknown>[], audit: [] as Record<string, unknown>[], versions: VERSIONS.map((v) => ({ ...v })), promos: [] as Record<string, unknown>[], users: <Record<string, unknown>[]>[{ id: 1, email: OWNER.email, name: null, role: "owner", country: "RU", verified: true, created_at: "2026-10-25T10:00:00Z", blocked_at: null, blocked_reason: null, deleted: false, plan: "pro", plan_until: "2026-11-01T10:00:00Z", plan_status: "trialing" }, { id: 2, email: "beta@example.com", name: "Beta", role: "user", country: null, verified: true, created_at: "2026-10-26T10:00:00Z", blocked_at: null, blocked_reason: null, deleted: false, plan: "free", plan_until: null, plan_status: null }] };
  await page.route("**/v1/**", (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    calls.push(`${req.method()} ${p}`);
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (p === "/v1/auth/refresh") return json(200, { access_token: "t" });
    if (p === "/v1/auth/me") return json(200, OWNER);
    if (p === "/v1/admin/strategies") return json(200, { versions: state.versions, runs: [], requests: state.requests, me: { id: 1, role: "owner" } });
    if (p === "/v1/admin/strategies/status-requests" && req.method() === "POST") {
      const b = req.postDataJSON() as { strategy_version_id: number; to_status: string; reason: string };
      const v = state.versions.find((x) => x.id === b.strategy_version_id)!;
      state.requests.unshift({ id: state.requests.length + 1, strategy_version_id: v.id, from_status: v.status, to_status: b.to_status, reason: b.reason, requested_by: OWNER.email, requested_by_id: 1, decision: "pending", decision_note: null, created_at: null, decided_at: null });
      state.audit.unshift({ id: 1, actor: OWNER.email, action: "status_request.create", target: `strategy_version:${v.id}`, payload: { to: b.to_status }, at: new Date().toISOString() });
      return json(201, { id: 1, decision: "pending" });
    }
    const m = p.match(/^\/v1\/admin\/strategies\/status-requests\/(\d+)\/decide$/);
    if (m) {
      const b = req.postDataJSON() as { approve: boolean; note: string | null };
      const r = state.requests.find((x) => x.id === Number(m[1]))!;
      if (b.approve && (!b.note || b.note.length < 20)) return json(403, { detail: "заявку подтверждает другой админ (владелец — с обоснованием от 20 символов)" });
      r.decision = b.approve ? "applied" : "rejected";
      r.decision_note = b.note;
      if (b.approve) state.versions.find((x) => x.id === r.strategy_version_id)!.status = String(r.to_status);
      state.audit.unshift({ id: 2, actor: OWNER.email, action: "version.status", target: `strategy_version:${r.strategy_version_id}`, payload: { to: r.to_status, mode: "owner-override" }, at: new Date().toISOString() });
      return json(200, { id: r.id, decision: r.decision });
    }
    if (p === "/v1/admin/signals") return json(200, [{ id: "s1", symbol: "BTCUSDT", version: "1.1.0", scope: "forward", direction: "long", grade: "A", score: 80, status: "active", candle_close_time: "2026-10-25T08:00:00Z", entry: "100", stop: "98", flags: ["weekend"], facts: ["BOS up"], input_hash: "abc" }]);
    if (p === "/v1/admin/signals/s1/cancel") return json(200, { id: "s1", status: "cancelled" });
    if (p === "/v1/admin/audit") return json(200, state.audit);
    if (p === "/v1/admin/users" && req.method() === "GET") return json(200, state.users);
    if (p === "/v1/admin/users/2/subscription") {
      const b = req.postDataJSON() as { plan: string; months: number; reason: string };
      state.users[1] = { ...state.users[1], plan: b.plan, plan_until: "2026-11-26T10:00:00Z", plan_status: "active" };
      return json(201, { plan: b.plan, current_period_end: "2026-11-26T10:00:00Z" });
    }
    if (p === "/v1/admin/promo" && req.method() === "GET") return json(200, state.promos);
    if (p === "/v1/admin/promo" && req.method() === "POST") {
      const b = req.postDataJSON() as Record<string, unknown>;
      const row = { id: state.promos.length + 1, code: b.code, percent: b.percent, fixed_usd: b.fixed_usd, plan: b.plan, max_uses: b.max_uses, used: 0, expires_at: b.expires_at, active: true, created_at: "2026-10-26T10:00:00Z" };
      state.promos.unshift(row);
      return json(201, row);
    }
    const pm = p.match(/^\/v1\/admin\/promo\/(\d+)$/);
    if (pm && req.method() === "PATCH") {
      const row = state.promos.find((x) => x.id === Number(pm[1]))!;
      row.active = u.searchParams.get("active") === "true";
      return json(200, row);
    }
    return json(404, { detail: "нет заглушки" });
  });
}

test("админка: заявка, отказ без обоснования, подтверждение владельцем, аудит", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls);
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Админка" })).toBeVisible();
  await page.getByLabel("Версия").selectOption("2");
  await page.getByLabel("Новый статус").selectOption("live");
  await page.getByLabel("Обоснование").fill("форвард 3 месяца, PF 1.5, отчёт в docs");
  await page.getByRole("button", { name: "Создать заявку" }).click();
  await expect(page.getByRole("status")).toContainText("Заявка создана");
  await expect(page.getByText("forward → live").first()).toBeVisible();
  // владелец без обоснования — отказ
  await page.getByRole("button", { name: "Подтвердить" }).click();
  await expect(page.getByRole("status")).toContainText("другой админ");
  await page.getByLabel("заметка к заявке 1").fill("в команде один админ, беру ответственность, форвард пройден");
  await page.getByRole("button", { name: "Подтвердить" }).click();
  await expect(page.getByRole("status")).toContainText("статус применён");
  await expect(page.getByText("applied")).toBeVisible();
  await page.getByRole("tab", { name: "Аудит" }).click();
  await expect(page.getByText("version.status")).toBeVisible();
  await expect(page.getByText(/owner-override/)).toBeVisible();
});

test("админка: отмена сигнала с публичной причиной", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls);
  await page.goto("/admin?tab=signals");
  await page.getByLabel("причина отмены s1").fill("ошибка данных биржи, свеча пересчитана");
  await page.getByRole("button", { name: "Отменить" }).click();
  await expect(page.getByRole("status")).toContainText("Сигнал отменён");
  expect(calls).toContain("POST /v1/admin/signals/s1/cancel");
});

test("админка: промокод и ручная выдача тарифа", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls);
  await page.goto("/admin?tab=billing");
  await page.getByLabel("Код").fill("welcome20");
  await page.getByLabel("Скидка, %").fill("20");
  await page.getByLabel("Макс. использований").fill("100");
  await page.getByRole("button", { name: "Создать промокод" }).click();
  await expect(page.getByRole("status")).toContainText("Промокод создан");
  const row = page.getByRole("row").filter({ hasText: "WELCOME20" });
  await expect(row).toContainText("20 %");
  await expect(row).toContainText("0 / 100");
  await page.getByLabel("выключить WELCOME20").click();
  await expect(row).toContainText("выключен");
  // выдача тарифа
  await page.getByRole("tab", { name: "Пользователи" }).click();
  const beta = page.getByRole("row").filter({ hasText: "beta@example.com" });
  await expect(beta).toContainText("free");
  page.on("dialog", (d) => {
    const m = d.message();
    void d.accept(m.startsWith("Тариф") ? "premium" : m.startsWith("Срок") ? "3" : "бета-тестер, компенсация");
  });
  await page.getByLabel("выдать тариф beta@example.com").click();
  await expect(page.getByRole("status")).toContainText("Тариф выдан");
  await expect(beta).toContainText("premium");
  expect(calls).toContain("POST /v1/admin/users/2/subscription");
});
