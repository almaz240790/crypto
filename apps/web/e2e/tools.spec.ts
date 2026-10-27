import { expect, test, type Page } from "@playwright/test";

/** Инструменты 2.12: калькулятор, вотчлист, журнал, скринер, настройки. API — перехват в браузере. */

const ME = {
  id: 7, email: "trader@example.com", name: "Al", email_verified: true, role: "user", locale: "ru", timezone: "UTC", theme: "system",
  risk: { deposit: "10000", risk_pct: "1.00", exchange: "binance", market_type: "futures", default_leverage: 3, experience: null },
};
const INSTR = [{ id: 1, symbol: "BTCUSDT", base: "BTC", quote: "USDT", tick_size: "0.1", lot_size: "0.001" }, { id: 2, symbol: "ETHUSDT", base: "ETH", quote: "USDT", tick_size: "0.01", lot_size: "0.01" }];
const SCREEN = (sym: string, zoneAtr: string | null) => ({
  symbol: sym, instrument_id: sym === "BTCUSDT" ? 1 : 2, exchange: "binance", price: sym === "BTCUSDT" ? "65000" : "2600", change_24h: sym === "BTCUSDT" ? "1.5" : "-0.8", volume_24h: "1500000000",
  bias: sym === "BTCUSDT" ? "long" : "neutral", d1_trend: "up", w1_trend: sym === "BTCUSDT" ? "up" : "flat",
  last_event: { type: "bos", direction: "up", time: "2026-10-24T16:00:00Z", level: "64000" },
  zone: zoneAtr === null ? null : { kind: "ob", direction: "up", top: "64500", bottom: "64000", status: "active", distance_atr: zoneAtr, distance_pct: "1" },
  atr_pct: "1.2", atr_percentile: "48", beta_btc: sym === "BTCUSDT" ? "1" : "1.3", funding: "0.01", funding_pct: "55", oi_change_24h: "2.1", liq_long_24h: "1200000", liq_short_24h: "800000",
});

