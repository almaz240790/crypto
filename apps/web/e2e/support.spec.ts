import { expect, test } from "@playwright/test";

/** Поддержка (план 3.16): форма без входа, автоприкрепление страницы, FAQ. */

test("поддержка: обращение без входа с автоприкреплением", async ({ page }) => {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  await page.route("**/v1/**", (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (p === "/v1/support/tickets" && req.method() === "POST") {
      const body = req.postDataJSON() as Record<string, unknown>;
      calls.push({ path: p, body });
      return json(201, { id: 12, user_id: null, email: body.email, subject: body.subject, message: body.message, context: { page: body.page, version: body.version }, status: "open", reply: null, replied_at: null, created_at: "2026-10-26T10:00:00Z" });
    }
    return json(404, { detail: "нет заглушки" });
  });
  await page.goto("/support?page=/signals/abc");
  await expect(page.getByRole("heading", { name: "Поддержка" })).toBeVisible();
  await expect(page.getByText("Почему вы не обещаете доходность?")).toBeVisible();
  await page.getByLabel("Email для ответа").fill("guest@example.com");
  await page.getByLabel("Тема").fill("Не вижу сигнал");
  await page.getByLabel("Сообщение").fill("Открыл карточку сигнала, а там пусто.");
  await expect(page.getByLabel("Страница (прикрепляется сама)")).toHaveValue("/signals/abc");
  await page.getByRole("button", { name: "Отправить" }).click();
  await expect(page.getByRole("status")).toContainText("Обращение #12 принято");
  expect(calls[0].body).toMatchObject({ email: "guest@example.com", subject: "Не вижу сигнал", page: "/signals/abc" });
  expect(typeof calls[0].body.version).toBe("string");
});
