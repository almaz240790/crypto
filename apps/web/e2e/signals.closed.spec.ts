import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { blockBinance } from "./helpers/binance";
import { mock as mockChart } from "./helpers/chart";

/**
 * Сигналы — только для владельца до запуска продаж (ADR-0013). Здесь API — заглушка в режиме закрытых сигналов
 * (MOCK_SIGNALS=closed): свой экземпляр на своём порту и своя сборка сайта на нём (playwright.config.ts, :3111 → :8098;
 * другой адрес — PW_CLOSED_URL). Гость и пользователь не видят ни ссылок, ни страниц, ни текстов о сигналах; admin и
 * owner видят всё, как раньше. Телефон 390×844 и десктоп 1440×900.
 */
const BASE = process.env.PW_CLOSED_URL ?? "http://localhost:3111";
test.use({ baseURL: BASE });

type Role = "guest" | "user" | "admin";

const me = (role: Exclude<Role, "guest">) => ({
  id: role === "admin" ? 1 : 2,
  email: `${role}@example.com`,
  name: null,
  email_verified: true,
  role: role === "admin" ? "owner" : "user",
  locale: "ru",
  timezone: "UTC",
  theme: "system",
  risk: { deposit: null, risk_pct: "1.00", exchange: "binance", market_type: "futures", default_leverage: 3, experience: "experienced" },
  // как API: решение о сигналах — поле signals (ADR-0013)
  signals: role === "admin",
});

/** Вход: cookie-подсказка и перехват /v1/auth/*. Токен admin — «staff»: по нему заглушка API отдаёт сигналы. */
async function as(page: Page, role: Role) {
  await blockBinance(page.context());
  if (role !== "guest") await page.context().addCookies([{ name: "pl_auth", value: "1", url: BASE }]);
  await page.route("**/v1/auth/**", (route) => {
    const p = new URL(route.request().url()).pathname;
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (role === "guest") return json(401, { detail: "нужен вход" });
    if (p === "/v1/auth/refresh") return json(200, { access_token: role === "admin" ? "staff" : "t" });
    if (p === "/v1/auth/me") return json(200, me(role));
    return json(404, { detail: "нет заглушки" });
  });
}

/** Ссылки на разделы сигналов: лента, карточки, статистика сигналов (не паттернов). */
const SIGNAL_LINKS = 'a[href^="/signals"], a[href="/stats"], a[href^="/stats?"]';

async function noSignalWords(page: Page) {
  // «не является сигналом», «паттерны не являются сигналами», «это не сигнал» — оговорки, они остаются;
  // прочих упоминаний сигналов быть не должно
  const text = (await page.locator("body").innerText()).replace(/не (явля[а-яё]+ )?сигнал[а-яё]*/giu, "");
  expect(text).not.toMatch(/сигнал|форвард|бэктест|стратеги/i);
}

const VIEWPORTS = [
  { name: "телефон", viewport: { width: 390, height: 844 } },
  { name: "десктоп", viewport: { width: 1440, height: 900 } },
];

