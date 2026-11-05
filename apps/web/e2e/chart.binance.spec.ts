import { expect, test, type Page, type Route } from "@playwright/test";
import { BINANCE_MARKET, binanceSocket } from "./helpers/binance";
import { FIRST_PAGE, H4, RICH_C0, T0, mock } from "./helpers/chart";
import { liveSocket } from "./helpers/live";

/**
 * Цена с биржи напрямую (ADR-0010, дополнение): браузер держит одно соединение с Binance USDⓈ-M Futures на все
 * показанные символы; пока биржа свежа, её сделки и минуты — основной источник цены и свечи, тики сервера по символу
 * пропускаются; тихий рынок (сделок нет, соединение отвечает) — по-прежнему биржа; биржа недоступна (геоблок), соединение
 * мертво или сервер видит цену, которой у биржи нет, — цена с сервера, попытки биржи — с паузой 5 → 60 с, а возврат сети —
 * попытка сразу. Биржа здесь — заглушка page.routeWebSocket (helpers/binance): настоящие цены не должны смешиваться с
 * фикстурами; как и настоящая Binance, заглушка шлёт kline и сделки только на рыночный адрес /market/.
 */

type Bar = { time: number; open: number; high: number; low: number; close: number; value?: number };
type El = HTMLElement & { __chart: { panes(): { getSeries(): { data(): Bar[] }[] }[] } };

/** Начало текущей свечи 4h заглушки: время событий — внутри неё. */
const CUR = T0 + FIRST_PAGE * H4;
const iso = (sec: number) => new Date(sec * 1000).toISOString();
const BINANCE_TITLE = '[title="цена с биржи в реальном времени"]';
const SERVER_TITLE = '[title="цена с сервера, раз в секунду"]';

const mainBars = (page: Page, sel = '[data-testid="terminal"]') => page.evaluate((sel) => (document.querySelector(sel) as El).__chart.panes()[0]!.getSeries()[0]!.data(), sel);
const lastBar = async (page: Page, sel?: string) => (await mainBars(page, sel)).at(-1)!;
const state = (page: Page) => page.getByLabel("состояние").first();
async function headerPrice(page: Page): Promise<number> {
  const text = (await state(page).textContent()) ?? "";
  const m = text.match(/цена\s*([0-9][0-9   ,]*\.?[0-9]*)/);
  return m ? Number(m[1]!.replace(/[   ,]/g, "")) : Number.NaN;
}
const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/** Часы событий: время фикстуры внутри текущей свечи, идёт вместе с настоящим (сервер отстаёт на lag секунд). */
function fixtureClock(base = CUR + 600) {
  const start = Date.now();
  return (lag = 0) => base + (Date.now() - start) / 1000 - lag;
}

/** Значения за время ms с шагом 50 мс — сколько раз они менялись. */
async function changes(read: () => Promise<number>, ms: number): Promise<number> {
  const seen: number[] = [];
  for (let t = 0; t < ms; t += 50) {
    seen.push(await read());
    await new Promise((r) => setTimeout(r, 50));
  }
  return seen.filter((v, i) => i > 0 && v !== seen[i - 1]).length;
}

