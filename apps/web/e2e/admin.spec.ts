import { expect, test, type Page } from "@playwright/test";

/** Админка (план 3.15): заявка на смену статуса и четырёхглазое подтверждение, отмена сигнала, аудит. */

const OWNER = { id: 1, email: "owner@example.com", name: null, email_verified: true, role: "owner", locale: "ru", timezone: "UTC", theme: "system", risk: {} };
const VERSIONS = [
  { id: 1, strategy: "trend-ob-retest", name: "Trend OB retest", version: "1.0.0", status: "forward", params: { a: 1 }, created_by: null, approved_by: null, activated_at: null, signals: 3 },
  { id: 2, strategy: "trend-ob-retest", name: "Trend OB retest", version: "1.1.0", status: "forward", params: { a: 2 }, created_by: null, approved_by: null, activated_at: null, signals: 1 },
];

async function mock(page: Page, calls: string[]) {
  await page.context().addCookies([{ name: "pl_auth", value: "1", url: "http://localhost:3101" }]);
  const state = { requests: [] as Record<string, unknown>[], audit: [] as Record<string, unknown>[], versions: VERSIONS.map((v) => ({ ...v })) };
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