for (const vp of VIEWPORTS) {
  test.describe(vp.name, () => {
    test.use({ viewport: vp.viewport });

    for (const role of ["guest", "user"] as const) {
      test(`${role}: главная, шапка, меню и подвал — без ссылок и слов о сигналах`, async ({ page }) => {
        await as(page, role);
        await page.goto("/");
        await expect(page.locator("footer")).toBeVisible();
        if (vp.viewport.width < 900) {
          await page.getByRole("button", { name: "открыть меню" }).click();
          await expect(page.locator("#site-menu")).toBeVisible();
        }
        await expect(page.locator(SIGNAL_LINKS)).toHaveCount(0);
        await noSignalWords(page);
      });

      test(`${role}: /signals и карточка — «страница не найдена»`, async ({ page }) => {
        await as(page, role);
        const res = await page.goto("/signals");
        if (role === "guest") expect(res?.status()).toBe(404);
        await expect(page.getByRole("heading", { name: "Страница не найдена" })).toBeVisible();
        await expect(page.getByTestId("not-found")).toBeVisible();
        const card = await page.goto("/signals/abc123");
        if (role === "guest") expect(card?.status()).toBe(404);
        await expect(page.getByRole("heading", { name: "Страница не найдена" })).toBeVisible();
        await expect(page.locator(SIGNAL_LINKS)).toHaveCount(0);
      });

      test(`${role}: /stats ведёт на статистику паттернов, вкладок сигналов нет`, async ({ page }) => {
        await as(page, role);
        for (const path of ["/stats", "/stats?scope=forward", "/stats?scope=backtest&run_id=3"]) {
          await page.goto(path);
          await expect(page).toHaveURL(/\/stats\/patterns$/);
          await expect(page.getByRole("heading", { name: "Отработка свечных паттернов" })).toBeVisible();
        }
        await expect(page.getByText("Бычье поглощение / Медвежье поглощение")).toBeVisible();
        // «Live» здесь — отметки паттернов после запуска детектора (/stats/patterns?scope=live), не сигналы
        for (const tab of ["Форвард-тест", "Бэктест"]) await expect(page.getByRole("link", { name: tab, exact: true })).toHaveCount(0);
        await expect(page.getByRole("link", { name: "Live", exact: true })).toHaveAttribute("href", /^\/stats\/patterns\?/);
        await expect(page.getByRole("link", { name: "Статистика сигналов" })).toHaveCount(0);
        await expect(page.locator(SIGNAL_LINKS)).toHaveCount(0);
        await noSignalWords(page);
      });

      test(`${role}: /status без движка сигналов, трекера и правила о публикации`, async ({ page }) => {
        await as(page, role);
        await page.goto("/status");
        await expect(page.getByRole("row").filter({ hasText: "Данные с биржи" }).first()).toBeVisible();
        await expect(page.getByText("Движок сигналов")).toHaveCount(0);
        await expect(page.getByText(/Трекер/)).toHaveCount(0);
        await expect(page.getByText(/если свеча H4 не закрылась/)).toBeVisible();
        await noSignalWords(page);
      });

      test(`${role}: документация API без эндпоинтов сигналов`, async ({ page }) => {
        await as(page, role);
        await page.goto("/api-docs");
        await expect(page.getByText("GET /v1/stats/patterns", { exact: true })).toBeVisible();
        await expect(page.getByText(/\/v1\/signals/)).toHaveCount(0);
        await expect(page.getByText("GET /v1/stats", { exact: true })).toHaveCount(0);
        await noSignalWords(page);
      });
    }

    test("user: настройки уведомлений — без писем и push о сигналах", async ({ page }) => {
      await as(page, "user");
      await page.route("**/v1/me/notifications", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ email_digest: "daily", email_signals: false, email_events: false, grades: ["A", "B", "C"], scope: "all", quiet_from: null, quiet_to: null, daily_limit: 20, push_signals: true, push_events: true, email_alerts: false, push_alerts: true, telegram_linked: false }) }),
      );
      await page.goto("/settings");
      await expect(page.getByLabel("Отчёт по журналу на почту")).toBeVisible();
      await expect(page.getByLabel("Push по алертам")).toBeVisible();
      for (const label of ["Письма о новых сигналах", "Письма о событиях", "Push о сигналах", "Push о событиях", "Email-дайджест"]) await expect(page.getByLabel(label)).toHaveCount(0);
      await expect(page.locator(SIGNAL_LINKS)).toHaveCount(0);
    });

    test("user: скринер ведёт на график, а не в ленту сигналов", async ({ page }) => {
      await as(page, "user");
      await screenerStub(page);
      await page.goto("/screener");
      await expect(page.getByRole("link", { name: "BTCUSDT" })).toHaveAttribute("href", "/chart/BTCUSDT/4h");
      await expect(page.getByText(/до появления сигнала/)).toHaveCount(0);
      await expect(page.locator(SIGNAL_LINKS)).toHaveCount(0);
    });

    test("admin: лента, статистика сигналов со вкладками, ссылки и настройки — как раньше", async ({ page }) => {
      await as(page, "admin");
      await page.goto("/signals");
      await expect(page.getByRole("heading", { name: "Страница не найдена" })).toHaveCount(0);
      await expect(page.getByText("Сигналы").first()).toBeVisible();
      // статистика — загружается в браузере с токеном владельца; вкладки live / форвард / бэктест на месте
      await page.goto("/stats?scope=backtest");
      await expect(page.getByRole("heading", { name: "Статистика сигналов" })).toBeVisible();
      for (const tab of ["Live", "Форвард-тест", "Бэктест"]) await expect(page.getByRole("link", { name: tab, exact: true })).toBeVisible();
      await expect(page.getByText("47.0 %").first()).toBeVisible();
      await expect(page.getByText("Прогон #3")).toBeVisible();
      await page.getByRole("link", { name: "Форвард-тест", exact: true }).click();
      await expect(page).toHaveURL(/scope=forward/);
      await expect(page.getByText(/Показана версия Trend OB retest 1\.2\.0/)).toBeVisible();
      await page.goto("/stats/patterns");
      await expect(page.getByRole("link", { name: "Статистика сигналов" })).toBeVisible();
      await page.goto("/api-docs");
      await expect(page.getByText("GET /v1/signals", { exact: true })).toBeVisible();
      await screenerStub(page);
      await page.goto("/screener");
      await expect(page.getByRole("link", { name: "BTCUSDT" })).toHaveAttribute("href", "/signals?symbol=BTCUSDT&tab=all");
    });
  });
}