test("биржа напрямую: цена и текущая свеча двигаются несколько раз в секунду, high/low/close — за kline; тики сервера не нужны", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls);
  const now = fixtureClock();
  // сервер — заметно ниже: его тик в свече или шапке был бы виден сразу
  const server = await liveSocket(page, { ticks: false, at: () => now(1), price: () => RICH_C0 - 40 });
  // шаг сделки 0.1 — шаг цены BTCUSDT: каждая сделка видна и в шапке
  const bn = await binanceSocket(page, { at: () => now(), price: (k) => RICH_C0 + 10 + k * 0.1 });
  try {
    await page.goto("/chart/BTCUSDT/4h");
    await expect(page.getByTestId("terminal").locator("canvas").first()).toBeVisible();
    const strip = state(page);
    await expect(strip).toContainText("онлайн");
    await expect(strip.locator(BINANCE_TITLE)).toHaveCount(1);
    // одно соединение с биржей; потоки символа — в адресе
    expect(bn.sockets).toHaveLength(1);
    expect(bn.sockets[0]!.url).toBe(`${BINANCE_MARKET}?streams=btcusdt@kline_1m/btcusdt@aggTrade`);
    // тики сервера идут, пока биржа свежа, — мимо свечи и шапки
    server.state.ticks = true;
    await expect.poll(() => headerPrice(page)).toBeGreaterThan(RICH_C0 + 10);
    // шапка — несколько раз в секунду (≤ 4), свеча графика — каждую сделку (10 в секунду)
    const header = await changes(() => headerPrice(page), 1500);
    expect(header).toBeGreaterThanOrEqual(3);
    expect(header).toBeLessThanOrEqual(7); // не чаще 4 раз в секунду
    expect(await changes(async () => (await lastBar(page)).close, 1000)).toBeGreaterThanOrEqual(5);
    // минута на бирже ушла ниже свечи: low и close свечи — из kline, high — максимум сделок
    const t = Math.floor(now() / 60) * 60;
    bn.state.data = false;
    await page.waitForTimeout(300);
    const hi = bn.state.last.get("BTCUSDT")!;
    bn.kline("BTCUSDT", { t, o: (RICH_C0 + 10).toFixed(2), h: (hi + 0.5).toFixed(2), l: (RICH_C0 - 25).toFixed(2), c: (RICH_C0 - 24).toFixed(2), v: "50" }, now() + 1);
    await expect.poll(async () => (await lastBar(page)).close).toBeCloseTo(RICH_C0 - 24, 2);
    const bar = await lastBar(page);
    expect(bar.time).toBe(CUR);
    expect(bar.low).toBeCloseTo(RICH_C0 - 25, 2);
    expect(bar.high).toBeCloseTo(hi + 0.5, 2);
    expect(await mainBars(page)).toHaveLength(FIRST_PAGE + 1);
    // шапка — close kline (новее последней сделки); тики сервера всё это время шли и не попали ни в шапку, ни в свечу
    await expect.poll(() => headerPrice(page)).toBeCloseTo(RICH_C0 - 24, 0);
    await page.waitForTimeout(1200);
    expect(server.state.sent).toBeGreaterThan(3);
    expect(await headerPrice(page)).toBeCloseTo(RICH_C0 - 24, 0);
    expect((await lastBar(page)).low).toBeCloseTo(RICH_C0 - 25, 2);
  } finally {
    bn.dispose();
    server.dispose();
  }
});

test("1m: закрытая минута с биржи (x = true) — закрытая свеча графика, следующая минута — новая свеча справа", async ({ page }) => {
  const calls: string[] = [];
  const M = 60;
  const now0 = T0 + FIRST_PAGE * M + 20;
  await page.clock.install({ time: new Date(now0 * 1000) });
  await mock(page, calls, true);
  await page.route("**/v1/chart/candles?**", (route) => {
    const u = new URL(route.request().url());
    const bar = (i: number) => ({ t: T0 + i * M, o: "100.0", h: "101.0", l: "99.0", c: "100.5", v: "4", open: false });
    if (u.searchParams.get("before")) return json(route, { symbol: "BTCUSDT", tf: "1m", candles: [], current: null, has_older: false, tick_size: "0.1", server_time: "" });
    return json(route, { symbol: "BTCUSDT", tf: "1m", candles: [...Array.from({ length: FIRST_PAGE }, (_, i) => bar(i)), { ...bar(FIRST_PAGE), c: "100.2", v: "3", open: true }], current: null, has_older: false, tick_size: "0.1", server_time: iso(now0) });
  });
  const server = await liveSocket(page, { ticks: false, at: () => now0 });
  const bn = await binanceSocket(page, { data: false, at: () => now0, price: () => 100 });
  try {
    await page.goto("/chart/BTCUSDT/1m");
    await expect(page.getByTestId("terminal").locator("canvas").first()).toBeVisible();
    await expect.poll(() => bn.sockets.length).toBe(1);
    const cur = T0 + FIRST_PAGE * M;
    bn.kline("BTCUSDT", { t: cur, o: "100.0", h: "100.9", l: "99.6", c: "100.7", v: "5" }, now0 + 1);
    await expect(state(page).locator(BINANCE_TITLE)).toHaveCount(1);
    await expect.poll(async () => (await lastBar(page)).close).toBe(100.7);
    expect(await mainBars(page)).toHaveLength(FIRST_PAGE + 1);
    // минута закрылась на бирже — окончательная; следующая — новая свеча
    bn.kline("BTCUSDT", { t: cur, o: "100.0", h: "101.2", l: "99.6", c: "101.1", v: "9", x: true }, cur + 60);
    bn.kline("BTCUSDT", { t: cur + M, o: "101.1", h: "101.3", l: "101.0", c: "101.2", v: "1" }, cur + 60.3);
    await expect.poll(async () => (await mainBars(page)).length).toBe(FIRST_PAGE + 2);
    const bars = await mainBars(page);
    expect(bars.at(-2)).toMatchObject({ time: cur, open: 100, high: 101.2, low: 99.6, close: 101.1 });
    expect(bars.at(-1)).toMatchObject({ time: cur + M, close: 101.2 });
    const volume = await page.evaluate(() => (document.querySelector('[data-testid="terminal"]') as El).__chart.panes()[0]!.getSeries()[1]!.data().at(-2)!.value);
    expect(volume).toBe(9);
  } finally {
    bn.dispose();
    server.dispose();
  }
});

