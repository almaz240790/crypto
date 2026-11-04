import { expect, test, type Page, type Route } from "@playwright/test";
import { FIRST_PAGE, H4, RICH_C0, T0, mock } from "./helpers/chart";
import { liveSocket } from "./helpers/live";

/**
 * Живая свеча (план 2A.3, 2A.7; ADR-0003, ADR-0010) — одна модель: тики раз в секунду (здесь — каждые 250 мс),
 * формирующаяся и закрытые минуты сворачивает автомат LiveBar; догон правого края — одна очередь на поводы: сокет
 * открыт заново, вкладка снова видна при мёртвом или неоткрытом сокете, пропуск в событиях, просрочка.
 *
 * - Цена в шапке и текущая свеча меняются в пределах секунды, high/low расширяются (и тиками, пришедшими раньше
 *   свечей), нового бара внутри интервала нет, вид пользователя не сбрасывается; «онлайн» — пока идут тики.
 * - Сервер закрыл сокет — новое соединение через 3–5 с и ровно один запрос истории, свёрнутые тики не теряются.
 * - Продовые баги с iPhone (PR 139): после фона график стоял на свече получасовой давности при «онлайн» — теперь сокет,
 *   полуоткрытый за время фона, заменяется новым, и история догружается один раз; закрытая минута на 1m заменяет
 *   недописанную свечу; просроченный отсчёт сам догружает историю.
 * Все заглушки сокета — helpers/live (отвечает на ping: иначе сторож соединения переподключался бы каждые ~10 с).
 */

type Range = { from: number; to: number };
type Bar = { time: number; open: number; high: number; low: number; close: number; value?: number };
type El = HTMLElement & {
  __chart: {
    panes(): { getSeries(): { data(): Bar[] }[] }[];
    timeScale(): { getVisibleLogicalRange(): Range | null; setVisibleLogicalRange(r: Range): void };
  };
};

/** Начало текущей (незакрытой) свечи заглушки: время тиков — внутри неё. */
const CUR = T0 + FIRST_PAGE * H4;
const iso = (sec: number) => new Date(sec * 1000).toISOString();
const LOW = RICH_C0 - 20;
/** k-й тик: первый — провал ниже свечи (проверка low), дальше рост на 0.1 (проверка high и close). */
const priceAt = (k: number) => (k === 1 ? LOW : RICH_C0 + 20 + k * 0.1);
const tickAt = (k: number) => CUR + 600 + k * 0.25;

/** Главная серия графика (LWC через __chart): число баров и последний бар. */
function lastBar(page: Page, sel = '[data-testid="terminal"]'): Promise<{ len: number; last: Bar | null }> {
  return page.evaluate((sel) => {
    const d = (document.querySelector(sel) as El).__chart.panes()[0]!.getSeries()[0]!.data();
    return { len: d.length, last: d.at(-1) ?? null };
  }, sel);
}
const mainBars = (page: Page) => page.evaluate(() => (document.querySelector('[data-testid="terminal"]') as El).__chart.panes()[0]!.getSeries()[0]!.data());
const logical = (page: Page) => page.evaluate(() => (document.querySelector('[data-testid="terminal"]') as El).__chart.timeScale().getVisibleLogicalRange());
const setLogical = (page: Page, r: Range) => page.evaluate((r) => (document.querySelector('[data-testid="terminal"]') as El).__chart.timeScale().setVisibleLogicalRange(r), r);
/** Цена в шапке: в группе «состояние» — «цена 123.4» (у десктопа C1 цена — кнопка «Сводки», у телефона — strong). */
async function headerPrice(page: Page): Promise<number> {
  const text = (await page.getByLabel("состояние").first().textContent()) ?? "";
  const m = text.match(/цена\s*([0-9][0-9   ,]*\.?[0-9]*)/);
  return m ? Number(m[1]!.replace(/[   ,]/g, "")) : Number.NaN;
}
const state = (page: Page) => page.getByLabel("состояние").first();
const candleCalls = (calls: string[]) => calls.filter((c) => c.startsWith("/v1/chart/candles") && !c.includes("before=")).length;

async function ready(page: Page) {
  await expect(page.getByTestId("terminal").locator("canvas").first()).toBeVisible();
  await expect(state(page)).toContainText("цена");
}