test.describe("десктоп: график", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const role of ["user", "admin"] as const) {
    test(`${role}: слой «Сигналы» ${role === "admin" ? "есть" : "не предлагается"}`, async ({ page }) => {
      const calls: string[] = [];
      await mockChart(page, calls, true);
      // поверх заглушки графика: роль и решение API о сигналах
      await page.route("**/v1/auth/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(me(role)) }));
      await page.goto("/chart/BTCUSDT/4h");
      const objects = page.getByRole("complementary", { name: "панель объектов" });
      await objects.getByRole("tab", { name: "Слои" }).click();
      await expect(objects.getByLabel("Зоны", { exact: true })).toBeVisible();
      await expect(objects.getByLabel("Сигналы", { exact: true })).toHaveCount(role === "admin" ? 1 : 0);
    });
  }
});

test("admin: в админке — ссылки на ленту и статистику сигналов, во вкладке «Система» — движок и трекер", async ({ page }) => {
  await adminStub(page);
  await page.goto("/admin?tab=signals");
  const pages = page.getByRole("navigation", { name: "страницы сигналов на сайте" });
  await expect(pages.getByRole("link", { name: "Лента сигналов" })).toHaveAttribute("href", "/signals");
  await expect(pages.getByRole("link", { name: "Статистика: Live" })).toHaveAttribute("href", "/stats?scope=live");
  await expect(pages.getByRole("link", { name: "Статистика: форвард" })).toHaveAttribute("href", "/stats?scope=forward");
  await expect(pages.getByRole("link", { name: "Статистика: бэктест" })).toHaveAttribute("href", "/stats?scope=backtest");
  await page.getByRole("tab", { name: "Система" }).click();
  await expect(page.getByRole("row").filter({ hasText: "Движок сигналов" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Трекер сделок" })).toBeVisible();
  await expect(page.getByText("только admin и owner (SIGNALS_PUBLIC выключен)")).toBeVisible();
});

async function screenerStub(page: Page) {
  // сохранённые скрины — пустой список; сам скринер — одна строка
  await page.route("**/v1/screener/screens", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route(/\/v1\/screener(\?|$)/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [{ symbol: "BTCUSDT", instrument_id: 1, rank: 1, price: "100", change_24h: "1.2", volume_24h: "1000000", bias: "long", d1_trend: "up", w1_trend: "up", last_event: null, zone: null, atr_pct: "2", atr_percentile: 50, funding: "0.0001", funding_pct: 50, oi_change_24h: "1", ls_ratio: "1.1", liq_long_24h: "0", liq_short_24h: "0", beta_btc: "1" }], generated_at: "2026-10-25T10:00:00Z", sparklines: {} }),
    }),
  );
}

