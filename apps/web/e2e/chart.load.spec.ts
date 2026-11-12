import { expect, test, type Page, type Route } from "@playwright/test";
import { FIRST_PAGE, H4, SUBCENT, T0, mock, type MockServer } from "./helpers/chart";
import { liveSocket } from "./helpers/live";

/**
 * Загрузка терминала (план 2A.3, 2B.9; ADR-0010): первая порция свечей, ошибки, вход на публичных эндпоинтах графика,
 * мультичарт и синхронизация настроек — регрессии аудита (группа C).
 *
 * - chart-data-live-1: сбой первой порции не оставляет график мёртвым — повтор с паузами, «Повторить», сеть
 *   вернулась, сокет переподключился.
 * - TSA-2: объяснение «1m–15m — Pro» — только на 403 минутного ТФ; 404 — «инструмент не найден» со ссылкой; текст
 *   сервера (русский) английскому пользователю не показывается.
 * - TSA-1, TSA-6: истёкший токен обновляется и запрос повторяется; сеанс закончился — данные как гостю; гость не шлёт
 *   POST /v1/auth/refresh перед каждым запросом графика.
 * - chart-data-live-3, TSA-4: ячейка мультичарта — ответ истории прошлого символа не попадает в новый; минутные ТФ
 *   заперты по тарифу, как в терминале.
 * - TSA-3: настройки терминала не затирают раскладку на сервере значениями по умолчанию.
 */

type Range = { from: number; to: number };
type El = HTMLElement & { __chart: { panes(): { getSeries(): { data(): unknown[] }[] }[]; timeScale(): { setVisibleLogicalRange(r: Range): void } } };

const fulfill = (r: Route, status: number, body: unknown) => r.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const canvas = (page: Page) => page.getByTestId("terminal").locator("canvas").first();
/** Объяснение вместо графика: сбой загрузки, «инструмент не найден» или «1m–15m — Pro». */
const note = (page: Page) => page.getByTestId("chart-load-error");
const PRO_TEXT = /1m–15m/;
/** Свечей в главной серии терминала (0 — графика нет). */
const bars = (page: Page) => page.evaluate(() => (document.querySelector('[data-testid="terminal"]') as El | null)?.__chart.panes()[0]!.getSeries()[0]!.data().length ?? 0);