/** Ответ /v1/chart/candles задерживается: первые тики (и провал цены) приходят раньше свечей (W5). */
async function slowCandles(page: Page, ms: number) {
  await page.route("**/v1/chart/candles**", (route) => new Promise<void>((r) => setTimeout(r, ms)).then(() => route.fallback()));
}

const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

const setVisibility = (page: Page, st: "hidden" | "visible") =>
  page.evaluate((st) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => st });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => st === "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  }, st);

/** Вид на свечах from…to — после первой порции и сброса вида (он повторяется в следующем кадре). */
async function viewAt(page: Page, bars: number, r: Range) {
  await expect.poll(async () => (await mainBars(page)).length).toBe(bars);
  await page.waitForTimeout(300);
  await setLogical(page, r);
  await expect.poll(async () => (await logical(page))?.from).toBeCloseTo(r.from, 1);
}

/**
 * Сервер свечей 4h (PR 139): закрытые 0…n−1 и текущая n (её недописанная версия отличается от окончательной). Как API:
 * время сервера — за 30 с до закрытия текущей, through — последняя закрытая минута (идущая в текущую не входит).
 */
const serverAt = (n: number) => T0 + (n + 1) * H4 - 30;
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
      return json(route, { symbol: "BTCUSDT", tf: "4h", candles: Array.from({ length: srv.n - from }, (_, k) => bar(from + k)), current: partial(srv.n), has_older: from > 0, tick_size: "0.1", server_time: iso(serverAt(srv.n)), through: serverAt(srv.n) - 90 });
    }),
  };
}

/**
 * Часы браузера — время ответа сервера (данные фикстуры — в будущем и в прошлом относительно настоящих часов): с
 * настоящими часами после закрытия текущей свечи фикстуры срабатывал бы догон по просрочке, и счёт запросов зависел бы
 * от скорости прогона. resume — время идёт само (переподключение сокета ждёт таймер).
 */
async function clockAt(page: Page, t: number) {
  await page.clock.install({ time: new Date(t * 1000) });
  await page.clock.resume();
}

test("живая цена: тики каждые 250 мс двигают цену в шапке и текущую свечу, без нового бара и сброса вида", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls);
  // после mock(): обработчик срабатывает первым и передаёт запрос заглушке с задержкой
  await slowCandles(page, 1200);
  const live = await liveSocket(page, { at: tickAt, price: priceAt });
  try {
    await page.goto("/chart/BTCUSDT/4h");
    await expect(page.getByTestId("terminal").locator("canvas").first()).toBeVisible();
    const strip = state(page);
    await expect(strip).toContainText("онлайн");
    // «онлайн» — тик за последние 5 с: подсказка точки говорит, что это значит
    await expect(strip.locator('[title="цена обновляется раз в секунду"]')).toHaveCount(1);
    // пользователь приблизил график: живые обновления вид не трогают
    await expect.poll(async () => (await lastBar(page)).len).toBe(FIRST_PAGE + 1);
    await setLogical(page, { from: 180, to: 305 });
    await page.waitForTimeout(200);
    const view = (await logical(page))!;

    // цена в шапке и close текущей свечи — свежие, в пределах секунды от тика. Опрос — каждые 100 мс: по умолчанию
    // паузы растут до секунды, и смена шапки (раз в секунду) попадала между опросами
    const often = { intervals: [100] };
    await expect.poll(() => headerPrice(page), { timeout: 2000, ...often }).toBeGreaterThan(RICH_C0 + 19);
    await expect.poll(async () => (await lastBar(page)).last!.close, { timeout: 1500, ...often }).toBeGreaterThan(RICH_C0 + 19);
    const p1 = await headerPrice(page);
    const c1 = (await lastBar(page)).last!.close;
    await expect.poll(() => headerPrice(page), { timeout: 1500, ...often }).toBeGreaterThan(p1);
    await expect.poll(async () => (await lastBar(page)).last!.close, { timeout: 1200, ...often }).toBeGreaterThan(c1);

    // свёртка в текущую свечу: тот же бар, low — провал первого тика (он пришёл раньше свечей и не потерялся), high —
    // не ниже close; состояние React (свечи раз в 5 с) текущую на графике назад не откатывает
    expect(live.subs[0]).toEqual(["BTCUSDT"]);
    const { len, last } = await lastBar(page);
    expect(len).toBe(FIRST_PAGE + 1);
    expect(last!.time).toBe(CUR);
    expect(last!.low).toBeCloseTo(LOW, 1);
    expect(last!.high).toBeGreaterThanOrEqual(last!.close);
    expect(Math.abs(last!.close - live.state.last.get("BTCUSDT")!)).toBeLessThan(0.5); // отстаёт не больше чем на пару тиков
    await page.waitForTimeout(5200);
    const after = (await lastBar(page)).last!;
    expect(after.close).toBeGreaterThanOrEqual(last!.close);
    expect((await lastBar(page)).len).toBe(FIRST_PAGE + 1);
    const now = (await logical(page))!;
    expect(now.from).toBeCloseTo(view.from, 1);
    expect(now.to).toBeCloseTo(view.to, 1);
    expect(candleCalls(calls)).toBe(1); // без перезагрузки свечей

    // тики прекратились — через 5 с «без связи», сокет при этом открыт (отвечает на ping — не переподключаемся)
    live.state.ticks = false;
    await expect(strip).toContainText("без связи", { timeout: 8000 });
    await expect(strip.locator('[title="цена обновляется раз в секунду"]')).toHaveCount(0);
    live.state.ticks = true;
    await expect(strip).toContainText("онлайн", { timeout: 2000 });
    expect(live.sockets).toHaveLength(1);
    expect(candleCalls(calls)).toBe(1);
  } finally {
    live.dispose();
  }
});