test("смена символа — SUBSCRIBE/UNSUBSCRIBE в том же соединении; мультичарт — одно соединение на все ячейки", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls);
  const now = fixtureClock();
  const server = await liveSocket(page, { ticks: false, at: () => now(1) });
  const bn = await binanceSocket(page, { at: () => now(), price: (k, s) => (s === "ETHUSDT" ? 150 : 120) + k * 0.01 });
  try {
    await page.goto("/chart/BTCUSDT/4h");
    await expect(state(page).locator(BINANCE_TITLE)).toHaveCount(1);
    await expect.poll(() => headerPrice(page)).toBeGreaterThan(120);
    expect(bn.control).toEqual([]);
    await page.getByLabel("инструмент", { exact: true }).selectOption("ETHUSDT");
    await expect(page).toHaveURL(/\/chart\/ETHUSDT\/4h/);
    // новый символ — первым (его цена раньше), прежний — следом
    await expect.poll(() => bn.control.map((c) => `${c.method} ${(c.params ?? []).join(",")}`)).toEqual(["SUBSCRIBE ethusdt@kline_1m,ethusdt@aggTrade", "UNSUBSCRIBE btcusdt@kline_1m,btcusdt@aggTrade"]);
    expect(bn.sockets).toHaveLength(1);
    expect(bn.openCount()).toBe(1);
    expect(bn.streams()).toEqual(["ethusdt@aggTrade", "ethusdt@kline_1m"]);
    await expect.poll(() => headerPrice(page)).toBeGreaterThan(150);
    await expect(state(page).locator(BINANCE_TITLE)).toHaveCount(1);

    // мультичарт: ячейки BTCUSDT и ETHUSDT — одно соединение (страница загружена заново — своё)
    await page.goto("/multichart");
    const cells = page.getByRole("region", { name: /^график / });
    await expect(cells).toHaveCount(2);
    await expect.poll(() => bn.openCount()).toBe(1);
    expect(bn.streams()).toEqual(["btcusdt@aggTrade", "btcusdt@kline_1m", "ethusdt@aggTrade", "ethusdt@kline_1m"]);
    const price = async (i: number) => Number(((await cells.nth(i).locator('[class*="multiPrice"]').first().textContent()) ?? "").replace(/[^\d.]/g, ""));
    await expect.poll(() => price(0)).toBeGreaterThan(120);
    await expect.poll(() => price(1)).toBeGreaterThan(150);
    const eth = await lastBar(page, '[aria-label="график ETHUSDT 4h"] [data-testid="terminal"]');
    expect(eth.close).toBeGreaterThan(150);
  } finally {
    bn.dispose();
    server.dispose();
  }
});

