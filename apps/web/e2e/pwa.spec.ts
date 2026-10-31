import { expect, test } from "@playwright/test";

/** PWA (план 2.15): манифест, service worker, офлайн-страница, управление push в настройках. */

test("манифест и service worker отдаются, офлайн-страница есть", async ({ page, request }) => {
  const m = await request.get("/manifest.webmanifest");
  expect(m.ok()).toBe(true);
  const j = (await m.json()) as { name: string; display: string; icons: { src: string }[]; start_url: string };
  expect(j.display).toBe("standalone");
  expect(j.start_url).toBe("/chart");
  expect(j.icons.some((i) => i.src.includes("maskable"))).toBe(true);
  for (const i of j.icons) expect((await request.get(i.src)).ok()).toBe(true);
  const sw = await request.get("/sw.js");
  expect(sw.ok()).toBe(true);
  expect(await sw.text()).toContain("addEventListener(\"push\"");
  await page.goto("/offline");
  await expect(page.getByText("Нет соединения")).toBeVisible();
  await page.goto("/");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", /manifest/);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);
});

test("настройки: кнопки push и тестовый push", async ({ page }) => {
  await page.context().addCookies([{ name: "pl_auth", value: "1", url: "http://localhost:3101" }]);
  await page.route("**/v1/**", (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (p === "/v1/auth/refresh") return json(200, { access_token: "t" });
    if (p === "/v1/auth/me") return json(200, { id: 1, email: "a@b.c", name: null, email_verified: true, role: "user", locale: "ru", timezone: "UTC", theme: "system", risk: {} });
    if (p === "/v1/me/identities") return json(200, []);
    if (p === "/v1/me/notifications") return json(200, { email_digest: "daily", email_signals: false, email_events: false, grades: ["A", "B", "C"], scope: "all", quiet_from: null, quiet_to: null, daily_limit: 20, push_signals: true, push_events: true, telegram_linked: false });
    return json(404, { detail: "нет" });
  });
  await page.goto("/settings");
  await expect(page.getByLabel("Push о сигналах")).toHaveValue("on");
  // в headless-браузере PushManager есть; подписка не создаётся → кнопка «Включить push здесь»
  await expect(page.getByRole("button", { name: /push здесь/ })).toBeVisible();
});