test("переподключение: сервер закрыл сокет — новое соединение и ровно один запрос истории, вид и свёрнутые тики на месте", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls);
  const live = await liveSocket(page, { at: tickAt, price: priceAt });
  try {
    await page.goto("/chart/BTCUSDT/4h");
    const strip = state(page);
    await expect(strip).toContainText("онлайн");
    await expect.poll(async () => (await lastBar(page)).len).toBe(FIRST_PAGE + 1);
    await setLogical(page, { from: 180, to: 305 });
    await page.waitForTimeout(200);
    const view = (await logical(page))!;
    expect(candleCalls(calls)).toBe(1);

    await live.close();
    await expect(strip).toContainText("без связи", { timeout: 3000 });
    // новое соединение через 3–5 с; когда оно открыто — свежая история с сервера (пропущенные свечи)
    await expect.poll(() => live.sockets.length, { timeout: 8000 }).toBe(2);
    await expect(strip).toContainText("онлайн", { timeout: 3000 });
    await expect.poll(() => candleCalls(calls), { timeout: 3000 }).toBe(2);
    const c1 = (await lastBar(page)).last!.close;
    await expect.poll(async () => (await lastBar(page)).last!.close, { timeout: 1500, intervals: [100] }).toBeGreaterThan(c1);
    const { len, last } = await lastBar(page);
    expect(len).toBe(FIRST_PAGE + 1);
    expect(last!.time).toBe(CUR);
    expect(last!.low).toBeCloseTo(LOW, 1); // свежая история не затёрла свёрнутые тики
    const now = (await logical(page))!;
    expect(now.from).toBeCloseTo(view.from, 1);
    expect(now.to).toBeCloseTo(view.to, 1);
    // ровно один догон на переподключение
    await page.waitForTimeout(1500);
    expect(candleCalls(calls)).toBe(2);
  } finally {
    live.dispose();
  }
});

test("мультичарт: ячейки получают тики своих символов", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls);
  const live = await liveSocket(page, { at: tickAt, price: priceAt });
  try {
    await page.goto("/multichart");
    const cells = page.getByRole("region", { name: /^график / });
    await expect(cells).toHaveCount(2);
    for (const i of [0, 1]) {
      const cell = cells.nth(i);
      await expect(cell.locator("canvas").first()).toBeVisible();
      // цена в заголовке ячейки (CellPrice C1) — из тиков
      await expect.poll(async () => Number(((await cell.locator('[class*="multiPrice"]').first().textContent()) ?? "").replace(/[^\d.]/g, "")), { timeout: 3000 }).toBeGreaterThan(RICH_C0 + 19);
    }
    const first = await lastBar(page, '[aria-label="график BTCUSDT 4h"] [data-testid="terminal"]');
    expect(first.len).toBe(FIRST_PAGE + 1);
    expect(first.last!.close).toBeGreaterThan(RICH_C0 + 19);
  } finally {
    live.dispose();
  }
});