test.describe("первая порция свечей не пришла (chart-data-live-1, TSA-2)", () => {
  test("гость, 4ч, API 502: объяснение сбоя без «Pro», повтор сам через 2 с — график появляется", async ({ page }) => {
    const calls: string[] = [];
    await mock(page, calls);
    let fail = true;
    let n = 0;
    await page.route("**/v1/chart/candles?**", (r) => {
      n++;
      return fail ? fulfill(r, 502, { detail: "Bad Gateway" }) : r.fallback();
    });
    await page.goto("/chart/BTCUSDT/4h");
    const alert = note(page);
    await expect(alert).toHaveAttribute("role", "alert");
    await expect(alert).toContainText("Не удалось загрузить свечи (ошибка 502).");
    await expect(alert).not.toContainText(PRO_TEXT);
    await expect(alert.getByRole("button", { name: "Повторить" })).toBeVisible();
    fail = false;
    await expect.poll(() => bars(page), { timeout: 6000 }).toBe(FIRST_PAGE + 1);
    await expect(alert).toHaveCount(0);
    expect(n).toBe(2);
  });

  test("«Повторить», сеть вернулась, сокет переподключился — загрузка заново сразу, не дожидаясь паузы", async ({ page }) => {
    const calls: string[] = [];
    await mock(page, calls);
    const live = await liveSocket(page, { ticks: false, at: () => T0 + FIRST_PAGE * H4 + 600 });
    let fail = true;
    let n = 0;
    await page.route("**/v1/chart/candles?**", (r) => {
      n++;
      return fail ? fulfill(r, 503, { detail: "Service Unavailable" }) : r.fallback();
    });
    try {
      await page.goto("/chart/BTCUSDT/4h");
      const alert = note(page);
      const retry = alert.getByRole("button", { name: "Повторить" });
      await expect(alert).toContainText("Не удалось загрузить свечи");
      // первый повтор — сам через 2 с; следующий — только через 5 с
      await expect.poll(() => n, { timeout: 5000 }).toBe(2);
      await expect(retry).toBeEnabled();
      await retry.click();
      await expect.poll(() => n, { timeout: 1500 }).toBe(3);
      await expect(retry).toBeEnabled();
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await expect.poll(() => n, { timeout: 1500 }).toBe(4);
      await expect(retry).toBeEnabled();
      // сервер закрыл сокет: новое соединение через 3–5 с — и сразу загрузка свечей (до этого — пауза 30 с)
      await expect.poll(() => live.sockets.length).toBe(1);
      fail = false;
      await live.close();
      await expect.poll(() => live.sockets.length, { timeout: 8000 }).toBe(2);
      await expect.poll(() => bars(page), { timeout: 3000 }).toBe(FIRST_PAGE + 1);
      await expect(alert).toHaveCount(0);
      expect(n).toBe(5);
    } finally {
      live.dispose();
    }
  });

  test("гость: 404 — «инструмент не найден» со ссылкой на BTCUSDT 4ч, выбор инструмента показывает этот символ; 500 — сбой, не «Pro»", async ({ page }) => {
    const calls: string[] = [];
    await mock(page, calls);
    await page.route("**/v1/chart/candles?symbol=FOOBARUSDT**", (r) => fulfill(r, 404, { detail: "инструмент не найден" }));
    await page.route("**/v1/chart/candles?symbol=ETHUSDT**", (r) => fulfill(r, 500, { detail: "Internal Server Error" }));
    await page.goto("/chart/FOOBARUSDT/4h");
    await expect(note(page)).toContainText("Инструмент FOOBARUSDT не найден.");
    await expect(note(page)).not.toContainText(PRO_TEXT);
    await expect(note(page).getByRole("button", { name: "Повторить" })).toHaveCount(0);
    await expect(note(page).getByRole("link", { name: "Открыть BTCUSDT 4ч" })).toHaveAttribute("href", "/chart/BTCUSDT/4h");
    // символ из адреса — в списке выбора: выбор BTCUSDT — настоящая смена значения
    const picker = page.getByTestId("terminal-header").getByLabel("инструмент");
    await expect(picker).toHaveValue("FOOBARUSDT");
    await picker.selectOption("BTCUSDT");
    await expect(page).toHaveURL(/\/chart\/BTCUSDT\/4h$/);
    await expect.poll(() => bars(page)).toBe(FIRST_PAGE + 1);
    await page.goto("/chart/ETHUSDT/4h");
    await expect(note(page)).toContainText("Не удалось загрузить свечи (ошибка 500).");
    await expect(note(page)).not.toContainText(PRO_TEXT);
  });

  test("гость на 1м: объяснение «Pro» с «Войти» и «Подписка»; Free по-английски на 1м — английский текст и ссылка на подписку, без русского текста сервера", async ({ page }) => {
    const calls: string[] = [];
    await mock(page, calls);
    await page.goto("/chart/BTCUSDT/1m");
    await expect(note(page)).toContainText("Таймфреймы 1m–15m доступны после входа с подпиской Pro.");
    await expect(note(page)).not.toHaveAttribute("role", "alert");
    await expect(note(page).getByRole("link", { name: "Войти" })).toHaveAttribute("href", "/login?next=/chart/BTCUSDT/1m");
    await expect(note(page).getByRole("link", { name: "Подписка" })).toHaveAttribute("href", "/pricing");

    const ctx = await page.context().browser()!.newContext({ viewport: { width: 1600, height: 900 } });
    const en = await ctx.newPage();
    const baseURL = test.info().project.use.baseURL ?? "http://localhost:3101";
    await ctx.addCookies([{ name: "pl_locale", value: "en", url: baseURL }]);
    await mock(en, [], true, { drawings: [], layout: null, plan: "free" });
    await en.route("**/v1/auth/me", (r) => fulfill(r, 200, { id: 7, email: "t@example.com", name: null, email_verified: true, role: "user", locale: "en", timezone: "UTC", theme: "system", risk: {} }));
    await en.route("**/v1/chart/candles?**", (r) => (new URL(r.request().url()).searchParams.get("tf") === "1m" ? fulfill(r, 403, { detail: "таймфреймы 1m–15m доступны на тарифе Pro" }) : r.fallback()));
    await en.goto("/chart/BTCUSDT/1m");
    await expect(note(en)).toContainText("1m–15m timeframes are available with a Pro subscription.");
    expect(await note(en).innerText()).not.toMatch(/[А-Яа-яЁё]/);
    await expect(note(en).getByRole("link", { name: "Subscription" })).toHaveAttribute("href", "/billing");
    await ctx.close();
  });
});

