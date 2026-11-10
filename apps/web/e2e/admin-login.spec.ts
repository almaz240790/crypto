import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { blockBinance } from "./helpers/binance";

/**
 * Отдельный вход в админку (ADR-0011) с заглушкой API на уровне браузера: первая настройка кода (письмо со
 * ссылкой, QR, резервные коды и их перезагрузка), обычный вход, неверный код, не-админ, ссылка из письма,
 * открытый сеанс (закладка, ссылка с другого сайта), причина закрытия сеанса, раздельный выход, «Защита входа»
 * (новые резервные коды, перенос кода), выдача роли с кодом, нет ссылки на админку в меню сайта; переходный режим —
 * владелец без кода, вошедший на сайт, видит админку с плашкой «Настройте защиту» до первой настройки.
 * Компьютер и телефон (390×844, касание).
 */

const ADMIN_EMAIL = "owner@example.com";
const PASSWORD = "correct horse battery";
const GENERIC = "Не получилось войти. Проверьте email и пароль.";
const CODE_FAILED = "Код не подошёл. Введите свежий код из приложения — он меняется каждые 30 секунд.";
const STEP_UP_FAILED = "Чтобы выдать права админки, введите свежий код из приложения.";
const STEP_UP_NEEDS_SETUP = "Чтобы выдать права админки, сначала настройте защиту входа кодом.";
const GRACE_BANNER = "Вход в админку пока без защиты кодом.";
const ME = { id: 1, email: ADMIN_EMAIL, name: null, role: "owner", method: "password", grace: false, started_at: "2026-11-05T10:00:00Z", expires_at: "2026-11-05T18:00:00Z", idle_minutes: 60, backup_codes_left: 10 };
/** Переходный режим: тот же владелец по токену сайта, код ещё не настроен — сроков сеанса нет. */
const GRACE_ME = { id: 1, email: ADMIN_EMAIL, name: null, role: "owner", method: "site", grace: true, setup_required: true, backup_codes_left: 0 };
const SITE_ME = { id: 1, email: ADMIN_EMAIL, name: null, email_verified: true, role: "owner", locale: "ru", timezone: "UTC", theme: "system", risk: { deposit: null, risk_pct: "1.00", exchange: "binance", market_type: "futures", default_leverage: 3, experience: null } };
const BACKUP = ["ABCDEFGH23", "BCDEFGHJ34", "CDEFGHJK45", "DEFGHJKL56", "EFGHJKLM67", "FGHJKLMN78", "GHJKLMNP89", "HJKLMNPQ92", "JKLMNPQR23", "KLMNPQRS34"];
const BACKUP_NEW = BACKUP.map((c) => "N" + c.slice(1));
// QR версии 1 (21×21): три «глазка» по углам — для снимка достаточно
const eye = (x: number, y: number) => `M${x} ${y}h7v1h-7zM${x} ${y + 6}h7v1h-7zM${x} ${y + 1}h1v5h-1zM${x + 6} ${y + 1}h1v5h-1zM${x + 2} ${y + 2}h3v3h-3z`;
const QR = { size: 21, path: eye(0, 0) + eye(14, 0) + eye(0, 14) + "M8 8h5v1h-5zM9 10h3v1h-3zM8 12h1v1h-1zM12 12h1v1h-1z" };
const SETUP = { secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP", otpauth_url: "otpauth://totp/PlatformSol:owner%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=PlatformSol", qr: QR };
const USERS = [
  { id: 1, email: ADMIN_EMAIL, name: null, role: "owner", country: null, verified: true, created_at: "2026-10-01T10:00:00Z", blocked_at: null, blocked_reason: null, deleted: false },
  { id: 2, email: "helper@example.com", name: null, role: "user", country: null, verified: true, created_at: "2026-10-02T10:00:00Z", blocked_at: null, blocked_reason: null, deleted: false },
];

type Opts = { twoFactor?: boolean; mail?: boolean; sessionAlive?: boolean; ended?: string; codesLeft?: number };
type State = { twoFactor: boolean; session: boolean; ended: string | null; codesLeft: number; patches: Record<string, unknown>[] };

/** Заглушка API: состояние сеанса админки и сайта, журнал вызовов. */
async function mockApi(page: Page, calls: string[], opts: Opts = {}): Promise<State> {
  const state: State = { twoFactor: opts.twoFactor ?? true, session: opts.sessionAlive ?? true, ended: opts.ended ?? null, codesLeft: opts.codesLeft ?? 10, patches: [] };
  await blockBinance(page.context());
  await page.route("**/v1/**", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    calls.push(`${req.method()} ${p}`);
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(body) });
    const body = () => (req.postDataJSON() ?? {}) as Record<string, string>;
    /** Сеанса нет: 401 и, если сервер знает почему, причина в заголовке X-Admin-Ended. */
    const noSession = () => json(401, { detail: "Сеанс админки закончился. Войдите снова." }, state.ended ? { "x-admin-ended": state.ended } : {});
    const me = () => ({ ...ME, backup_codes_left: state.codesLeft });
    const siteToken = Boolean(req.headers()["authorization"]);
    if (p.startsWith("/v1/admin/") && siteToken) calls.push(`SITE-TOKEN ${p}`);
    /** Как API: сеанс админки (cookie) — или токен сайта, пока код не настроен (переходный режим). */
    const grace = !state.session && siteToken && !state.twoFactor;
    const allowed = state.session || grace;
    if (p === "/v1/admin/auth/config") return json(200, { mail: opts.mail ?? true, idle_minutes: 60, session_hours: 8 });
    if (p === "/v1/admin/auth/login") {
      const b = body();
      if (b.email !== ADMIN_EMAIL || b.password !== PASSWORD) return json(401, { detail: GENERIC });
      // пароль верный: с настроенным кодом — билет на код, без него — только письмо со ссылкой
      if (state.twoFactor) return json(200, { step: "code", ticket: "ticket-password-1", email: ADMIN_EMAIL });
      return json(200, { step: "mail", email: ADMIN_EMAIL, mail: opts.mail ?? true, sent: opts.mail ?? true });
    }
    if (p === "/v1/admin/auth/magic") return json(202, { status: "ok" });
    if (p === "/v1/admin/auth/magic/consume") {
      return body().link === "good-link-123456" ? json(200, { step: state.twoFactor ? "code" : "setup", ticket: "ticket-link-1", email: ADMIN_EMAIL }) : json(400, { detail: "Ссылка недействительна или устарела. Запросите новую." });
    }
    if (p === "/v1/admin/auth/setup") return json(200, SETUP);
    if (p === "/v1/admin/auth/setup/confirm") {
      if (body().code !== "123456") return json(401, { detail: CODE_FAILED });
      state.twoFactor = true;
      state.session = true;
      return json(200, { ...me(), backup_codes: BACKUP });
    }
    if (p === "/v1/admin/auth/verify") {
      const code = body().code;
      if (code !== "123456" && code !== BACKUP[0]) return json(401, { detail: CODE_FAILED });
      state.session = true;
      state.ended = null;
      return json(200, me());
    }
    if (p === "/v1/admin/auth/me") {
      if (state.session) return json(200, me());
      if (grace) return json(200, GRACE_ME);
      // код настроен — токен сайта не подходит: «нужен вход в админку», без причины закрытия сеанса
      return siteToken ? json(401, { detail: "Нужен вход в админку." }) : noSession();
    }
    if (p === "/v1/admin/auth/logout") {
      state.session = false;
      return route.fulfill({ status: 204 });
    }
    if (p === "/v1/admin/auth/2fa/backup-codes") {
      if (!state.session) return noSession();
      if (body().code !== "123456") return json(401, { detail: CODE_FAILED });
      state.codesLeft = 10;
      return json(200, { backup_codes: BACKUP_NEW, backup_codes_left: 10 });
    }
    if (p === "/v1/admin/auth/2fa/rotate") {
      if (body().code !== "123456" && body().code !== BACKUP[0]) return json(401, { detail: CODE_FAILED });
      return json(200, { ...SETUP, pending: "pending-rotation-token-0123456789" });
    }
    if (p === "/v1/admin/auth/2fa/rotate/confirm") {
      if (body().code !== "654321") return json(401, { detail: CODE_FAILED });
      state.codesLeft = 10;
      return json(200, { backup_codes: BACKUP_NEW, backup_codes_left: 10 });
    }
    if (p === "/v1/admin/strategies") return allowed ? json(200, { versions: [], runs: [], requests: [], me: { id: 1, role: "owner" } }) : noSession();
    if (p === "/v1/admin/audit") return allowed ? json(200, []) : noSession();
    if (p === "/v1/admin/tickets") return allowed ? json(200, []) : noSession();
    if (p === "/v1/admin/users" && req.method() === "GET") return allowed ? json(200, USERS) : noSession();
    if (p === "/v1/admin/users/2" && req.method() === "PATCH") {
      const b = req.postDataJSON() as Record<string, unknown>;
      state.patches.push(b);
      if (!allowed) return noSession();
      if (grace && (b.role === "admin" || b.role === "owner")) return json(403, { detail: STEP_UP_NEEDS_SETUP });
      if (b.role === "admin" && b.code !== "123456") return json(403, { detail: STEP_UP_FAILED });
      return json(200, { id: 2, role: b.role, blocked: false });
    }
    if (p === "/v1/auth/refresh") return json(200, { access_token: "site.jwt", token_type: "bearer", expires_in: 900 });
    if (p === "/v1/auth/me") return json(200, SITE_ME);
    if (p === "/v1/auth/logout") return route.fulfill({ status: 204 });
    if (p === "/v1/me/2fa") return json(200, { enabled: false, backup_codes_left: 0, admin: true });
    if (p === "/v1/watchlist") return json(200, { id: 1, name: "Основной", items: [] });
    return json(404, { detail: "нет заглушки" });
  });
  return state;
}