test("фон и возврат: полуоткрытый сокет заменяется, свежие свечи догружаются один раз без повторов, хвост исправлен, вид у края едет за свечами, цена в шапке = последняя свеча", async ({ page }) => {
  const calls: string[] = [];
  await clockAt(page, serverAt(FIRST_PAGE));
  const live = await liveSocket(page, { ticks: false, at: () => serverAt(FIRST_PAGE) });
  await mock(page, calls);
  const srv = { n: FIRST_PAGE, newest: 0 };
  const s = liveServer(page, srv);
  await s.route;
  try {
    await page.goto("/chart/BTCUSDT/4h");
    await ready(page);
    await expect.poll(() => live.subs.length).toBe(1);
    const tick = (p: string, t: number) => live.send({ t: "tick", s: "BTCUSDT", p, at: iso(t) });
    // тик в идущей минуте (позже through ответа) — «онлайн»
    tick(s.partial(FIRST_PAGE).c, serverAt(FIRST_PAGE));
    await expect(state(page)).toContainText("онлайн");
    expect(srv.newest).toBe(1);
    // поток: последняя минута текущей сворачивается в неё, минута следующей свечи закрывает текущую (недописанной) и
    // открывает новую — минуты идут подряд за through, догона нет; цена из потока новее истории
    const p = s.partial(FIRST_PAGE);
    live.send({ t: "candle", s: "BTCUSDT", tf: "1m", c: { t: T0 + (FIRST_PAGE + 1) * H4 - 60, o: p.c, h: p.c, l: p.c, c: p.c, v: "1" } });
    live.send({ t: "candle", s: "BTCUSDT", tf: "1m", c: { t: T0 + (FIRST_PAGE + 1) * H4, o: "150", h: "151", l: "149", c: "150.5", v: "5" } });
    live.send({ t: "price", s: "BTCUSDT", p: "150.5", at: iso(T0 + (FIRST_PAGE + 1) * H4 + 60) });
    await expect.poll(async () => (await mainBars(page)).length).toBe(FIRST_PAGE + 2);
    await expect.poll(() => headerPrice(page)).toBe(150.5);
    expect(srv.newest).toBe(1);
    const lastBefore = (await mainBars(page)).length - 1;
    const r0 = (await logical(page))!;
    expect(r0.to).toBeGreaterThanOrEqual(lastBefore);

    // приложение ушло в фон: поток молчит, iOS держит сокет «открытым» (ни данных, ни pong), сервер ушёл на 30 свечей
    live.state.halfOpen = true;
    await setVisibility(page, "hidden");
    srv.n = FIRST_PAGE + 30;
    await page.clock.fastForward(6000);
    await page.waitForTimeout(300);
    expect(srv.newest).toBe(1);
    // вкладка снова видна: сокет молчит дольше 5 с — новый сокет сразу, история — когда он открыт, один раз
    live.state.halfOpen = false;
    await setVisibility(page, "visible");
    await expect.poll(() => live.sockets.length).toBe(2);
    await expect.poll(() => srv.newest).toBe(2);
    await expect.poll(async () => (await mainBars(page)).at(-1)?.time).toBe(T0 + (FIRST_PAGE + 30) * H4);
    const bars = await mainBars(page);
    expect(bars).toHaveLength(FIRST_PAGE + 31);
    for (let i = 1; i < bars.length; i++) expect(bars[i]!.time).toBeGreaterThan(bars[i - 1]!.time);
    // свеча, закрытая потоком с недописанной ценой, и свеча из потока заменены окончательными
    expect(bars[FIRST_PAGE]!.close).toBe(Number(s.bar(FIRST_PAGE).c));
    expect(bars[FIRST_PAGE + 1]!.close).toBe(Number(s.bar(FIRST_PAGE + 1).c));
    // шапка и последняя свеча согласны: история новее цены из потока
    await expect.poll(() => headerPrice(page)).toBe(Number(s.partial(FIRST_PAGE + 30).c));
    expect(bars.at(-1)!.close).toBe(Number(s.partial(FIRST_PAGE + 30).c));
    // вид был у правого края — последняя свеча снова в кадре, ширина та же (до полсвечи: другие цены — шкала цены может
    // стать на пиксель шире, а шаг свечей LWC сохраняет)
    const r1 = (await logical(page))!;
    expect(r1.to).toBeGreaterThanOrEqual(FIRST_PAGE + 30);
    expect(Math.abs(r1.to - r1.from - (r0.to - r0.from))).toBeLessThan(0.5);
    await page.waitForTimeout(800);
    expect(srv.newest).toBe(2);

    // сервер закрыл сокет и он переподключился — минуты за обрыв догружаются историей
    srv.n = FIRST_PAGE + 31;
    await live.close();
    await expect.poll(() => live.sockets.length, { timeout: 10_000 }).toBe(3);
    await expect.poll(() => srv.newest, { timeout: 10_000 }).toBe(3);
    await expect.poll(async () => (await mainBars(page)).at(-1)?.time).toBe(T0 + (FIRST_PAGE + 31) * H4);
    tick(s.partial(FIRST_PAGE + 31).c, serverAt(FIRST_PAGE + 31));
    await expect(state(page)).toContainText("онлайн");
  } finally {
    live.dispose();
  }
});

