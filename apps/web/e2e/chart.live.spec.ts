import { expect, test, type Page, type Route, type WebSocketRoute } from "@playwright/test";
import { FIRST_PAGE, H4, T0, mock } from "./helpers/chart";

/**
 * Продовые баги с iPhone (BTCUSDT 1m, 16 индикаторов):
 * 1) «масштаб только по ценам» — наложенные индикаторы и сравнение не растягивают шкалу цены, свечи не сжимаются в полосу;
 * 2) после фона график стоял на свече получасовой давности при «онлайн» — догон истории при возврате вкладки,
 *    переподключении WebSocket и просроченном отсчёте; закрытая минута на 1m заменяет недописанную свечу;
 * 3) заголовки свёрнутых панелей на телефоне налезали друг на друга и на шкалу времени.
 */

type Range = { from: number; to: number };
type Bar = { time: number; open?: number; high?: number; low?: number; close?: number; value?: number };
type El = HTMLElement & {
  __chart: {
    panes(): { getHeight(): number; getHTMLElement(): HTMLElement; getSeries(): { seriesType(): string; data(): Bar[]; coordinateToPrice(y: number): number | null }[] }[];
    timeScale(): { getVisibleLogicalRange(): Range | null; setVisibleLogicalRange(r: Range): void };
  };
};

async function ready(page: Page) {
  await expect(page.getByTestId("terminal").locator("canvas").first()).toBeVisible();
  await expect(page.getByLabel("состояние")).toContainText("цена");
}

const settings = (indicators: { id: string; params: Record<string, number> }[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ layers_v: 5, type: "candles", indicators, markup: { preset: "clean", overrides: {} }, panels: [], scale: "linear", overlay: null, ...extra });

/** Основная серия: время и цены всех свечей. */
const mainBars = (page: Page) => page.evaluate(() => (document.querySelector('[data-testid="terminal"]') as El).__chart.panes()[0]!.getSeries()[0]!.data());

/** Шкала цены основной панели (верх и низ по координатам), свечи в кадре, последние значения линий наложения. */
const scaleInfo = (page: Page) =>
  page.evaluate(() => {
    const ch = (document.querySelector('[data-testid="terminal"]') as El).__chart;
    const pane = ch.panes()[0]!;
    const [main, ...rest] = pane.getSeries();
    const r = ch.timeScale().getVisibleLogicalRange()!;
    const d = main!.data();
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = Math.max(0, Math.ceil(r.from)); i <= Math.min(d.length - 1, Math.floor(r.to)); i++) {
      lo = Math.min(lo, d[i]!.low!);
      hi = Math.max(hi, d[i]!.high!);
    }
    // линии индикаторов (наложенный инструмент около 5000 — не в счёт)
    const lines = rest.filter((s) => s.seriesType() === "Line").map((s) => s.data().at(-1)?.value ?? NaN).filter((v) => v < 1000);
    return { top: main!.coordinateToPrice(0)!, bottom: main!.coordinateToPrice(pane.getHeight())!, lo, hi, lines };
  });

/** Вид на свечах from…to — после первой порции и сброса вида (он повторяется в следующем кадре). */
async function viewAt(page: Page, bars: number, r: Range) {
  await expect.poll(async () => (await mainBars(page)).length).toBe(bars);
  await page.waitForTimeout(300);
  await page.evaluate((r) => (document.querySelector('[data-testid="terminal"]') as El).__chart.timeScale().setVisibleLogicalRange(r), r);
  await expect.poll(() => page.evaluate(() => (document.querySelector('[data-testid="terminal"]') as El).__chart.timeScale().getVisibleLogicalRange()?.from)).toBeCloseTo(r.from, 1);
}

const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
const iso = (t: number) => new Date(t * 1000).toISOString();