async function mock(page: Page, calls: string[], state: { watch: string[]; journal: Record<string, unknown>[]; twoFactor?: boolean; screens?: Record<string, unknown>[]; alerts?: Record<string, unknown>[]; apiKeys?: { id: number; name: string; prefix: string; created_at: string; last_used_at: string | null }[] }) {
  state.screens ??= [];
  state.alerts ??= [];
  await page.context().addCookies([{ name: "pl_auth", value: "1", url: "http://localhost:3101" }]);
  await page.route("**/v1/**", (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    calls.push(`${req.method()} ${p}`);
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (p === "/v1/auth/refresh") return json(200, { access_token: "t" });
    if (p === "/v1/auth/me") return json(200, ME);
    if (p === "/v1/instruments") return json(200, INSTR);
    if (p === "/v1/screener/screens" && req.method() === "GET") return json(200, state.screens);
    if (p === "/v1/screener/screens" && req.method() === "PUT") {
      const b = req.postDataJSON() as { name: string; filters: Record<string, string> };
      state.screens = [...state.screens!.filter((x) => x.name !== b.name), { name: b.name, filters: b.filters, created_at: "" }];
      return json(200, state.screens[state.screens.length - 1]);
    }
    if (p === "/v1/screener/screens" && req.method() === "DELETE") {
      state.screens = state.screens!.filter((x) => x.name !== u.searchParams.get("name"));
      return route.fulfill({ status: 204 });
    }
    if (p === "/v1/screener/export.csv") return route.fulfill({ status: 200, contentType: "text/csv", headers: { "content-disposition": "attachment; filename=platform-screener.csv" }, body: "symbol,price\nBTCUSDT,65000\n" });
    if (p === "/v1/alerts" && req.method() === "POST") {
      const b = req.postDataJSON() as Record<string, unknown>;
      state.alerts!.push(b);
      return json(201, { id: state.alerts!.length, ...b, status: "active", text: "", triggers_count: 0 });
    }
    if (p === "/v1/screener") {
      const want = u.searchParams.get("symbols")?.split(",");
      const all = [SCREEN("BTCUSDT", "0.4"), SCREEN("ETHUSDT", null)];
      return json(200, { items: want ? all.filter((r) => want.includes(r.symbol)) : all, generated_at: new Date().toISOString(), sparklines: { "1": ["1", "2", "3", "2"], "2": ["3", "2", "1"] } });
    }
    if (p === "/v1/watchlist") return json(200, { id: 1, name: "Основной", items: state.watch.map((s, i) => ({ symbol: s, instrument_id: i + 1, added_at: "" })) });
    if (p === "/v1/watchlist/items" && req.method() === "POST") {
      const b = req.postDataJSON() as { symbol: string };
      if (!state.watch.includes(b.symbol)) state.watch.push(b.symbol);
      return json(201, { symbol: b.symbol });
    }
    if (p.startsWith("/v1/watchlist/items/") && req.method() === "DELETE") {
      state.watch = state.watch.filter((s) => s !== p.split("/").pop());
      return route.fulfill({ status: 204 });
    }
    if (p === "/v1/signals") return json(200, { items: [], sparklines: {}, prices: {}, total: 0, scope: "live", limit: 50, offset: 0 });
    if (p === "/v1/journal/analytics") {
      const b = { trades: state.journal.length, closed: state.journal.length, sum_r: "2", avg_r: "2", winrate: 1 };
      return json(200, {
        total: b,
        by_weekday: [{ key: 0, ...b }],
        by_symbol: [{ key: "BTCUSDT", ...b }],
        by_grade: [{ key: "none", ...b }],
        equity: { points: [{ t: "2026-01-05T20:00:00+00:00", r: "2" }], max_drawdown_r: "0" },
        errors: { early_exit: { count: 0, of: 0 }, no_signal: { count: 1, of: 1 }, risk_exceeded: { count: 0, of: 0, budget_usd: null } },
      });
    }
    if (p === "/v1/journal" && req.method() === "GET") {
      const closed = state.journal.filter((e) => e.realized_r != null);
      return json(200, { items: state.journal, summary: { trades: state.journal.length, closed: closed.length, sum_r: "1.5", avg_r: "0.75", winrate: 0.5, linked: 0, executed_share: null, system_avg_r: null } });
    }
    if (p === "/v1/journal/import") {
      const b = req.postDataJSON() as { api_key: string; api_secret: string; days: number };
      if (b.api_key !== "k".repeat(16)) return json(400, { detail: "Binance 401: Invalid API-key" });
      state.journal.unshift({ id: 42, symbol: "BTCUSDT", direction: "short", entry_price: "66000", entry_at: "2026-10-20T12:00:00Z", stop_loss: null, take_profits: [], size: "0.5", exit_price: "65000", exit_at: "2026-10-21T12:00:00Z", realized_r: null, realized_quote: "498.5", fees: "1.5", tags: ["binance:1", "импорт"], note: "импорт с Binance", source: "import", signal_id: null, created_at: null });
      return json(200, { imported: 1, matched: 0, open: 0, skipped: 0, symbols: 2, fills: 2, days: b.days });
    }
    if (p === "/v1/journal" && req.method() === "POST") {
      const b = req.postDataJSON() as Record<string, unknown>;
      const e = { id: state.journal.length + 1, ...b, take_profits: b.take_profits ?? [], tags: b.tags ?? [], realized_r: b.exit_price ? "2.000" : null, realized_quote: null, source: "manual", signal_id: null, created_at: null, fees: null, size: b.size ?? null };
      state.journal.unshift(e);
      return json(201, e);
    }
    if (p.startsWith("/v1/journal/") && req.method() === "DELETE") {
      state.journal = state.journal.filter((e) => String(e.id) !== p.split("/").pop());
      return route.fulfill({ status: 204 });
    }
    if (p === "/v1/me/identities") return json(200, [{ provider: "password", label: ME.email, connected_at: null }]);
    if (p === "/v1/me/api-keys" && req.method() === "GET") return json(200, { items: state.apiKeys ?? [], limit: 5 });
    if (p === "/v1/me/api-keys" && req.method() === "POST") {
      const b = req.postDataJSON() as { name: string };
      const k = { id: (state.apiKeys?.length ?? 0) + 1, name: b.name, prefix: "pk_abc1234", created_at: "2026-10-27T10:00:00Z", last_used_at: null };
      state.apiKeys = [...(state.apiKeys ?? []), k];
      return json(201, { ...k, key: "pk_abc1234SECRETSECRETSECRETSECRET" });
    }
    if (p.startsWith("/v1/me/api-keys/") && req.method() === "DELETE") {
      state.apiKeys = (state.apiKeys ?? []).filter((k) => String(k.id) !== p.split("/").pop());
      return route.fulfill({ status: 204 });
    }
    if (p === "/v1/me/2fa") return json(200, { enabled: state.twoFactor ?? false, backup_codes_left: state.twoFactor ? 10 : 0 });
    if (p === "/v1/me/2fa/setup") return json(200, { secret: "JBSWY3DPEHPK3PXP", otpauth_url: "otpauth://totp/Platform:trader%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Platform" });
    if (p === "/v1/me/2fa/enable") {
      const b = req.postDataJSON() as { code: string };
      if (b.code !== "123456") return json(400, { detail: "неверный код" });
      state.twoFactor = true;
      return json(200, { enabled: true, backup_codes: ["AAAA-1", "BBBB-2"] });
    }
    if (p === "/v1/me/2fa/disable") {
      state.twoFactor = false;
      return route.fulfill({ status: 204 });
    }
    if (p === "/v1/me" && req.method() === "PATCH") return json(200, { ...ME, ...(req.postDataJSON() as object) });
    if (p === "/v1/me/risk" && req.method() === "PATCH") return json(200, { ...ME, risk: { ...ME.risk, ...(req.postDataJSON() as object) } });
    return json(404, { detail: "нет заглушки" });
  });
}