async function hint(context: BrowserContext, name: string) {
  return (await context.cookies()).find((c) => c.name === name)?.value ?? null;
}

/** Подсказка открытого сеанса админки — как её ставит страница входа (SameSite=Lax, путь /admin). */
const HINT = { name: "pl_admin_hint", value: "1", domain: "localhost", path: "/admin", sameSite: "Lax" as const };

/** Страница входа ожила (гидратация и настройки получены): до этого ввод в поля React не увидит. */
async function ready(page: Page) {
  await expect(page.getByText(/Нет пароля\? Войти по ссылке на почту|Вход по ссылке на почту сейчас недоступен/)).toBeVisible();
}

async function noSideScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

async function password(page: Page) {
  await ready(page);
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Пароль").fill(PASSWORD);
  await page.getByRole("button", { name: "Продолжить" }).click();
}

/** Обычный вход до шапки админки. */
async function signIn(page: Page, to = "/admin/login") {
  await page.goto(to);
  await password(page);
  await page.getByLabel("Код", { exact: true }).fill("123456");
  await page.getByRole("button", { name: "Войти в админку" }).click();
  await expect(page.getByTestId("admin-who")).toContainText(ADMIN_EMAIL);
}

/** Первый вход: пароль → письмо со ссылкой → ссылка → QR и первый код → резервные коды (экран остаётся открыт). */
async function firstTimeToBackupCodes(page: Page) {
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login\?next=%2Fadmin$/);
  await expect(page.getByRole("heading", { name: "Вход в админку" })).toBeVisible();
  await password(page);
  // одного пароля мало: первая настройка кода — только по ссылке из письма
  await expect(page.getByRole("heading", { name: "Проверьте почту" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText(`Мы отправили её на ${ADMIN_EMAIL}`);
  await expect(page.getByTestId("admin-qr")).toHaveCount(0);
  await page.goto("/admin/login?link=good-link-123456");
  await expect(page.getByRole("heading", { name: "Защитите вход кодом из телефона" })).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/login$/); // токен ссылки убран из адреса
  await expect(page.getByTestId("admin-qr").locator("svg")).toBeVisible();
}

async function firstTimeSetup(page: Page, calls: string[]) {
  await mockApi(page, calls, { twoFactor: false });
  await firstTimeToBackupCodes(page);
  const add = page.getByRole("link", { name: "Добавить код на этом устройстве" });
  await expect(add).toHaveAttribute("href", SETUP.otpauth_url);
  await page.getByRole("button", { name: "Не получается? Ввести ключ вручную" }).click();
  await expect(page.getByTestId("admin-secret")).toHaveText("JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP");
  // неверный первый код — подсказка, шаг не меняется
  await page.getByLabel("Код из приложения").fill("000000");
  await page.getByRole("button", { name: "Включить защиту и войти" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(CODE_FAILED);
  await page.getByLabel("Код из приложения").fill("123 456");
  await page.getByRole("button", { name: "Включить защиту и войти" }).click();
  await expect(page.getByRole("heading", { name: "Сохраните резервные коды" })).toBeVisible();
  await expect(page.getByTestId("backup-codes").getByRole("listitem")).toHaveCount(10);
  // перезагрузка (на iPhone — жест «потянуть вниз» или уход в «Пароли»): коды те же, а не форма пароля
  await page.reload();
  await expect(page.getByRole("heading", { name: "Сохраните резервные коды" })).toBeVisible();
  await expect(page.getByTestId("backup-codes").getByRole("listitem")).toHaveText(BACKUP);
  // и из админки, пока коды не подтверждены, возвращает к ним
  await page.goto("/admin?tab=audit");
  await expect(page).toHaveURL(/\/admin\/login\?next=%2Fadmin%3Ftab%3Daudit$/);
  await expect(page.getByTestId("backup-codes").getByRole("listitem")).toHaveCount(10);
  const go = page.getByRole("button", { name: "Перейти в админку" });
  await expect(go).toBeDisabled();
  await page.getByLabel(/Я сохранил\(а\) коды/).check();
  await go.click();
  await expect(page).toHaveURL(/\/admin\?tab=audit$/);
  await expect(page.getByTestId("admin-who")).toContainText(ADMIN_EMAIL);
  await expect(page.getByRole("button", { name: "Выйти из админки" })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("pl-admin-backup"))).toBeNull(); // после галочки коды стёрты
  expect(calls.filter((c) => c === "POST /v1/admin/auth/setup/confirm")).toHaveLength(2); // неверный код и верный; после перезагрузок — ни одного нового
  expect(calls.filter((c) => c.startsWith("SITE-TOKEN"))).toEqual([]);
}

test.describe("вход в админку — компьютер", () => {
  test("первый вход: письмо со ссылкой, QR-код, неверный и верный код, резервные коды переживают перезагрузку", async ({ page }) => {
    const calls: string[] = [];
    await firstTimeSetup(page, calls);
  });

  test("обычный вход: пароль → неверный код → резервный код; в шапке — кто вошёл", async ({ page }) => {
    const calls: string[] = [];
    await mockApi(page, calls);
    await page.goto("/admin/login");
    await password(page);
    await expect(page.getByRole("heading", { name: "Код из приложения" })).toBeVisible();
    await expect(page.getByText(`Вход для ${ADMIN_EMAIL}`)).toBeVisible();
    await page.getByLabel("Код", { exact: true }).fill("111111");
    await page.getByRole("button", { name: "Войти в админку" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toHaveText(CODE_FAILED);
    await page.getByLabel("Код", { exact: true }).fill(BACKUP[0]!.toLowerCase());
    await page.getByRole("button", { name: "Войти в админку" }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByTestId("admin-who")).toContainText("владелец");
    expect(await hint(page.context(), "pl_admin_hint")).toBe("1");
  });

  test("не-админ и неверный пароль — одна и та же ошибка, второй шаг не открывается", async ({ page }) => {
    const calls: string[] = [];
    await mockApi(page, calls);
    await page.goto("/admin/login");
    await ready(page);
    for (const [email, pw] of [["trader@example.com", PASSWORD], [ADMIN_EMAIL, "wrong password"]] as const) {
      await page.getByLabel("Email").fill(email);
      await page.getByLabel("Пароль").fill(pw);
      await page.getByRole("button", { name: "Продолжить" }).click();
      await expect(page.getByRole("main").getByRole("alert")).toHaveText(GENERIC);
      await expect(page.getByRole("heading", { name: "Вход в админку" })).toBeVisible();
    }
    expect(calls.filter((c) => c === "POST /v1/admin/auth/login")).toHaveLength(2);
    expect(calls.some((c) => c.includes("/verify") || c.includes("/setup"))).toBe(false);
  });

  test("вход по ссылке из письма; без почты на сервере — честная подсказка и ссылка с сервера", async ({ page }) => {
    const calls: string[] = [];
    await mockApi(page, calls);
    await page.goto("/admin/login");
    await ready(page);
    await page.getByRole("button", { name: "Нет пароля? Войти по ссылке на почту" }).click();
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByRole("button", { name: "Прислать ссылку" }).click();
    await expect(page.getByRole("heading", { name: "Проверьте почту" })).toBeVisible();
    await page.goto("/admin/login?link=good-link-123456");
    await expect(page.getByRole("heading", { name: "Код из приложения" })).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/login$/); // токен ссылки убран из адреса
    await page.goto("/admin/login?link=bad-link-1234567");
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Ссылка недействительна");
    // почта на сервере не настроена: вход по ссылке скрыт, а первая настройка — по ссылке с сервера
    const calls2: string[] = [];
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.evaluate(() => sessionStorage.clear());
    await mockApi(page, calls2, { mail: false, twoFactor: false });
    await page.goto("/admin/login");
    await ready(page);
    await expect(page.getByText("Вход по ссылке на почту сейчас недоступен")).toBeVisible();
    await expect(page.getByRole("button", { name: "Нет пароля? Войти по ссылке на почту" })).toHaveCount(0);
    await password(page);
    await expect(page.getByRole("heading", { name: "Нужна ссылка для первой настройки" })).toBeVisible();
    await expect(page.getByRole("status")).toContainText("scripts/admin_link.py");
    await expect(page.getByTestId("admin-qr")).toHaveCount(0);
    expect(calls2.some((c) => c.includes("/setup"))).toBe(false);
  });

  test("владелец с настроенным кодом без сеанса админки — на /admin/login, даже если вошёл на сайт", async ({ page }) => {
    const calls: string[] = [];
    await mockApi(page, calls, { sessionAlive: false });
    await page.context().addCookies([{ name: "pl_auth", value: "1", domain: "localhost", path: "/" }]);
    await page.goto("/admin?tab=users");
    await expect(page).toHaveURL(/\/admin\/login\?next=%2Fadmin%3Ftab%3Dusers$/);
    await ready(page);
    await expect(page.getByRole("status")).toHaveCount(0);
    // подсказка осталась, а сеанса на сервере нет и причины он не знает — просто форма входа
    await page.context().addCookies([HINT]);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/admin\/login\?next=%2Fadmin$/);
    await ready(page);
    expect(await hint(page.context(), "pl_admin_hint")).toBeNull();
    // токен сайта спрашивали только «кто вошёл» (переходный режим?) — API ответил «нужен вход в админку»
    expect(new Set(calls.filter((c) => c.startsWith("SITE-TOKEN")))).toEqual(new Set(["SITE-TOKEN /v1/admin/auth/me"]));
    await expect(page.getByText(GRACE_BANNER)).toHaveCount(0);
  });

  test("сеанс закрыт — страница входа называет настоящую причину", async ({ page }) => {
    const calls: string[] = [];
    const state = await mockApi(page, calls);
    await signIn(page);
    // пароль сменили на сайте: следующий запрос админки — 401 с причиной password
    state.session = false;
    state.ended = "password";
    await page.getByRole("tab", { name: "Аудит" }).click();
    await expect(page).toHaveURL(/\/admin\/login\?next=%2Fadmin%3Ftab%3Daudit&ended=password$/);
    await expect(page.getByRole("status")).toHaveText("Сеанс админки закрыт: пароль аккаунта изменён. Войдите с новым паролем.");
    await expect(page.getByText("без действий")).toHaveCount(0);
    expect(await hint(page.context(), "pl_admin_hint")).toBeNull();
    // час без действий — другая причина и другой текст (сеанс проверяется при открытии админки)
    for (const [reason, text] of [
      ["idle", "больше часа без действий"],
      ["expired", "прошло 8 часов с входа"],
      ["role", "больше нет прав админки"],
    ] as const) {
      state.ended = reason;
      await page.context().addCookies([HINT]);
      await page.goto("/admin");
      await expect(page).toHaveURL(new RegExp(`/admin/login\\?next=%2Fadmin&ended=${reason}$`));
      await expect(page.getByRole("status")).toContainText(text);
    }
    // вход заново возвращает туда, откуда увело
    await password(page);
    await page.getByLabel("Код", { exact: true }).fill("123456");
    await page.getByRole("button", { name: "Войти в админку" }).click();
    await expect(page).toHaveURL(/\/admin$/);
  });

  test("сеанс открыт: закладка /admin/login и ссылка с другого сайта ведут сразу в админку", async ({ page }) => {
    const calls: string[] = [];
    await mockApi(page, calls);
    await signIn(page);
    const logins = () => calls.filter((c) => c === "POST /v1/admin/auth/login").length;
    expect(logins()).toBe(1);
    // закладка на страницу входа
    await page.goto("/admin/login");
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByTestId("admin-who")).toContainText(ADMIN_EMAIL);
    await page.goto("/admin/login?next=%2Fadmin%3Ftab%3Dtickets");
    await expect(page).toHaveURL(/\/admin\?tab=tickets$/);
    // ссылка из письма о тикете, открытая в веб-почте (другой сайт)
    await page.route("https://mail.example.test/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: `<a id="go" href="http://localhost:${new URL(page.url()).port}/admin?tab=tickets">Ответить</a>` }),
    );
    await page.goto("https://mail.example.test/inbox");
    await page.locator("#go").click();
    await expect(page).toHaveURL(/\/admin\?tab=tickets$/);
    await expect(page.getByTestId("admin-who")).toContainText(ADMIN_EMAIL);
    expect(logins()).toBe(1); // пароль и код второй раз не спрашивали
  });

  test("выход из админки не выводит с сайта, выход с сайта не закрывает админку", async ({ page }) => {
    const calls: string[] = [];
    await mockApi(page, calls);
    await page.context().addCookies([{ name: "pl_auth", value: "1", domain: "localhost", path: "/" }, HINT]);
    await page.goto("/admin");
    await page.getByRole("button", { name: "Выйти из админки" }).click();
    await expect(page).toHaveURL(/\/admin\/login$/);
    await ready(page);
    await expect(page.getByRole("status")).toHaveCount(0);
    expect(calls).toContain("POST /v1/admin/auth/logout");
    expect(calls).not.toContain("POST /v1/auth/logout");
    expect(await hint(page.context(), "pl_auth")).toBe("1");
    expect(await hint(page.context(), "pl_admin_hint")).toBeNull();
    // сайт: «Выйти» — только выход с сайта
    await page.context().addCookies([HINT]);
    await page.goto("/watchlist");
    await page.getByRole("button", { name: "Выйти", exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    expect(calls).toContain("POST /v1/auth/logout");
    expect(calls.filter((c) => c === "POST /v1/admin/auth/logout")).toHaveLength(1);
    expect(await hint(page.context(), "pl_admin_hint")).toBe("1");
  });

  test("«Защита входа»: новые резервные коды по коду из приложения, перезагрузка их не теряет", async ({ page }) => {
    const calls: string[] = [];
    await mockApi(page, calls, { codesLeft: 2 });
    await signIn(page);
    // мало кодов — предупреждение в шапке ведёт в раздел
    await page.getByRole("link", { name: "Выпустить новые коды" }).click();
    await expect(page).toHaveURL(/\/admin\?tab=security$/);
    const panel = page.getByTestId("admin-security");
    await expect(panel.getByTestId("backup-left")).toHaveText("2");
    const form = panel.getByRole("form", { name: "Новые резервные коды" });
    await form.getByLabel("Код из приложения").fill("000000");
    await form.getByRole("button", { name: "Выпустить новые коды" }).click();
    await expect(form.getByRole("alert")).toHaveText(CODE_FAILED);
    await form.getByLabel("Код из приложения").fill("123456");
    await form.getByRole("button", { name: "Выпустить новые коды" }).click();
    await expect(panel.getByTestId("backup-codes").getByRole("listitem")).toHaveText(BACKUP_NEW);
    await expect(page.getByText("Осталось резервных кодов")).toHaveCount(0); // предупреждение ушло
    // перезагрузка до галочки — коды показываются снова
    await page.reload();
    await expect(page).toHaveURL(/\/admin\/login\?next=%2Fadmin%3Ftab%3Dsecurity$/);
    await expect(page.getByTestId("backup-codes").getByRole("listitem")).toHaveText(BACKUP_NEW);
    await page.getByLabel(/Я сохранил\(а\) коды/).check();
    await page.getByRole("button", { name: "Перейти в админку" }).click();
    await expect(page).toHaveURL(/\/admin\?tab=security$/);
    await expect(page.getByTestId("backup-left")).toHaveText("10");
    expect(calls.filter((c) => c === "POST /v1/admin/auth/login")).toHaveLength(1);
  });

  test("«Защита входа»: перенос кода на другой телефон без выключения защиты", async ({ page }) => {
    const calls: string[] = [];
    await mockApi(page, calls);
    await signIn(page, "/admin/login?next=%2Fadmin%3Ftab%3Dsecurity");
    const panel = page.getByTestId("admin-security");
    const start = panel.getByRole("form", { name: "Перенос кода: подтверждение" });
    await start.getByLabel("Код со старого телефона или резервный код").fill(BACKUP[0]!);
    await start.getByRole("button", { name: "Показать QR-код для нового телефона" }).click();
    const confirm = panel.getByRole("form", { name: "Перенос кода: новый телефон" });
    await expect(confirm.getByTestId("admin-qr").locator("svg")).toBeVisible();
    await confirm.getByLabel("Код с нового телефона").fill("111111");
    await confirm.getByRole("button", { name: "Перенести код" }).click();
    await expect(confirm.getByRole("alert")).toHaveText(CODE_FAILED);
    await confirm.getByLabel("Код с нового телефона").fill("654321");
    await confirm.getByRole("button", { name: "Перенести код" }).click();
    await expect(panel.getByText("код теперь на новом телефоне")).toBeVisible();
    await expect(panel.getByTestId("backup-codes").getByRole("listitem")).toHaveText(BACKUP_NEW);
    await panel.getByLabel(/Я сохранил\(а\) коды/).check();
    await panel.getByRole("button", { name: "Готово, коды сохранены" }).click();
    await expect(panel.getByTestId("backup-codes")).toHaveCount(0);
    expect(await page.evaluate(() => sessionStorage.getItem("pl-admin-backup"))).toBeNull();
    expect(calls).toContain("POST /v1/admin/auth/2fa/rotate/confirm");
    expect(calls).not.toContain("POST /v1/me/2fa/disable");
  });

  test("выдать роль admin можно только с кодом из приложения", async ({ page }) => {
    const calls: string[] = [];
    const state = await mockApi(page, calls);
    await signIn(page, "/admin/login?next=%2Fadmin%3Ftab%3Dusers");
    const role = page.getByLabel("роль helper@example.com");
    await expect(role).toHaveValue("user");
    const asked: string[] = [];
    let answer: string | null = null;
    page.on("dialog", (d) => {
      asked.push(d.message());
      void (answer === null ? d.dismiss() : d.accept(answer));
    });
    await role.selectOption("admin"); // отказ от ввода кода — запрос не уходит
    expect(state.patches).toEqual([]);
    answer = "123456";
    await role.selectOption("admin");
    await expect(page.getByRole("status").filter({ hasText: "Роль изменена" })).toBeVisible();
    expect(state.patches).toEqual([{ role: "admin", code: "123456" }]);
    expect(asked[0]).toContain("6 цифр из приложения");
    await role.selectOption("support"); // понижение и support — без кода
    await expect.poll(() => state.patches.length).toBe(2);
    expect(state.patches[1]).toEqual({ role: "support" });
    expect(asked).toHaveLength(2);
  });

  test("в меню сайта у владельца нет ссылки на админку; 2FA админу на сайте не включается", async ({ page }) => {
    const calls: string[] = [];
    await mockApi(page, calls);
    await page.context().addCookies([{ name: "pl_auth", value: "1", domain: "localhost", path: "/" }]);
    await page.goto("/watchlist");
    await expect(page.getByTitle(ADMIN_EMAIL)).toBeVisible();
    await expect(page.getByRole("link", { name: "Админка" })).toHaveCount(0);
    await expect(page.locator('a[href^="/admin"]')).toHaveCount(0);
    await page.goto("/settings");
    const twoFactor = page.getByTestId("two-factor");
    await expect(twoFactor.getByTestId("two-factor-admin")).toContainText("настраивается при входе в админку");
    await expect(twoFactor.getByRole("button", { name: "Включить 2FA" })).toHaveCount(0);
    await expect(page.locator('a[href^="/admin"]')).toHaveCount(0);
    // код включён: отключить его на сайте админ не может (иначе вернулся бы переходный режим)
    await page.route("**/v1/me/2fa", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: true, backup_codes_left: 7, admin: true }) }));
    await page.reload();
    await expect(twoFactor.getByTestId("two-factor-admin")).toContainText("Администратору защита кодом не отключается");
    await expect(twoFactor.getByRole("button", { name: "Отключить 2FA" })).toHaveCount(0);
  });

  test("переходный режим: владелец без кода вошёл на сайт — админка с плашкой, «Настроить» → письмо → QR → после настройки нужен сеанс админки", async ({ page }) => {
    const calls: string[] = [];
    const state = await mockApi(page, calls, { twoFactor: false, sessionAlive: false });
    await page.context().addCookies([{ name: "pl_auth", value: "1", domain: "localhost", path: "/" }]);
    await page.goto("/admin?tab=users");
    await expect(page).toHaveURL(/\/admin\?tab=users$/); // без редиректа на вход
    const banner = page.getByTestId("admin-grace");
    await expect(banner).toContainText(GRACE_BANNER);
    await expect(banner).toContainText("Настройте защиту — это одна минута.");
    await expect(page.getByTestId("admin-who")).toContainText(ADMIN_EMAIL);
    await expect(page.getByRole("button", { name: "Выйти из админки" })).toHaveCount(0); // выходить отдельно не из чего
    await expect(page.getByText("Резервных кодов не осталось")).toHaveCount(0);
    // данные админки идут с токеном сайта, как до отдельного входа
    await expect(page.getByLabel("роль helper@example.com")).toBeVisible();
    expect(calls).toContain("SITE-TOKEN /v1/admin/users");
    // выдать права админки без кода нельзя: код не спрашиваем (его нет), API отвечает «сначала настройте защиту»
    const asked: string[] = [];
    page.on("dialog", (d) => {
      asked.push(d.message());
      void d.dismiss();
    });
    await page.getByLabel("роль helper@example.com").selectOption("admin");
    await expect(page.getByRole("status").filter({ hasText: STEP_UP_NEEDS_SETUP })).toBeVisible();
    expect(asked).toEqual([]);
    expect(state.patches).toEqual([{ role: "admin" }]);
    // «Защита входа» — сначала настройка
    await page.getByRole("tab", { name: "Защита входа" }).click();
    await expect(page.getByTestId("admin-security")).toContainText("Защита входа не настроена");
    await expect(page.getByRole("link", { name: "Настроить защиту" })).toHaveAttribute("href", "/admin/login?setup=1");
    // «Настроить» на плашке → та же страница входа, шаг настройки; email уже подставлен
    await banner.getByRole("link", { name: "Настроить" }).click();
    await expect(page).toHaveURL(/\/admin\/login\?setup=1$/);
    await expect(page.getByRole("heading", { name: "Настройка защиты входа" })).toBeVisible();
    await ready(page);
    await expect(page.getByLabel("Email")).toHaveValue(ADMIN_EMAIL);
    await expect(page.getByRole("link", { name: "Вернуться в админку" })).toHaveAttribute("href", "/admin");
    await page.getByLabel("Пароль").fill(PASSWORD);
    await page.getByRole("button", { name: "Продолжить" }).click();
    // без письма код не настроить: шаг «Проверьте почту», но админка пока открыта, письмо можно повторить
    await expect(page.getByRole("heading", { name: "Проверьте почту" })).toBeVisible();
    const mail = page.getByTestId("admin-grace-mail");
    await expect(mail).toContainText("Админка пока открыта по адресу /admin");
    await expect(mail.getByRole("link", { name: "Открыть админку" })).toHaveAttribute("href", "/admin");
    await mail.getByRole("button", { name: "Отправить письмо ещё раз" }).click();
    await expect(mail.getByRole("status")).toContainText(`Отправили новое письмо на ${ADMIN_EMAIL}`);
    expect(calls).toContain("POST /v1/admin/auth/magic");
    await expect(page.getByTestId("admin-qr")).toHaveCount(0);
    expect(calls.some((c) => c.includes("/setup"))).toBe(false);
    // ссылка из письма → QR → код → резервные коды → админка уже по сеансу, без плашки
    await page.goto("/admin/login?link=good-link-123456");
    await expect(page.getByRole("heading", { name: "Защитите вход кодом из телефона" })).toBeVisible();
    await page.getByLabel("Код из приложения").fill("123456");
    await page.getByRole("button", { name: "Включить защиту и войти" }).click();
    await page.getByLabel(/Я сохранил\(а\) коды/).check();
    await page.getByRole("button", { name: "Перейти в админку" }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole("button", { name: "Выйти из админки" })).toBeVisible();
    await expect(page.getByText(GRACE_BANNER)).toHaveCount(0);
    // переходный режим закончился: без сеанса админки вход на сайт админку больше не открывает
    await page.getByRole("button", { name: "Выйти из админки" }).click();
    await expect(page).toHaveURL(/\/admin\/login$/);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/admin\/login\?next=%2Fadmin$/);
    await ready(page);
    await expect(page.getByText(GRACE_BANNER)).toHaveCount(0);
    expect(await hint(page.context(), "pl_auth")).toBe("1"); // с сайта не вывело
  });
});