test("масштаб только по ценам: дальние наложенные индикаторы и сравнение не растягивают шкалу, свечи не сжимаются", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls);
  // история: до бара 150 цена около 200, дальше около 100 — SMA 200 и Ichimoku у правого края далеко над свечами;
  // наложенный инструмент — около 5000
  await page.route("**/v1/chart/candles?**", (route) => {
    const u = new URL(route.request().url());
    const symbol = u.searchParams.get("symbol") ?? "BTCUSDT";
    const bar = (i: number) => {
      const base = symbol === "ETHUSDT" ? 5000 : i < 150 ? 200 : 100;
      const o = base + Math.sin(i / 7) * 2;
      const c = o + Math.cos(i / 5) * 0.8;
      return { t: T0 + i * H4, o: o.toFixed(1), h: (Math.max(o, c) + 0.5).toFixed(1), l: (Math.min(o, c) - 0.5).toFixed(1), c: c.toFixed(1), v: "1000", open: false };
    };
    if (u.searchParams.get("before")) return json(route, { symbol, tf: "4h", candles: [], current: null, has_older: false, tick_size: "0.1", server_time: "" });
    return json(route, { symbol, tf: "4h", candles: Array.from({ length: FIRST_PAGE }, (_, i) => bar(i)), current: { ...bar(FIRST_PAGE), open: true }, has_older: false, tick_size: "0.1", server_time: "" });
  });
  const far: { id: string; params: Record<string, number> }[] = [
    { id: "sma", params: { period: 200 } },
    { id: "ichimoku", params: {} },
    { id: "ema", params: { period: 150 } },
    { id: "vwap", params: {} },
    { id: "bb", params: {} },
    { id: "keltner", params: {} },
    { id: "supertrend", params: {} },
  ];
  for (const scale of ["linear", "percent"] as const) {
    await page.addInitScript((s) => localStorage.setItem("pl-terminal", s), settings(far, { overlay: "ETHUSDT", scale }));
    await page.goto("/chart/BTCUSDT/4h");
    await ready(page);
    await viewAt(page, FIRST_PAGE + 1, { from: 200, to: 300 });
    await expect.poll(async () => (await scaleInfo(page)).lines.length).toBeGreaterThanOrEqual(7);
    await page.waitForTimeout(300);
    const m = await scaleInfo(page);
    const span = m.hi - m.lo;
    // поля шкалы 8 % сверху и 20 % снизу: свечи занимают 72 % высоты — с запасом на округление
    expect(m.top - m.hi, `${scale}: над свечами`).toBeLessThanOrEqual(span * 0.15);
    expect(m.lo - m.bottom, `${scale}: под свечами`).toBeLessThanOrEqual(span * 0.35);
    expect(m.top, `${scale}: свечи в кадре`).toBeGreaterThan(m.hi);
    expect(m.bottom, `${scale}: свечи в кадре`).toBeLessThan(m.lo);
    // дальний индикатор действительно за краем шкалы: он её не растянул
    expect(Math.max(...m.lines.filter(Number.isFinite)), `${scale}: SMA 200 за верхом шкалы`).toBeGreaterThan(m.top);
  }
});

/** Сервер свечей 4h: закрытые 0…n−1 и текущая n (её недописанная версия отличается от окончательной). */
function liveServer(page: Page, srv: { n: number; newest: number }) {
  const bar = (i: number) => {
    const o = 100 + Math.sin(i / 7) * 5;
    const c = o + Math.cos(i / 5);
    return { t: T0 + i * H4, o: o.toFixed(1), h: (Math.max(o, c) + 1).toFixed(1), l: (Math.min(o, c) - 1).toFixed(1), c: c.toFixed(1), v: "1000", open: false };
  };
  const partial = (i: number) => ({ ...bar(i), c: (Number(bar(i).c) - 0.3).toFixed(1), open: true });
  return {
    bar,
    partial,
    route: page.route("**/v1/chart/candles?**", (route) => {
      const u = new URL(route.request().url());
      if (u.searchParams.get("before")) return json(route, { symbol: "BTCUSDT", tf: "4h", candles: [], current: null, has_older: false, tick_size: "0.1", server_time: "" });
      srv.newest++;
      const from = Math.max(0, srv.n - 500);
      return json(route, { symbol: "BTCUSDT", tf: "4h", candles: Array.from({ length: srv.n - from }, (_, k) => bar(from + k)), current: partial(srv.n), has_older: from > 0, tick_size: "0.1", server_time: iso(T0 + srv.n * H4 + 600) });
    }),
  };
}

const setVisibility = (page: Page, state: "hidden" | "visible") =>
  page.evaluate((st) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => st });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => st === "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);

const headerPrice = (page: Page) => page.getByLabel("состояние").locator("strong").first();