test("фон дольше свечи: новый сокет открывается медленно — просрочка не догоняет отдельно, догон один (по его открытию)", async ({ page }) => {
  const calls: string[] = [];
  await clockAt(page, serverAt(FIRST_PAGE));
  const live = await liveSocket(page, { ticks: false, at: () => serverAt(FIRST_PAGE) });
  await mock(page, calls);
  const srv = { n: FIRST_PAGE, newest: 0 };
  const s = liveServer(page, srv);
  await s.route;
  try {
    await page.goto("/chart/BTCUSDT/4h");
    await ready(page);
    await expect.poll(() => live.subs.length).toBe(1);
    live.send({ t: "tick", s: "BTCUSDT", p: s.partial(FIRST_PAGE).c, at: iso(serverAt(FIRST_PAGE)) });
    await expect(state(page)).toContainText("онлайн");
    // фон на две свечи: сокет полуоткрыт, текущая свеча давно просрочена
    live.state.halfOpen = true;
    await setVisibility(page, "hidden");
    srv.n = FIRST_PAGE + 2;
    await page.clock.fastForward(2 * H4 * 1000);
    await page.waitForTimeout(300);
    expect(srv.newest).toBe(1);
    // возврат: рукопожатие нового сокета — 1,5 с (таймер просрочки за это время срабатывает раз), догон — по открытию
    live.state.halfOpen = false;
    live.state.openDelay = 1500;
    await setVisibility(page, "visible");
    await expect.poll(() => live.sockets.length).toBe(2);
    await expect.poll(() => srv.newest, { timeout: 5000 }).toBe(2);
    await expect.poll(async () => (await mainBars(page)).at(-1)?.time).toBe(T0 + (FIRST_PAGE + 2) * H4);
    await page.waitForTimeout(2500);
    expect(srv.newest).toBe(2);
  } finally {
    live.dispose();
  }
});

test("вид в истории при догоне остаётся на тех же свечах (вкладка видна, сокета нет — история сразу)", async ({ page }) => {
  const calls: string[] = [];
  await clockAt(page, serverAt(FIRST_PAGE));
  const live = await liveSocket(page, { ticks: false, at: () => serverAt(FIRST_PAGE) });
  live.state.refuse = true;
  await mock(page, calls);
  const srv = { n: FIRST_PAGE, newest: 0 };
  await liveServer(page, srv).route;
  try {
    await page.goto("/chart/BTCUSDT/4h");
    await ready(page);
    await viewAt(page, FIRST_PAGE + 1, { from: 150, to: 230 });
    expect(srv.newest).toBe(1);
    srv.n = FIRST_PAGE + 20;
    await setVisibility(page, "hidden");
    await setVisibility(page, "visible");
    await expect.poll(() => srv.newest).toBe(2);
    await expect.poll(async () => (await mainBars(page)).length).toBe(FIRST_PAGE + 21);
    await page.waitForTimeout(300);
    const r = (await logical(page))!;
    expect(r.from).toBeCloseTo(150, 1);
    expect(r.to).toBeCloseTo(230, 1);
  } finally {
    live.dispose();
  }
});