test("биржа недоступна (геоблок): цена с сервера, подсказка — «с сервера», новая попытка биржи через 5 с", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls);
  const now = fixtureClock();
  const server = await liveSocket(page, { at: () => now(1), price: (k) => RICH_C0 + 5 + k * 0.1 });
  const bn = await binanceSocket(page, { at: () => now(), price: () => RICH_C0 + 50 });
  bn.state.refuse = true;
  try {
    await page.goto("/chart/BTCUSDT/4h");
    const strip = state(page);
    await expect(strip).toContainText("онлайн");
    await expect(strip.locator(SERVER_TITLE)).toHaveCount(1);
    await expect.poll(() => headerPrice(page)).toBeGreaterThan(RICH_C0 + 5);
    const c1 = (await lastBar(page)).close;
    await expect.poll(async () => (await lastBar(page)).close, { timeout: 2000 }).toBeGreaterThan(c1);
    // первая попытка отклонена; следующая — не раньше чем через 5 с
    expect(bn.state.attempts).toHaveLength(1);
    await expect.poll(() => bn.state.attempts.length, { timeout: 9000 }).toBe(2);
    const gap = bn.state.attempts[1]! - bn.state.attempts[0]!;
    expect(gap).toBeGreaterThanOrEqual(4800);
    expect(gap).toBeLessThan(8000);
    await expect(strip.locator(SERVER_TITLE)).toHaveCount(1);
    expect(await headerPrice(page)).toBeLessThan(RICH_C0 + 40);
  } finally {
    bn.dispose();
    server.dispose();
  }
});

test("биржа замолчала (полуоткрытый сокет): цена с сервера (улика сервера или проверка без ответа), соединение заменяется после паузы — снова с биржи", async ({ page }) => {
  test.setTimeout(60_000);
  const calls: string[] = [];
  await mock(page, calls);
  const now = fixtureClock();
  const server = await liveSocket(page, { ticks: false, at: () => now(1), price: (k) => RICH_C0 - 5 + k * 0.01 });
  const bn = await binanceSocket(page, { at: () => now(), price: (k) => RICH_C0 + 10 + k * 0.001 });
  try {
    await page.goto("/chart/BTCUSDT/4h");
    const strip = state(page);
    await expect(strip.locator(BINANCE_TITLE)).toHaveCount(1);
    server.state.ticks = true;
    await expect.poll(() => headerPrice(page)).toBeGreaterThan(RICH_C0 + 10);
    // ни данных, ни ответов на проверку: сервер видит новые цены, которых у биржи нет дольше 3 с, а проверка
    // LIST_SUBSCRIPTIONS (тишина 2 с) остаётся без ответа 3 с — что раньше, то и переключает на сервер
    const silentAt = Date.now();
    bn.state.silent = true;
    await expect(strip.locator(SERVER_TITLE)).toHaveCount(1, { timeout: 8000 });
    expect(Date.now() - silentAt).toBeGreaterThanOrEqual(3000);
    await expect(strip).toContainText("онлайн");
    // тики сервера двигают цену: сервер отстаёт на секунду — close тика старше сделки биржи не откатывает, следующие — идут
    await expect.poll(() => headerPrice(page), { timeout: 4000 }).toBeLessThan(RICH_C0);
    const c1 = (await lastBar(page)).close;
    await expect.poll(async () => (await lastBar(page)).close, { timeout: 3000 }).not.toBe(c1);
    expect((await lastBar(page)).high).toBeGreaterThanOrEqual(RICH_C0 + 10); // high от биржи на месте
    // соединение признано мёртвым (проверка без ответа) — закрыто; новое — после паузы, биржа снова основная
    await expect.poll(() => bn.openCount(), { timeout: 10_000 }).toBe(0);
    bn.state.silent = false;
    await expect.poll(() => bn.sockets.length, { timeout: 10_000 }).toBe(2);
    expect(bn.sockets[1]!.url).toBe(bn.sockets[0]!.url);
    await expect(strip.locator(BINANCE_TITLE)).toHaveCount(1, { timeout: 3000 });
    await expect.poll(() => headerPrice(page)).toBeGreaterThan(RICH_C0 + 10);
    expect(bn.control.some((c) => c.method === "LIST_SUBSCRIPTIONS")).toBe(false); // проверку тишина «съела»
  } finally {
    bn.dispose();
    server.dispose();
  }
});