test("фон и возврат: свежие свечи догружаются без повторов, хвост исправлен, вид у края едет за свечами, цена в шапке = последняя свеча", async ({ page }) => {
  const calls: string[] = [];
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/v1\/ws/, (ws) => {
    sockets.push(ws);
    ws.onMessage(() => {});
  });
  await mock(page, calls);
  const srv = { n: FIRST_PAGE, newest: 0 };
  const s = liveServer(page, srv);
  await s.route;
  await page.goto("/chart/BTCUSDT/4h");
  await ready(page);
  await expect(page.getByLabel("состояние")).toContainText("онлайн");
  expect(srv.newest).toBe(1);
  // поток: минута следующей свечи закрывает текущую (с недописанной ценой) и открывает новую; цена из потока новее истории
  sockets[0]!.send(JSON.stringify({ t: "candle", s: "BTCUSDT", tf: "1m", c: { t: T0 + (FIRST_PAGE + 1) * H4, o: "150", h: "151", l: "149", c: "150.5", v: "5" } }));
  sockets[0]!.send(JSON.stringify({ t: "price", s: "BTCUSDT", p: "150.5", at: iso(T0 + (FIRST_PAGE + 1) * H4 + 60) }));
  await expect.poll(async () => (await mainBars(page)).length).toBe(FIRST_PAGE + 2);
  await expect(headerPrice(page)).toHaveText("150.5");
  const lastBefore = (await mainBars(page)).length - 1;
  const r0 = (await page.evaluate(() => (document.querySelector('[data-testid="terminal"]') as El).__chart.timeScale().getVisibleLogicalRange()))!;
  expect(r0.to).toBeGreaterThanOrEqual(lastBefore);

  // приложение ушло в фон: поток молчит, сервер ушёл на 30 свечей вперёд
  await setVisibility(page, "hidden");
  srv.n = FIRST_PAGE + 30;
  await page.waitForTimeout(300);
  expect(srv.newest).toBe(1);
  await setVisibility(page, "visible");
  await expect.poll(() => srv.newest).toBe(2);
  await expect.poll(async () => (await mainBars(page)).at(-1)?.time).toBe(T0 + (FIRST_PAGE + 30) * H4);
  const bars = await mainBars(page);
  expect(bars).toHaveLength(FIRST_PAGE + 31);
  for (let i = 1; i < bars.length; i++) expect(bars[i]!.time).toBeGreaterThan(bars[i - 1]!.time);
  // свеча, закрытая потоком с недописанной ценой, и свеча из потока заменены окончательными
  expect(bars[FIRST_PAGE]!.close).toBe(Number(s.bar(FIRST_PAGE).c));
  expect(bars[FIRST_PAGE + 1]!.close).toBe(Number(s.bar(FIRST_PAGE + 1).c));
  // шапка и последняя свеча согласны: история новее цены из потока
  await expect(headerPrice(page)).toHaveText(s.partial(FIRST_PAGE + 30).c);
  expect(bars.at(-1)!.close).toBe(Number(s.partial(FIRST_PAGE + 30).c));
  // вид был у правого края — последняя свеча снова в кадре, ширина та же
  const r1 = (await page.evaluate(() => (document.querySelector('[data-testid="terminal"]') as El).__chart.timeScale().getVisibleLogicalRange()))!;
  expect(r1.to).toBeGreaterThanOrEqual(FIRST_PAGE + 30);
  expect(r1.to - r1.from).toBeCloseTo(r0.to - r0.from, 1);

  // WebSocket оборвался и переподключился — минуты за обрыв догружаются историей
  srv.n = FIRST_PAGE + 31;
  await sockets[0]!.close();
  await expect.poll(() => sockets.length, { timeout: 10_000 }).toBe(2);
  await expect(page.getByLabel("состояние")).toContainText("онлайн");
  await expect.poll(() => srv.newest, { timeout: 10_000 }).toBe(3);
  await expect.poll(async () => (await mainBars(page)).at(-1)?.time).toBe(T0 + (FIRST_PAGE + 31) * H4);
});

test("вид в истории при догоне остаётся на тех же свечах", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls);
  const srv = { n: FIRST_PAGE, newest: 0 };
  await liveServer(page, srv).route;
  await page.goto("/chart/BTCUSDT/4h");
  await ready(page);
  await viewAt(page, FIRST_PAGE + 1, { from: 150, to: 230 });
  srv.n = FIRST_PAGE + 20;
  await setVisibility(page, "hidden");
  await setVisibility(page, "visible");
  await expect.poll(async () => (await mainBars(page)).length).toBe(FIRST_PAGE + 21);
  await page.waitForTimeout(300);
  const r = (await page.evaluate(() => (document.querySelector('[data-testid="terminal"]') as El).__chart.timeScale().getVisibleLogicalRange()))!;
  expect(r.from).toBeCloseTo(150, 1);
  expect(r.to).toBeCloseTo(230, 1);
});