test("просроченный отсчёт: новой свечи нет дольше её закрытия — история догружается сама, отсчёт — от новой свечи", async ({ page }) => {
  const calls: string[] = [];
  // часы браузера — за 20 с до закрытия текущей свечи 4h; потока нет (сокета нет)
  await page.clock.install({ time: new Date((T0 + (FIRST_PAGE + 1) * H4 - 20) * 1000) });
  const live = await liveSocket(page, { ticks: false, at: () => 0 });
  live.state.refuse = true;
  await mock(page, calls);
  const srv = { n: FIRST_PAGE, newest: 0 };
  await liveServer(page, srv).route;
  try {
    await page.goto("/chart/BTCUSDT/4h");
    await ready(page);
    const countdown = page.getByTestId("countdown");
    await expect(countdown).toHaveText(/^0:[0-2]\d$/);
    expect(srv.newest).toBe(1);
    // свеча закрылась, поток молчит: через запас в несколько секунд — запрос свежих свечей
    srv.n = FIRST_PAGE + 1;
    await page.clock.runFor(35_000);
    await expect.poll(() => srv.newest).toBe(2);
    await expect.poll(async () => (await mainBars(page)).at(-1)?.time).toBe(T0 + (FIRST_PAGE + 1) * H4);
    // отсчёт — уже от новой свечи, а не «0:00»
    await expect(countdown).toHaveText(/^3:59:\d\d$/);
    // пока новая не просрочена — без лишних запросов
    await page.clock.runFor(20_000);
    expect(srv.newest).toBe(2);
  } finally {
    live.dispose();
  }
});

test("1m: закрытая минута заменяет недописанную свечу с тем же временем (объём не складывается), следующая — новая свеча; отсчёт — до закрытия идущей минуты", async ({ page }) => {
  const calls: string[] = [];
  const M = 60;
  const now0 = T0 + FIRST_PAGE * M + 20;
  await page.clock.install({ time: new Date(now0 * 1000) });
  const live = await liveSocket(page, { ticks: false, at: () => now0 });
  await mock(page, calls, true);
  // как API на 1m: текущей нет, последняя хранимая минута ещё идёт — помечена open
  await page.route("**/v1/chart/candles?**", (route) => {
    const u = new URL(route.request().url());
    const bar = (i: number) => ({ t: T0 + i * M, o: "100.0", h: "101.0", l: "99.0", c: "100.5", v: "4", open: false });
    if (u.searchParams.get("before")) return json(route, { symbol: "BTCUSDT", tf: "1m", candles: [], current: null, has_older: false, tick_size: "0.1", server_time: "" });
    return json(route, { symbol: "BTCUSDT", tf: "1m", candles: [...Array.from({ length: FIRST_PAGE }, (_, i) => bar(i)), { ...bar(FIRST_PAGE), c: "100.2", v: "3", open: true }], current: null, has_older: false, tick_size: "0.1", server_time: iso(now0) });
  });
  try {
    await page.goto("/chart/BTCUSDT/1m");
    await ready(page);
    await expect.poll(() => live.subs.length).toBe(1);
    live.send({ t: "tick", s: "BTCUSDT", p: "100.3", at: iso(now0) });
    await expect(state(page)).toContainText("онлайн");
    await expect.poll(async () => (await mainBars(page)).length).toBe(FIRST_PAGE + 1);
    const volume = () => page.evaluate(() => (document.querySelector('[data-testid="terminal"]') as El).__chart.panes()[0]!.getSeries()[1]!.data().at(-1)!.value);
    expect(await volume()).toBe(3);
    // минута закрылась (часы — уже в следующей), поток приносит её окончательной
    await page.clock.fastForward(45_000);
    live.send({ t: "candle", s: "BTCUSDT", tf: "1m", c: { t: T0 + FIRST_PAGE * M, o: "100.0", h: "106.0", l: "99.5", c: "105.5", v: "10" } });
    await expect.poll(async () => (await mainBars(page)).at(-1)?.close).toBe(105.5);
    expect(await mainBars(page)).toHaveLength(FIRST_PAGE + 1);
    expect(await volume()).toBe(10);
    // на 1m после закрытой минуты отсчёт — до закрытия идущей минуты, а не «0:00»: на шкале и в «Сводке»
    await expect(page.getByTestId("countdown")).toHaveText(/^0:[1-5]\d$/);
    await page.getByTitle("Сводка по инструменту").click();
    await expect(page.getByRole("dialog", { name: "Сводка" })).toContainText(/До закрытия свечи\s*0:[1-5]\d/);
    await page.keyboard.press("Escape");
    live.send({ t: "candle", s: "BTCUSDT", tf: "1m", c: { t: T0 + (FIRST_PAGE + 1) * M, o: "105.5", h: "107.0", l: "105.0", c: "106.5", v: "7" } });
    await expect.poll(async () => (await mainBars(page)).length).toBe(FIRST_PAGE + 2);
    expect((await mainBars(page)).at(-1)).toMatchObject({ time: T0 + (FIRST_PAGE + 1) * M, close: 106.5 });
    expect(await volume()).toBe(7);
  } finally {
    live.dispose();
  }
});