test.describe("вход на эндпоинтах графика (TSA-1, TSA-6)", () => {
  test("гость не шлёт POST /v1/auth/refresh: ни перед первой порцией, ни перед историей слева", async ({ page }) => {
    const calls: string[] = [];
    await mock(page, calls);
    await page.goto("/chart/BTCUSDT/4h");
    await expect.poll(() => bars(page)).toBe(FIRST_PAGE + 1);
    await expect(page.getByLabel("состояние")).toContainText("цена");
    await page.evaluate(() => (document.querySelector('[data-testid="terminal"]') as El).__chart.timeScale().setVisibleLogicalRange({ from: 20, to: 120 }));
    await expect.poll(() => calls.filter((c) => c.startsWith("/v1/chart/candles") && c.includes("before=")).length).toBeGreaterThan(0);
    expect(calls.filter((c) => c.startsWith("/v1/auth/refresh"))).toEqual([]);
  });

  test("истёкший токен: Pro после обновления получает 5м; сеанс закончился — график открывается как гостю, без ошибки", async ({ page }) => {
    const calls: string[] = [];
    await mock(page, calls, true, { drawings: [], layout: null, plan: "pro" });
    const st = { valid: "", n: 0, refresh: "ok" as "ok" | "fail" };
    const seen: string[] = [];
    await page.route("**/v1/auth/refresh", (r) => {
      if (st.refresh === "fail") return fulfill(r, 401, { detail: "сессия истекла" });
      st.valid = `t${++st.n}`;
      return fulfill(r, 200, { access_token: st.valid });
    });
    // как API: токен есть, но не действителен — 401; без токена минутные ТФ — 403 гостя
    await page.route("**/v1/chart/candles?**", (r) => {
      const a = r.request().headers()["authorization"] ?? null;
      const tf = new URL(r.request().url()).searchParams.get("tf")!;
      seen.push(`${tf} ${a}`);
      if (a && a !== `Bearer ${st.valid}`) return fulfill(r, 401, { detail: "недействительный токен" });
      if (!a && ["1m", "5m", "15m"].includes(tf)) return fulfill(r, 403, { detail: "таймфреймы 1m–15m доступны на тарифе Pro" });
      return r.fallback();
    });
    await page.goto("/chart/BTCUSDT/4h");
    await expect.poll(() => bars(page)).toBe(FIRST_PAGE + 1);
    expect(seen).toEqual(["4h Bearer t1"]);
    // прошло 15 минут: токен t1 истёк
    st.valid = "expired";
    await page.locator('[data-tf="5m"]').first().click();
    await expect(page).toHaveURL(/\/chart\/BTCUSDT\/5m$/);
    await expect.poll(() => seen.slice(1)).toEqual(["5m Bearer t1", "5m Bearer t2"]);
    await expect.poll(() => bars(page)).toBe(FIRST_PAGE + 1);
    await expect(note(page)).toHaveCount(0);
    // сеанс закончился (вышли на другом устройстве): токен не обновить — свечи 4ч как гостю
    st.valid = "expired";
    st.refresh = "fail";
    await page.locator('[data-tf="4h"]').first().click();
    await expect(page).toHaveURL(/\/chart\/BTCUSDT\/4h$/);
    await expect.poll(() => seen.slice(3)).toEqual(["4h Bearer t2", "4h null"]);
    await expect.poll(() => bars(page)).toBe(FIRST_PAGE + 1);
    await expect(note(page)).toHaveCount(0);
  });
});