test("просроченный отсчёт: новой свечи нет дольше её закрытия — история догружается сама", async ({ page }) => {
  const calls: string[] = [];
  // часы браузера — за 20 с до закрытия текущей свечи 4h
  await page.clock.install({ time: new Date((T0 + (FIRST_PAGE + 1) * H4 - 20) * 1000) });
  await mock(page, calls);
  const srv = { n: FIRST_PAGE, newest: 0 };
  await liveServer(page, srv).route;
  await page.goto("/chart/BTCUSDT/4h");
  await ready(page);
  await expect(page.getByLabel("состояние")).toContainText(/до закрытия 0:[0-2]\d/);
  expect(srv.newest).toBe(1);
  // свеча закрылась, поток молчит: через запас в несколько секунд — запрос свежих свечей
  srv.n = FIRST_PAGE + 1;
  await page.clock.runFor(35_000);
  await expect.poll(() => srv.newest).toBe(2);
  await expect.poll(async () => (await mainBars(page)).at(-1)?.time).toBe(T0 + (FIRST_PAGE + 1) * H4);
  // отсчёт — уже от новой свечи, а не «0:00»
  await expect(page.getByLabel("состояние")).toContainText(/до закрытия 3:59:\d\d/);
  // пока новая не просрочена — без лишних запросов
  await page.clock.runFor(20_000);
  expect(srv.newest).toBe(2);
});

test("1m: закрытая минута заменяет недописанную свечу с тем же временем (объём не складывается), следующая — новая свеча", async ({ page }) => {
  const calls: string[] = [];
  const sockets: WebSocketRoute[] = [];
  const M = 60;
  await page.clock.install({ time: new Date((T0 + FIRST_PAGE * M + 20) * 1000) });
  await page.routeWebSocket(/\/v1\/ws/, (ws) => {
    sockets.push(ws);
    ws.onMessage(() => {});
  });
  await mock(page, calls, true);
  // как API на 1m: текущей нет, последняя хранимая минута ещё идёт — помечена open
  await page.route("**/v1/chart/candles?**", (route) => {
    const u = new URL(route.request().url());
    const bar = (i: number) => ({ t: T0 + i * M, o: "100.0", h: "101.0", l: "99.0", c: "100.5", v: "4", open: false });
    if (u.searchParams.get("before")) return json(route, { symbol: "BTCUSDT", tf: "1m", candles: [], current: null, has_older: false, tick_size: "0.1", server_time: "" });
    return json(route, { symbol: "BTCUSDT", tf: "1m", candles: [...Array.from({ length: FIRST_PAGE }, (_, i) => bar(i)), { ...bar(FIRST_PAGE), c: "100.2", v: "3", open: true }], current: null, has_older: false, tick_size: "0.1", server_time: iso(T0 + FIRST_PAGE * M + 20) });
  });
  await page.goto("/chart/BTCUSDT/1m");
  await ready(page);
  await expect(page.getByLabel("состояние")).toContainText("онлайн");
  await expect.poll(async () => (await mainBars(page)).length).toBe(FIRST_PAGE + 1);
  const volume = () => page.evaluate(() => (document.querySelector('[data-testid="terminal"]') as El).__chart.panes()[0]!.getSeries()[1]!.data().at(-1)!.value);
  expect(await volume()).toBe(3);
  // минута закрылась (часы — уже в следующей), поток приносит её окончательной
  await page.clock.runFor(45_000);
  sockets[0]!.send(JSON.stringify({ t: "candle", s: "BTCUSDT", tf: "1m", c: { t: T0 + FIRST_PAGE * M, o: "100.0", h: "106.0", l: "99.5", c: "105.5", v: "10" } }));
  await expect.poll(async () => (await mainBars(page)).at(-1)?.close).toBe(105.5);
  expect(await mainBars(page)).toHaveLength(FIRST_PAGE + 1);
  expect(await volume()).toBe(10);
  // на 1m после закрытой минуты отсчёт — до закрытия идущей минуты, а не «0:00»
  await expect(page.getByLabel("состояние")).toContainText(/до закрытия 0:[1-5]\d/);
  sockets[0]!.send(JSON.stringify({ t: "candle", s: "BTCUSDT", tf: "1m", c: { t: T0 + (FIRST_PAGE + 1) * M, o: "105.5", h: "107.0", l: "105.0", c: "106.5", v: "7" } }));
  await expect.poll(async () => (await mainBars(page)).length).toBe(FIRST_PAGE + 2);
  expect((await mainBars(page)).at(-1)).toMatchObject({ time: T0 + (FIRST_PAGE + 1) * M, close: 106.5 });
  expect(await volume()).toBe(7);
});

