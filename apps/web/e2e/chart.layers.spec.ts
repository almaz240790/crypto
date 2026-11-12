import { expect, test, type Page, type Route } from "@playwright/test";
import { FIRST_PAGE, H4, T0, mock } from "./helpers/chart";
import { liveSocket, type LiveMock } from "./helpers/live";

/**
 * Слои с сервера (план 2A.4, 2A.10; ADR-0010): структура, зоны, уровни дня, сигналы, паттерны, фигуры и производные
 * перечитываются, когда свеча закрылась потоком, — через паузу, за которую сервер записывает закрытую свечу, а детекторы
 * и планировщик сигналов отрабатывают; сервер ещё без неё (last_t структуры старее) — повтор. Событие сигнала этого
 * инструмента — слои сразу (после короткой склейки пачки событий). Тики открытой свечи ничего не перечитывают.
 */

const iso = (sec: number) => new Date(sec * 1000).toISOString();
/** Время сервера — за 30 с до закрытия текущей свечи FIRST_PAGE. */
const NOW = T0 + (FIRST_PAGE + 1) * H4 - 30;
const INSTRUMENT_ID = 1;
const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
const count = (calls: string[], path: string) => calls.filter((c) => c.startsWith(path) && !c.includes("before=") && !c.includes("until=")).length;

type El = HTMLElement & { __chart: { panes(): { getSeries(): { data(): unknown[] }[] }[] } };
const mainBars = (page: Page) => page.evaluate(() => (document.querySelector('[data-testid="terminal"]') as El).__chart.panes()[0]!.getSeries()[0]!.data().length);

/** История 4h как у API: закрытые 0…n−1, текущая n, время сервера и последняя учтённая минута. */
async function candlesRoute(page: Page, n: number) {
  const bar = (i: number) => {
    const o = 100 + Math.sin(i / 7) * 5;
    const c = o + Math.cos(i / 5);
    return { t: T0 + i * H4, o: o.toFixed(1), h: (Math.max(o, c) + 1).toFixed(1), l: (Math.min(o, c) - 1).toFixed(1), c: c.toFixed(1), v: "1000", open: false };
  };
  await page.route("**/v1/chart/candles?**", (route) => {
    const u = new URL(route.request().url());
    if (u.searchParams.get("before")) return json(route, { symbol: "BTCUSDT", tf: "4h", candles: [], current: null, has_older: false, tick_size: "0.1", server_time: "" });
    return json(route, { symbol: "BTCUSDT", tf: "4h", candles: Array.from({ length: n }, (_, k) => bar(k)), current: { ...bar(n), open: true }, has_older: false, tick_size: "0.1", server_time: iso(NOW), through: NOW - 90 });
  });
  return bar;
}

/** Слои с instrument_id; lastT — начало последней закрытой свечи, по которой «сервер» построил структуру. */
async function layersRoute(page: Page, calls: string[], lastT: () => number) {
  await page.route("**/v1/chart/layers?**", (route) => {
    const u = new URL(route.request().url());
    calls.push(`${u.pathname}?${u.searchParams.toString()}`);
    return json(route, {
      symbol: "BTCUSDT",
      instrument_id: INSTRUMENT_ID,
      tf: "4h",
      structure: { tf: "4h", strategy_version: "1.2.0", last_t: lastT(), complete: true, swings: [], events: [], zones: [], levels: {}, equal_levels: [], sweeps: [], bias: null, atr: "1.8" },
      signals: [{ id: "s1", version: "1.2.0", dir: "long", t: T0 + 250 * H4, status: "active", grade: "A", entry: "100", sl: "95", tp: ["105", "110", "120"], zone: null, events: [], be: false }],
      server_time: "",
    });
  });
}

async function open(page: Page, calls: string[], lastT: () => number): Promise<{ live: LiveMock; bar: (i: number) => { c: string } }> {
  await page.clock.install({ time: new Date(NOW * 1000) });
  await page.clock.resume();
  const live = await liveSocket(page, { ticks: false, at: () => NOW });
  await mock(page, calls, true);
  const bar = await candlesRoute(page, FIRST_PAGE);
  await layersRoute(page, calls, lastT);
  await page.goto("/chart/BTCUSDT/4h");
  await expect(page.getByTestId("terminal").locator("canvas").first()).toBeVisible();
  await expect.poll(() => live.subs.length).toBe(1);
  await expect.poll(() => mainBars(page)).toBe(FIRST_PAGE + 1);
  await expect.poll(() => count(calls, "/v1/chart/layers")).toBe(1);
  return { live, bar };
}