test("калькулятор: размер по риску и округление к lot size", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls, { watch: [], journal: [] });
  await page.goto("/calculator");
  await page.getByLabel("Вход").fill("100");
  await page.getByLabel("Стоп").fill("98");
  await page.getByLabel("TP2").fill("105");
  // депозит 10000 и риск 1 % — из профиля: 100 / 2 = 50 BTC
  await expect(page.getByTestId("calc-size")).toContainText("50 BTC");
  await expect(page.getByText("R:R до TP2")).toBeVisible();
  await page.getByLabel("Риск, %").fill("0.33");
  await expect(page.getByTestId("calc-size")).toContainText("16.5 BTC");
  await page.getByLabel("имя пресета").fill("btc-1");
  await page.getByRole("button", { name: "Сохранить пресет" }).click();
  await expect(page.getByRole("button", { name: "btc-1" })).toBeVisible();
});

test("вотчлист: добавить и убрать", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls, { watch: ["BTCUSDT"], journal: [] });
  await page.goto("/watchlist");
  await expect(page.getByText("1 инструментов")).toBeVisible();
  await expect(page.getByText("OB up · 0.40 ATR")).toBeVisible();
  await page.getByLabel("инструмент").fill("ETHUSDT");
  await page.getByRole("button", { name: "Добавить" }).click();
  await expect(page.getByText("2 инструментов")).toBeVisible();
  await page.getByRole("button", { name: "убрать BTCUSDT" }).click();
  await expect(page.getByText("1 инструментов")).toBeVisible();
  expect(calls).toContain("DELETE /v1/watchlist/items/BTCUSDT");
});

test("журнал: добавить запись, итоги, удалить", async ({ page }, testInfo) => {
  const calls: string[] = [];
  await mock(page, calls, { watch: [], journal: [] });
  await page.goto("/journal");
  await expect(page.getByText("Записей пока нет.")).toBeVisible();
  await page.getByRole("button", { name: "Добавить сделку" }).click();
  await page.getByLabel("Инструмент").fill("BTCUSDT");
  await page.getByLabel("Вход, цена").fill("100");
  await page.getByLabel("Стоп").fill("98");
  await page.getByLabel("Выход, цена").fill("104");
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Запись добавлена");
  await expect(page.getByRole("cell", { name: /\+2\.00.R/ }).last()).toBeVisible();
  await expect(page.getByLabel("итоги")).toContainText("сделок 1");
  // аналитика (план 3.8 v2): кривая капитала, ошибки, таблицы
  const an = page.getByTestId("journal-analytics");
  await expect(an.getByRole("img", { name: /кривая капитала/ })).toBeVisible();
  await expect(an.getByLabel("типовые ошибки")).toContainText("вход без сигнала 1 из 1");
  await expect(an.getByRole("cell", { name: "без сигнала" })).toBeVisible();
  await expect(an.getByRole("cell", { name: "Пн" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("journal.png"), fullPage: true });
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "удалить" }).click();
  await expect(page.getByText("Записей пока нет.")).toBeVisible();
});