test("пропуск: тик через интервал — история догружается один раз, пропущенная свеча на месте", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls);
  const bar = (i: number) => {
    const o = 100 + Math.sin(i / 7) * 5;
    return { t: T0 + i * H4, o: o.toFixed(1), h: (o + 2).toFixed(1), l: (o - 2).toFixed(1), c: (o + 0.5).toFixed(1), v: "1000", open: false };
  };
  let page2 = false;
  let requests = 0;
  await page.route("**/v1/chart/candles?**", (route) => {
    const u = new URL(route.request().url());
    if (u.searchParams.get("before")) return json(route, { symbol: "BTCUSDT", tf: "4h", candles: [], current: null, has_older: false, tick_size: "0.1", server_time: "" });
    requests++;
    // после пропуска сервер уже закрыл текущую и следующую свечи
    const n = page2 ? FIRST_PAGE + 2 : FIRST_PAGE;
    return json(route, { symbol: "BTCUSDT", tf: "4h", candles: Array.from({ length: n }, (_, i) => bar(i)), current: { ...bar(n), open: true }, has_older: false, tick_size: "0.1", server_time: "" });
  });
  const live = await liveSocket(page, { ticks: false, at: () => 0 });
  try {
    await page.goto("/chart/BTCUSDT/4h");
    await ready(page);
    await expect.poll(() => live.subs.length).toBe(1);
    live.send({ t: "tick", s: "BTCUSDT", p: "101.0", at: iso(CUR + 60) });
    await expect(state(page)).toContainText("онлайн");
    await expect.poll(async () => (await mainBars(page)).length).toBe(FIRST_PAGE + 1);
    expect(requests).toBe(1);
    // телефон спал: первый тик — уже через интервал (свеча CUR + H4 пропущена) — догон
    page2 = true;
    live.send({ t: "tick", s: "BTCUSDT", p: "102.0", at: iso(CUR + 2 * H4 + 5) });
    await expect.poll(() => requests).toBe(2);
    await expect.poll(async () => (await mainBars(page)).length).toBe(FIRST_PAGE + 3);
    const bars = await mainBars(page);
    for (let i = 1; i < bars.length; i++) expect(bars[i]!.time - bars[i - 1]!.time).toBe(H4);
    expect(bars.at(-1)).toMatchObject({ time: CUR + 2 * H4, close: 102 });
    // дальше тики идут подряд — повторного догона нет
    for (let k = 1; k <= 4; k++) live.send({ t: "tick", s: "BTCUSDT", p: String(102 + k), at: iso(CUR + 2 * H4 + 5 + k) });
    await page.waitForTimeout(1200);
    expect(requests).toBe(2);
    expect((await mainBars(page)).at(-1)!.close).toBe(106);
  } finally {
    live.dispose();
  }
});

test("вкладка видна, страница из кэша, сеть вернулась — при живом сокете без запроса истории", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls);
  const live = await liveSocket(page, { at: tickAt, price: priceAt });
  try {
    await page.goto("/chart/BTCUSDT/4h");
    await ready(page);
    await expect(state(page)).toContainText("онлайн");
    expect(candleCalls(calls)).toBe(1);
    await setVisibility(page, "hidden");
    await setVisibility(page, "visible");
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      window.dispatchEvent(new Event("online"));
    });
    await page.waitForTimeout(1500);
    expect(candleCalls(calls)).toBe(1);
    expect(live.sockets).toHaveLength(1);
  } finally {
    live.dispose();
  }
});