test.describe("мультичарт (chart-data-live-3, TSA-4)", () => {
  const cellSel = (symbol: string, tf = "4h") => `[aria-label="график ${symbol} ${tf}"] [data-testid="terminal"]`;
  const cellLen = (page: Page, symbol: string) => page.evaluate((sel) => (document.querySelector(sel) as El | null)?.__chart.panes()[0]!.getSeries()[0]!.data().length ?? 0, cellSel(symbol));
  const cellLogical = (page: Page, symbol: string, r: Range) => page.evaluate(({ sel, r }) => (document.querySelector(sel) as El).__chart.timeScale().setVisibleLogicalRange(r), { sel: cellSel(symbol), r });

  test("ответ истории слева для прошлого символа ячейки не запирает историю нового", async ({ page }) => {
    const calls: string[] = [];
    await mock(page, calls);
    // последняя порция BTCUSDT (has_older: false) приходит через 2 с — ячейка уже на другом символе
    await page.route("**/v1/chart/candles?**", async (route) => {
      const u = new URL(route.request().url());
      const before = u.searchParams.get("before");
      if (u.searchParams.get("symbol") !== "BTCUSDT" || !before) return route.fallback();
      calls.push(`${u.pathname}?${u.searchParams}`);
      await new Promise((r) => setTimeout(r, 2000));
      const end = Math.round((Number(before) - T0) / H4);
      const candles = Array.from({ length: 50 }, (_, k) => ({ t: T0 + (end - 50 + k) * H4, o: "100", h: "101", l: "99", c: "100.5", v: "1", open: false }));
      return fulfill(route, 200, { symbol: "BTCUSDT", tf: "4h", candles, current: null, has_older: false, tick_size: "0.1", server_time: "" });
    });
    await page.goto("/multichart");
    const cells = page.getByRole("region", { name: /^график / });
    await expect(cells).toHaveCount(2);
    await expect.poll(() => cellLen(page, "BTCUSDT")).toBe(FIRST_PAGE + 1);
    await cellLogical(page, "BTCUSDT", { from: 20, to: 120 });
    await expect.poll(() => calls.some((c) => c.includes("symbol=BTCUSDT") && c.includes("before="))).toBe(true);
    await cells.nth(0).getByLabel("инструмент", { exact: true }).selectOption(SUBCENT);
    await expect.poll(() => cellLen(page, SUBCENT)).toBe(FIRST_PAGE + 1);
    await page.waitForTimeout(2500);
    await cellLogical(page, SUBCENT, { from: 20, to: 120 });
    await expect.poll(() => calls.filter((c) => c.includes(`symbol=${SUBCENT}`) && c.includes("before=")).length, { timeout: 4000 }).toBe(1);
    await expect.poll(() => cellLen(page, SUBCENT)).toBeGreaterThan(FIRST_PAGE + 1);
  });

  const SAVED_1M = { count: 2, cells: [{ symbol: "BTCUSDT", tf: "1m" }, { symbol: "ETHUSDT", tf: "4h" }], markup: "compact" };

  test("гость с сохранённой ячейкой 1м: ячейка на 4ч (свечи 4ч, ссылка на 4ч), минутные ТФ в списке недоступны", async ({ page }) => {
    await page.addInitScript((v) => localStorage.setItem("pl-multichart", JSON.stringify(v)), SAVED_1M);
    const calls: string[] = [];
    await mock(page, calls);
    await page.goto("/multichart");
    const cell = page.getByRole("region", { name: /^график / }).first();
    await expect(cell).toHaveAttribute("aria-label", "график BTCUSDT 4h");
    await expect(cell.getByLabel("таймфрейм")).toHaveValue("4h");
    await expect(cell.getByRole("link", { name: "открыть в терминале" })).toHaveAttribute("href", "/chart/BTCUSDT/4h");
    await expect.poll(() => cellLen(page, "BTCUSDT")).toBe(FIRST_PAGE + 1);
    for (const x of ["1m", "5m", "15m"]) await expect(cell.locator(`option[value="${x}"]`)).toBeDisabled();
    await expect(cell.locator('option[value="1h"]')).toBeEnabled();
    expect(calls.filter((c) => c.startsWith("/v1/chart/candles") && c.includes("tf=1m"))).toEqual([]);
  });

  test("Free: минутные ТФ в ячейке недоступны с подсказкой; ответ 403 в ячейке — объяснение «Pro» со ссылкой на подписку", async ({ page, browser }) => {
    const calls: string[] = [];
    await mock(page, calls, true, { drawings: [], layout: null, plan: "free" });
    await page.goto("/multichart");
    const cell = page.getByRole("region", { name: /^график / }).first();
    await expect.poll(() => cellLen(page, "BTCUSDT")).toBe(FIRST_PAGE + 1);
    await expect(cell.locator('option[value="5m"]')).toBeDisabled();
    await expect(cell.locator('option[value="5m"]')).toHaveText("5м · Pro");
    // тариф не узнали (биллинг не отвечает): замков нет — решает сервер свечей, его 403 объясняется в ячейке
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    const p2 = await ctx.newPage();
    await p2.addInitScript((v) => localStorage.setItem("pl-multichart", JSON.stringify(v)), SAVED_1M);
    await mock(p2, [], true, { drawings: [], layout: null, plan: "free" });
    await p2.route("**/v1/billing/me", (r) => fulfill(r, 503, { detail: "недоступно" }));
    await p2.route("**/v1/chart/candles?**", (r) => (new URL(r.request().url()).searchParams.get("tf") === "1m" ? fulfill(r, 403, { detail: "таймфреймы 1m–15m доступны на тарифе Pro" }) : r.fallback()));
    await p2.goto("/multichart");
    const c2 = p2.getByRole("region", { name: "график BTCUSDT 1m" });
    await expect(c2).toContainText("Таймфреймы 1m–15m доступны с подпиской Pro.");
    await expect(c2.getByRole("link", { name: "Подписка" })).toHaveAttribute("href", "/billing");
    await ctx.close();
  });
});