test("скринер: таблица, фильтр по зоне, сортировка", async ({ page }, testInfo) => {
  const calls: string[] = [];
  await mock(page, calls, { watch: [], journal: [] });
  await page.goto("/screener");
  await expect(page.getByText("2 из 2")).toBeVisible();
  await expect(page.locator("tbody tr").first().locator("svg polyline")).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("screener.png"), fullPage: true });
  await page.getByLabel("до зоны").selectOption("1");
  await expect(page.getByText("1 из 2")).toBeVisible();
  await page.getByLabel("до зоны").selectOption("");
  await page.getByRole("button", { name: "сортировать по: 24 ч" }).click();
  const first = page.locator("tbody tr").first();
  await expect(first).toContainText("BTCUSDT");
  await page.getByRole("button", { name: "сортировать по: 24 ч" }).click();
  await expect(page.locator("tbody tr").first()).toContainText("ETHUSDT");
});

test("настройки: сохранить риск-профиль", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls, { watch: [], journal: [] });
  await page.goto("/settings");
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue("trader@example.com");
  await page.getByLabel("Риск на сделку, %").fill("2");
  await page.getByRole("button", { name: "Сохранить риск" }).click();
  await expect(page.getByRole("status")).toContainText("Риск-профиль сохранён");
  expect(calls).toContain("PATCH /v1/me/risk");
});

test("уведомления: сохранить настройки, тестовое письмо, отписка по ссылке", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls, { watch: [], journal: [] });
  let ns = { email_digest: "daily", email_signals: false, email_events: false, grades: ["A", "B", "C"], scope: "all", quiet_from: null, quiet_to: null, daily_limit: 20, telegram_linked: false };
  await page.route("**/v1/me/notifications**", (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    calls.push(`${req.method()} ${p}`);
    if (p.endsWith("/test")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "отправлено" }) });
    if (req.method() === "PATCH") ns = { ...ns, ...(req.postDataJSON() as object) };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ns) });
  });
  await page.route("**/v1/notifications/unsubscribe", (route) => {
    const b = route.request().postDataJSON() as { token: string };
    return b.token === "good" ? route.fulfill({ status: 200, contentType: "application/json", body: '{"status":"ok"}' }) : route.fulfill({ status: 404, contentType: "application/json", body: '{"detail":"ссылка отписки недействительна"}' });
  });
  await page.goto("/settings");
  await page.getByLabel("Письма о новых сигналах").selectOption("on");
  await page.getByRole("checkbox", { name: "C" }).uncheck();
  await page.getByLabel("Тихие часы с (UTC)").selectOption("22");
  await page.getByLabel("до (UTC)").selectOption("7");
  await page.getByRole("button", { name: "Сохранить уведомления" }).click();
  await expect(page.getByRole("status")).toContainText("Уведомления сохранены");
  expect(ns.email_signals).toBe(true);
  expect(ns.grades).toEqual(["A", "B"]);
  expect(ns.quiet_from).toBe(22);
  await page.getByRole("button", { name: "Отправить тестовое письмо" }).click();
  await expect(page.getByRole("status")).toContainText("Тестовое письмо: отправлено");
  await page.goto("/unsubscribe?token=bad");
  await page.getByRole("button", { name: "Отписаться" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "недействительна" })).toBeVisible();
  await page.goto("/unsubscribe?token=good");
  await page.getByRole("button", { name: "Отписаться" }).click();
  await expect(page.getByRole("status")).toContainText("Вы отписаны");
});

test("настройки: включить и отключить 2FA", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls, { watch: [], journal: [] });
  await page.goto("/settings");
  const tf = page.getByTestId("two-factor");
  await expect(tf).toContainText("Выключена");
  await tf.getByRole("button", { name: "Включить 2FA" }).click();
  await expect(tf.getByTestId("two-factor-secret")).toHaveText("JBSWY3DPEHPK3PXP");
  await tf.getByLabel("2. Код из приложения").fill("111111");
  await tf.getByRole("button", { name: "Включить 2FA" }).click();
  await expect(page.getByRole("status")).toContainText("неверный код");
  await tf.getByLabel("2. Код из приложения").fill("123456");
  await tf.getByRole("button", { name: "Включить 2FA" }).click();
  await expect(tf.getByRole("region", { name: "резервные коды" })).toContainText("AAAA-1");
  await expect(tf).toContainText("резервных кодов осталось 10");
  await tf.getByLabel("Код для отключения").fill("AAAA-1");
  await tf.getByRole("button", { name: "Отключить 2FA" }).click();
  await expect(tf).toContainText("Выключена");
  expect(calls).toContain("POST /v1/me/2fa/disable");
});