test.describe("вход в админку — телефон", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

  test("первый вход на iPhone: письмо, кнопка «Добавить код на этом устройстве» выше QR, коды после перезагрузки, без бокового скролла", async ({ page }) => {
    const calls: string[] = [];
    await mockApi(page, calls, { twoFactor: false });
    await firstTimeToBackupCodes(page);
    await noSideScroll(page);
    const add = page.getByRole("link", { name: "Добавить код на этом устройстве" });
    await expect(add).toBeVisible();
    const qr = page.getByTestId("admin-qr");
    const [a, q] = [await add.boundingBox(), await qr.boundingBox()];
    expect(a!.y).toBeLessThan(q!.y);
    expect(a!.height).toBeGreaterThanOrEqual(44);
    await page.getByLabel("Код из приложения").fill("123456");
    await page.getByRole("button", { name: "Включить защиту и войти" }).click();
    await expect(page.getByTestId("backup-codes")).toBeVisible();
    await noSideScroll(page);
    await page.reload(); // «потянуть вниз» на телефоне
    await expect(page.getByTestId("backup-codes").getByRole("listitem")).toHaveText(BACKUP);
    await page.getByLabel(/Я сохранил\(а\) коды/).check();
    await page.getByRole("button", { name: "Перейти в админку" }).click();
    await expect(page.getByRole("button", { name: "Выйти из админки" })).toBeVisible();
    await noSideScroll(page);
  });

  test("письмо со ссылкой на телефоне: понятный шаг, без бокового скролла", async ({ page }) => {
    const calls: string[] = [];
    await mockApi(page, calls, { twoFactor: false });
    await page.goto("/admin/login");
    await password(page);
    await expect(page.getByRole("heading", { name: "Проверьте почту" })).toBeVisible();
    await noSideScroll(page);
    await page.getByRole("button", { name: "Назад к паролю" }).click();
    await expect(page.getByRole("heading", { name: "Вход в админку" })).toBeVisible();
  });

  test("обычный вход и неверный код на телефоне", async ({ page }) => {
    const calls: string[] = [];
    await mockApi(page, calls);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/admin\/login/);
    await password(page);
    await page.getByLabel("Код", { exact: true }).fill("000000");
    await page.getByRole("button", { name: "Войти в админку" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toHaveText(CODE_FAILED);
    await page.getByLabel("Код", { exact: true }).fill("123456");
    await page.getByRole("button", { name: "Войти в админку" }).click();
    await expect(page.getByTestId("admin-who")).toContainText(ADMIN_EMAIL);
    await noSideScroll(page);
  });

  test("не-админ на телефоне получает общую ошибку", async ({ page }) => {
    const calls: string[] = [];
    await mockApi(page, calls);
    await page.goto("/admin/login");
    await ready(page);
    await page.getByLabel("Email").fill("trader@example.com");
    await page.getByLabel("Пароль").fill(PASSWORD);
    await page.getByRole("button", { name: "Продолжить" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toHaveText(GENERIC);
  });

  test("переходный режим на телефоне: плашка и «Настроить» помещаются, шаг письма — без бокового скролла", async ({ page }) => {
    const calls: string[] = [];
    await mockApi(page, calls, { twoFactor: false, sessionAlive: false });
    await page.context().addCookies([{ name: "pl_auth", value: "1", domain: "localhost", path: "/" }]);
    await page.goto("/admin");
    const banner = page.getByTestId("admin-grace");
    await expect(banner).toContainText(GRACE_BANNER);
    const setup = banner.getByRole("link", { name: "Настроить" });
    expect((await setup.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await noSideScroll(page);
    await setup.click();
    await expect(page.getByRole("heading", { name: "Настройка защиты входа" })).toBeVisible();
    await ready(page);
    await expect(page.getByLabel("Email")).toHaveValue(ADMIN_EMAIL);
    await page.getByLabel("Пароль").fill(PASSWORD);
    await page.getByRole("button", { name: "Продолжить" }).click();
    await expect(page.getByTestId("admin-grace-mail")).toBeVisible();
    await noSideScroll(page);
    await page.getByRole("link", { name: "Открыть админку" }).click();
    await expect(page.getByTestId("admin-grace")).toBeVisible();
  });

  test("«Защита входа» на телефоне: новые коды и QR-код переноса помещаются в экран", async ({ page }) => {
    const calls: string[] = [];
    await mockApi(page, calls);
    await signIn(page, "/admin/login?next=%2Fadmin%3Ftab%3Dsecurity");
    const panel = page.getByTestId("admin-security");
    await noSideScroll(page);
    const form = panel.getByRole("form", { name: "Новые резервные коды" });
    await form.getByLabel("Код из приложения").fill("123456");
    await form.getByRole("button", { name: "Выпустить новые коды" }).click();
    await expect(panel.getByTestId("backup-codes").getByRole("listitem")).toHaveCount(10);
    await noSideScroll(page);
    const start = panel.getByRole("form", { name: "Перенос кода: подтверждение" });
    await start.getByLabel("Код со старого телефона или резервный код").fill("123456");
    await start.getByRole("button", { name: "Показать QR-код для нового телефона" }).click();
    await expect(panel.getByTestId("admin-qr").locator("svg")).toBeVisible();
    await noSideScroll(page);
  });
});