test.describe("настройки терминала и раскладка на сервере (TSA-3)", () => {
  const DAY_OLD = Date.now() - 86_400_000;
  const SERVER_LAYOUT = { layers_v: 5, type: "bars", indicators: [{ uid: "rsi#1", id: "rsi", params: { period: 14 } }, { uid: "macd#1", id: "macd", params: {} }], markup: { preset: "clean", overrides: {} }, panels: ["funding"], scale: "log", overlay: null };
  const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("pl-terminal") ?? "null") as { type?: string; scale?: string; updated_at?: number } | null);

  async function setup(page: Page, get: (n: number) => "slow" | "fail" | "ok") {
    const server: MockServer = { drawings: [], layout: { ...SERVER_LAYOUT, __updated: DAY_OLD } };
    const puts: { updated_at: number; type: unknown }[] = [];
    let gets = 0;
    await mock(page, [], true, server);
    await page.route("**/v1/chart/layout**", async (r) => {
      const u = new URL(r.request().url());
      if (u.searchParams.get("name")) return r.fallback();
      if (r.request().method() === "PUT") {
        const b = r.request().postDataJSON() as { data: Record<string, unknown>; updated_at: number };
        puts.push({ updated_at: b.updated_at, type: b.data.type });
        // правило API: запись не старее серверной
        if (b.updated_at >= (server.layout!.__updated as number)) server.layout = { ...b.data, __updated: b.updated_at };
        return fulfill(r, 200, { name: null, data: b.data, updated_at: b.updated_at });
      }
      const mode = get(++gets);
      if (mode === "fail") return fulfill(r, 502, { detail: "Bad Gateway" });
      // ответ — снимок на момент запроса (как SELECT до задержки сети)
      const { __updated, ...data } = server.layout!;
      if (mode === "slow") await new Promise((res) => setTimeout(res, 1500));
      return fulfill(r, 200, { name: null, data, updated_at: __updated });
    });
    return { server, puts, gets: () => gets };
  }

  test("медленный ответ раскладки (1.5 с): значения по умолчанию на сервер не уходят, применяется раскладка сервера", async ({ page }) => {
    const s = await setup(page, () => "slow");
    await page.goto("/chart/BTCUSDT/4h");
    await expect(canvas(page)).toBeVisible();
    await expect.poll(async () => (await stored(page))?.type).toBe("bars");
    await page.waitForTimeout(2500);
    expect(s.puts).toEqual([]);
    expect(s.server.layout!.type).toBe("bars");
    expect(s.server.layout!.scale).toBe("log");
    expect((await stored(page))!.scale).toBe("log");
  });

  test("раскладка не загрузилась (502): ничего не отправляется, загрузка повторяется и применяет раскладку сервера", async ({ page }) => {
    const s = await setup(page, (n) => (n === 1 ? "fail" : "ok"));
    await page.goto("/chart/BTCUSDT/4h");
    await expect(canvas(page)).toBeVisible();
    await page.waitForTimeout(1500);
    expect(s.puts).toEqual([]);
    await expect.poll(() => s.gets(), { timeout: 8000 }).toBe(2);
    await expect.poll(async () => (await stored(page))?.type).toBe("bars");
    await page.waitForTimeout(1200);
    expect(s.puts).toEqual([]);
    expect(s.server.layout!.type).toBe("bars");
  });
});