test("скринер v2: фильтры, сохранённый скрин, CSV, алерт на возврат в зону", async ({ page }) => {
  const calls: string[] = [];
  const state = { watch: [] as string[], journal: [] as Record<string, unknown>[], screens: [] as Record<string, unknown>[], alerts: [] as Record<string, unknown>[] };
  await mock(page, calls, state);
  await page.goto("/screener");
  await expect(page.getByText("2 из 2")).toBeVisible();
  // W1 up — только BTCUSDT; «падение от 3 %» — никого
  await page.getByLabel("тренд W1").selectOption("up");
  await expect(page.getByText("1 из 2")).toBeVisible();
  await page.getByLabel("изменение за 24 ч").selectOption("down3");
  await expect(page.getByText("По фильтрам ничего нет.")).toBeVisible();
  await page.getByLabel("изменение за 24 ч").selectOption("");
  // сохранить скрин, сбросить, применить
  await page.getByLabel("имя скрина").fill("лонги W1");
  await page.getByRole("button", { name: "Сохранить скрин" }).click();
  await expect(page.getByRole("status")).toContainText("Скрин «лонги W1» сохранён");
  expect(state.screens[0]).toMatchObject({ name: "лонги W1", filters: { w1: "up" } });
  await page.getByRole("button", { name: "сбросить" }).click();
  await expect(page.getByText("2 из 2")).toBeVisible();
  await page.getByLabel("сохранённый скрин").selectOption("лонги W1");
  await expect(page.getByText("1 из 2")).toBeVisible();
  // CSV — только отфильтрованные символы
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV" }).click();
  expect((await dl).suggestedFilename()).toBe("platform-screener.csv");
  expect(calls).toContain("GET /v1/screener/export.csv");
  // алерт на возврат в зону из строки BTCUSDT
  await page.getByRole("button", { name: "алерт: BTCUSDT вернётся в зону" }).click();
  await expect(page.getByRole("status")).toContainText("Алерт создан: BTCUSDT — возврат в зону OB");
  expect(state.alerts[0]).toMatchObject({ symbol: "BTCUSDT", type: "zone", condition: { kind: "ob", dir: "up" } });
  await page.getByRole("button", { name: "удалить скрин лонги W1" }).click();
  await expect(page.getByLabel("сохранённый скрин")).toContainText("сохранённых скринов нет");
});

test("журнал: импорт сделок с биржи", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls, { watch: [], journal: [] });
  await page.goto("/journal");
  await page.getByRole("button", { name: "Импорт с биржи" }).click();
  const form = page.getByRole("form", { name: "импорт с биржи" });
  await form.getByLabel("API key").fill("x".repeat(16));
  await form.getByLabel("API secret").fill("s".repeat(16));
  await form.getByRole("button", { name: "Импортировать" }).click();
  await expect(form.getByRole("alert")).toContainText("Invalid API-key");
  await form.getByLabel("API key").fill("k".repeat(16));
  await form.getByLabel("Период").selectOption("90");
  await form.getByRole("button", { name: "Импортировать" }).click();
  await expect(page.getByRole("status")).toContainText("Импортировано 1 сделок");
  await expect(page.getByRole("cell", { name: "BTCUSDT short" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "binance:1 импорт" })).toBeVisible();
  expect(calls).toContain("POST /v1/journal/import");
});

test("настройки: API-ключ создаётся, показывается один раз и отзывается", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls, { watch: [], journal: [] });
  await page.goto("/settings");
  const panel = page.getByTestId("api-keys");
  await panel.getByLabel("Название ключа").fill("мой скрипт");
  await panel.getByRole("button", { name: "Создать ключ" }).click();
  await expect(panel.getByRole("region", { name: "новый ключ" })).toContainText("pk_abc1234SECRET");
  await expect(panel).toContainText("мой скрипт");
  page.once("dialog", (d) => d.accept());
  await panel.getByRole("button", { name: "отозвать ключ мой скрипт" }).click();
  await expect(panel).not.toContainText("мой скрипт");
  expect(calls).toContain("DELETE /v1/me/api-keys/1");
});