/** Поток закрывает текущую свечу FIRST_PAGE: её последняя минута и первая минута следующей. */
function closeCurrent(live: LiveMock, last: string) {
  live.send({ t: "candle", s: "BTCUSDT", tf: "1m", c: { t: T0 + (FIRST_PAGE + 1) * H4 - 60, o: last, h: last, l: last, c: last, v: "1" } });
  live.send({ t: "candle", s: "BTCUSDT", tf: "1m", c: { t: T0 + (FIRST_PAGE + 1) * H4, o: "150", h: "151", l: "149", c: "150.5", v: "5" } });
}

test("свеча закрылась потоком — слои, паттерны, фигуры и производные перечитываются один раз; тики — нет (OVL-1)", async ({ page }) => {
  const calls: string[] = [];
  // до закрытия структура сервера — по свече FIRST_PAGE − 1, после — уже по закрытой FIRST_PAGE
  const { live, bar } = await open(page, calls, () => (count(calls, "/v1/chart/layers") <= 1 ? T0 + (FIRST_PAGE - 1) * H4 : T0 + FIRST_PAGE * H4));
  try {
    // тики открытой свечи и время внутри неё — ничего не перечитывают
    live.send({ t: "tick", s: "BTCUSDT", p: "101.5", at: iso(NOW) });
    await page.clock.fastForward(25_000);
    await page.waitForTimeout(500);
    expect(count(calls, "/v1/chart/layers")).toBe(1);
    expect(count(calls, "/v1/chart/patterns")).toBe(1);

    closeCurrent(live, bar(FIRST_PAGE).c);
    await expect.poll(() => mainBars(page)).toBe(FIRST_PAGE + 2);
    // сразу после закрытия — не раньше, чем сервер запишет свечу и детекторы отработают
    await page.waitForTimeout(500);
    expect(count(calls, "/v1/chart/layers")).toBe(1);
    await page.clock.fastForward(21_000);
    await expect.poll(() => count(calls, "/v1/chart/layers")).toBe(2);
    await expect.poll(() => count(calls, "/v1/chart/patterns")).toBe(2);
    await expect.poll(() => count(calls, "/v1/chart/figures")).toBe(2);
    await expect.poll(() => count(calls, "/v1/chart/derivatives")).toBe(2);
    // структура сервера уже по закрытой свече — повторов нет
    await page.clock.fastForward(45_000);
    await page.waitForTimeout(500);
    expect(count(calls, "/v1/chart/layers")).toBe(2);
  } finally {
    live.dispose();
  }
});

test("сервер ещё без закрытой свечи (last_t старее) — слои перечитываются ещё раз, пока не догонит (OVL-1, OVL-3)", async ({ page }) => {
  const calls: string[] = [];
  // первые два ответа — по свече FIRST_PAGE − 1 (до закрытия и сразу после), дальше — по закрытой FIRST_PAGE
  const lastT = () => (count(calls, "/v1/chart/layers") <= 2 ? T0 + (FIRST_PAGE - 1) * H4 : T0 + FIRST_PAGE * H4);
  const { live, bar } = await open(page, calls, lastT);
  try {
    closeCurrent(live, bar(FIRST_PAGE).c);
    await expect.poll(() => mainBars(page)).toBe(FIRST_PAGE + 2);
    await page.clock.fastForward(21_000);
    await expect.poll(() => count(calls, "/v1/chart/layers")).toBe(2);
    await page.clock.fastForward(21_000);
    await expect.poll(() => count(calls, "/v1/chart/layers")).toBe(3);
    await page.clock.fastForward(45_000);
    await page.waitForTimeout(500);
    expect(count(calls, "/v1/chart/layers")).toBe(3);
  } finally {
    live.dispose();
  }
});

test("событие сигнала этого инструмента — слои перечитываются (пачка — один раз), чужого — нет (OVL-1)", async ({ page }) => {
  const calls: string[] = [];
  const { live } = await open(page, calls, () => T0 + (FIRST_PAGE - 1) * H4);
  try {
    live.send({ t: "signal", id: "other", instrument_id: INSTRUMENT_ID + 1, status: "tp1_hit", at: iso(NOW) });
    await page.clock.fastForward(2_000);
    await page.waitForTimeout(500);
    expect(count(calls, "/v1/chart/layers")).toBe(1);
    // трекер догнал несколько событий сразу: цель 1 этого сигнала и новый статус другого сигнала инструмента
    live.send({ t: "signal", id: "s1", instrument_id: INSTRUMENT_ID, status: "tp1_hit", at: iso(NOW) });
    live.send({ t: "signal", id: "s9", instrument_id: INSTRUMENT_ID, status: "active", at: iso(NOW) });
    await page.clock.fastForward(2_000);
    await expect.poll(() => count(calls, "/v1/chart/layers")).toBe(2);
    await page.waitForTimeout(500);
    expect(count(calls, "/v1/chart/layers")).toBe(2);
  } finally {
    live.dispose();
  }
});