test.describe("телефон: панели под графиком", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  /** Заголовки панелей и общая строка: прямоугольники относительно графика, низ последней панели (верх шкалы времени). */
  const heads = (page: Page) =>
    page.evaluate(() => {
      const el = document.querySelector('[data-testid="terminal"]') as El;
      const r0 = el.getBoundingClientRect();
      const ch = el.__chart;
      const rows = [...document.querySelectorAll<HTMLElement>('[data-testid^="pane-"]')].map((x) => {
        const b = x.getBoundingClientRect();
        return { id: x.dataset.testid!, top: b.top - r0.top, bottom: b.bottom - r0.top };
      });
      const panes = ch.panes();
      const total = panes.reduce((a, p) => a + p.getHeight(), 0);
      return { rows, axisTop: panes.at(-1)!.getHTMLElement().getBoundingClientRect().bottom - r0.top, mainShare: panes[0]!.getHeight() / total };
    });
  const noOverlaps = (m: Awaited<ReturnType<typeof heads>>) => {
    const rows = m.rows.slice().sort((a, b) => a.top - b.top);
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.top, `${rows[i - 1]!.id} и ${rows[i]!.id}`).toBeGreaterThanOrEqual(rows[i - 1]!.bottom - 1);
    for (const r of rows) expect(r.bottom, `${r.id} и шкала времени`).toBeLessThanOrEqual(m.axisTop + 1);
    expect(m.mainShare).toBeGreaterThanOrEqual(0.49);
  };

  test("свёрнутые панели не налезают друг на друга и на шкалу времени; без места — одна строка «ещё N панелей»", async ({ page }) => {
    const calls: string[] = [];
    await mock(page, calls, true);
    const ind = ["cci", "obv", "volume", "macd", "rsi", "stoch", "atr"].map((id) => ({ id, params: {} }));
    await page.addInitScript((s) => localStorage.setItem("pl-terminal", s), settings(ind, { panels: ["funding", "oi", "liq", "ls"] }));
    await page.goto("/chart/BTCUSDT/4h");
    await ready(page);
    await expect(page.getByTestId("pane-ls")).toBeVisible();
    // как у владельца: раскрыты шесть панелей, свёрнутые — между ними и внизу
    for (const k of ["cci", "obv", "volume", "macd", "rsi", "funding"]) {
      const b = page.getByTestId(`pane-${k}`).getByRole("button", { name: /развернуть панель/ });
      if (await b.count()) await b.click();
    }
    await expect(page.getByTestId("pane-funding").getByRole("button", { name: /свернуть панель/ })).toBeVisible();
    await page.waitForTimeout(300);
    noOverlaps(await heads(page));
    // телефон боком: строк на все панели нет — свёрнутые в одной строке, раскрытые сверху сворачиваются
    await page.setViewportSize({ width: 844, height: 390 });
    const group = page.getByTestId("pane-group");
    await expect(group).toBeVisible();
    await expect(group).toContainText(/ещё \d+ панел/);
    await page.waitForTimeout(300);
    noOverlaps(await heads(page));
    // кнопка в общей строке раскрывает свою панель
    await group.getByRole("button", { name: "развернуть панель Открытый интерес" }).click();
    await expect(page.getByTestId("pane-oi").getByRole("button", { name: "свернуть панель Открытый интерес" })).toBeVisible();
    await page.waitForTimeout(300);
    noOverlaps(await heads(page));
    // обратно вертикально — у каждой панели своя строка
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(group).toHaveCount(0);
    await page.waitForTimeout(300);
    noOverlaps(await heads(page));
  });
});