const MONITOR = {
  status: "degraded",
  generated_at: "2026-10-25T10:01:00+00:00",
  components: [
    { key: "data", title: "Данные с биржи", status: "ok", detail: "heartbeat 12 с назад", uptime_7d: 100 },
    { key: "candles", title: "Свечи H4", status: "degraded", detail: "нет закрытия по 1 из 20 инструментов", uptime_7d: 100 },
    { key: "engine", title: "Движок сигналов", status: "ok", detail: "прогон по H4 08:00", uptime_7d: 99.8 },
    { key: "tracker", title: "Трекер сделок", status: "ok", detail: "heartbeat 5 с назад", uptime_7d: 100 },
    { key: "notifier", title: "Уведомления", status: "ok", detail: "heartbeat 20 с назад", uptime_7d: 100 },
    { key: "api", title: "API и база", status: "ok", detail: "ок", uptime_7d: 100 },
  ],
  incidents: [],
};

/** Админка (ADR-0011): сеанс админки по подсказке pl_admin_hint и /v1/admin/auth/me. */
async function adminStub(page: Page) {
  await page.context().addCookies([{ name: "pl_admin_hint", value: "1", url: BASE }]);
  await page.route("**/v1/admin/**", (route) => {
    const p = new URL(route.request().url()).pathname;
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (p === "/v1/admin/auth/me") return json(200, { id: 1, email: "owner@example.com", name: null, role: "owner", method: "password", started_at: "2026-11-05T10:00:00Z", expires_at: "2026-11-05T18:00:00Z", idle_minutes: 60, backup_codes_left: 10 });
    if (p === "/v1/admin/signals") return json(200, []);
    if (p === "/v1/admin/strategies") return json(200, { versions: [], runs: [], requests: [], me: { id: 1, role: "owner" } });
    if (p === "/v1/admin/system")
      return json(200, { now: "2026-10-25T10:02:00Z", workers: { market_data: { heartbeat_age_sec: 1, status: null }, tracker: { heartbeat_age_sec: 30 }, notifier: { heartbeat_age_sec: 12 }, scheduler: { heartbeat_age_sec: 40 } }, candles_h4: { instruments: 20, stale_over_5h: 0 }, last_signal_at: "2026-10-25T08:00:30Z", last_event_at: "2026-10-25T09:40:00Z", notifications_sent_today: 3, mail: "resend", monitor: MONITOR, signals_public: false });
    return json(404, { detail: "нет заглушки" });
  });
}

/**
 * Снимки для отчёта (deviceScaleFactor 2): /stats и /status — гостем и владельцем, вкладка «Система» админки.
 * Только когда задан каталог PW_SHOTS_DIR: в CI файлы не пишутся.
 */
const SHOTS = process.env.PW_SHOTS_DIR;
test.describe("снимки", () => {
  test.skip(!SHOTS, "PW_SHOTS_DIR не задан");

  for (const vp of VIEWPORTS) {
    const tag = vp.viewport.width < 900 ? "phone" : "desktop";
    test.describe(tag, () => {
      test.use({ viewport: vp.viewport, deviceScaleFactor: 2 });

      for (const role of ["guest", "admin"] as const) {
        test(`${role}: /stats и /status`, async ({ page }) => {
          mkdirSync(SHOTS!, { recursive: true });
          await as(page, role);
          await page.goto("/stats?scope=backtest");
          if (role === "admin") await expect(page.getByText("Прогон #3")).toBeVisible();
          else await expect(page.getByText("Бычье поглощение / Медвежье поглощение")).toBeVisible();
          await page.screenshot({ path: join(SHOTS!, `${tag}-${role}-stats.png`), fullPage: true });
          await page.goto("/status");
          await expect(page.getByRole("row").filter({ hasText: "Данные с биржи" }).first()).toBeVisible();
          await page.screenshot({ path: join(SHOTS!, `${tag}-${role}-status.png`), fullPage: true });
        });
      }

      test("admin: вкладка «Система» админки", async ({ page }) => {
        mkdirSync(SHOTS!, { recursive: true });
        await adminStub(page);
        await page.goto("/admin?tab=system");
        await expect(page.getByRole("row").filter({ hasText: "Движок сигналов" })).toBeVisible();
        await page.screenshot({ path: join(SHOTS!, `${tag}-admin-system.png`), fullPage: true });
      });
    });
  }
});
