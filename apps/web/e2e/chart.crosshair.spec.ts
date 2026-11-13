import { devices, expect, test, type Page } from "@playwright/test";
import { H4, T0, chartSettled, mock } from "./helpers/chart";

/**
 * Перекрестие на телефоне (ADR-0009, дополнение 2026-11-13; жалоба владельца «Мешает … с верху»): данные свечи под
 * пальцем — в строке состояния над графиком (на время перекрестия вместо цены и тренда), а не карточкой поверх верхних
 * свечей. Высота графика не меняется, «×» в строке убирает перекрестие, значения индикаторов — списком по нажатию.
 * Ландшафт и узкий телефон: строка не шире экрана и не переносится в третью строку. Десктоп — без изменений.
 */

type Chart = {
  timeScale(): { width(): number; coordinateToLogical(x: number): number | null; logicalToCoordinate(l: number): number | null };
  paneSize(i: number): { height: number };
  panes(): { getSeries(): { data(): { time: number }[] }[] }[];
};

/** Инструмент заглушки: символ, шаг цены, уровень цен, знаков после точки, объём. */
type Prices = { sym: string; tick: string; base: number; d: number; v: number };
/** Как у BTC (~80 000, шаг 0.1, объём ~100K): длинные цены — худший случай для ширины строки, если их не сократить. */
const BTC: Prices = { sym: "BTCUSDT", tick: "0.1", base: 80000, d: 1, v: 90000 };
/** Как у ETH (~3 300, шаг 0.01): цены той же длины, что у BTC, но короче не становятся (formatPriceShort — от 10 000). */
const ETH: Prices = { sym: "ETHUSDT", tick: "0.01", base: 3300, d: 2, v: 1_230_000 };
/** Монета дешевле цента (1000PEPE, шаг 1e-7 в записи API): самые длинные цены — 9 знаков и короче не становятся. */
const SUBCENT: Prices = { sym: "1000PEPEUSDT", tick: "1.000E-7", base: 0.0049, d: 7, v: 123_456_789 };

const candleOf = (p: Prices) => (i: number) => {
  const k = p.base / 80000;
  const o = p.base + (Math.sin(i / 7) * 4000 + Math.sin(i / 23) * 2500) * k;
  const c = o + Math.cos(i / 5) * 700 * k;
  return { t: T0 + i * H4, o: o.toFixed(p.d), h: (Math.max(o, c) + 320 * k).toFixed(p.d), l: (Math.min(o, c) - 290 * k).toFixed(p.d), c: c.toFixed(p.d), v: String(p.v + (i % 13) * 1300), open: false };
};
const big = candleOf(BTC);

/**
 * Поверх заглушки mock(): свечи в масштабе инструмента (по умолчанию BTC); разметка — только тренд старших ТФ (для
 * строки «Тренд: …»), фигур и паттернов нет — их цены около 100 растянули бы шкалу. Остальное — заглушке.
 */
async function prices(page: Page, p: Prices = BTC) {
  const candle = candleOf(p);
  await page.route("**/v1/chart/**", (route) => {
    const u = new URL(route.request().url());
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (u.pathname === "/v1/chart/candles") {
      const before = u.searchParams.get("before");
      const items = before ? [] : Array.from({ length: 300 }, (_, i) => candle(i));
      return json({ symbol: p.sym, tf: u.searchParams.get("tf"), candles: items, current: before ? null : { ...candle(300), open: true }, has_older: false, tick_size: p.tick, server_time: "" });
    }
    if (u.pathname === "/v1/chart/layers") return json({ symbol: p.sym, tf: "4h", structure: { tf: "4h", strategy_version: "1.2.0", swings: [], events: [], zones: [], levels: {}, equal_levels: [], sweeps: [], bias: { bias: "short", d1_trend: "down", w1_trend: "up", ema50_d1: String(p.base) }, atr: "900" }, signals: [], server_time: "" });
    if (u.pathname === "/v1/chart/figures") return json({ symbol: p.sym, tf: "4h", note: "", items: [], stats: {} });
    if (u.pathname === "/v1/chart/patterns") return json({ symbol: p.sym, tf: "4h", horizon: 5, note: "", items: [], stats: {} });
    return route.fallback();
  });
}

async function open(page: Page, p: Prices = BTC) {
  await mock(page, [], true);
  await prices(page, p);
  await page.goto(`/chart/${p.sym}/4h`);
  const term = page.getByTestId("terminal");
  await expect(term.locator("canvas").first()).toBeVisible();
  // строка состояния с трендом — две строки на телефоне; график успокоился (ширина шкалы цены, вид)
  await expect(strip(page)).toContainText("Тренд");
  await chartSettled(page);
}

const strip = (page: Page) => page.getByLabel("состояние");

/** Геометрия: график (место и высота основной панели) и строка состояния — не должны меняться с перекрестием. */
const geo = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="terminal"]') as HTMLElement & { __chart: Chart };
    const r = el.getBoundingClientRect();
    const st = document.querySelector('[aria-label="состояние"]')!.getBoundingClientRect();
    return { top: r.top, h: r.height, pane: el.__chart.paneSize(0).height, stripTop: st.top, stripH: st.height };
  });

/** Область свечей основной панели (без шкалы цены), координаты страницы. */
const pane = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="terminal"]') as HTMLElement & { __chart: Chart };
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: el.__chart.timeScale().width(), h: el.__chart.paneSize(0).height };
  });

/**
 * Ничего не лежит на области свечей основной панели: карточка «ohlc» с ней не пересекается, а в сетке точек панели
 * верхний элемент — сам график или его собственные подписи (обёртка графика), а не что-то снаружи.
 */
async function expectPaneClear(page: Page) {
  const p = await pane(page);
  const card = await page.getByTestId("ohlc").boundingBox();
  if (card) {
    const overlap = card.x < p.x + p.w && p.x < card.x + card.width && card.y < p.y + p.h && p.y < card.y + card.height;
    expect(overlap, `карточка ${JSON.stringify(card)} на области свечей ${JSON.stringify(p)}`).toBe(false);
  }
  const foreign = await page.evaluate((p) => {
    const wrap = document.querySelector('[data-testid="terminal"]')!.parentElement!;
    const out: string[] = [];
    for (let i = 0; i < 8; i++)
      for (let j = 0; j < 6; j++) {
        const x = p.x + 2 + ((p.w - 4) * i) / 7, y = p.y + 2 + ((p.h - 4) * j) / 5;
        const hit = document.elementFromPoint(x, y);
        if (hit && !wrap.contains(hit)) out.push(`${Math.round(x)},${Math.round(y)}: ${hit.tagName}.${hit.className} «${(hit.textContent ?? "").slice(0, 40)}»`);
      }
    return out;
  }, p);
  expect(foreign, "поверх области свечей").toEqual([]);
}

/** Удержание пальца дольше long-tap LWC (240 мс): липкое перекрестие остаётся после отпускания. */
async function longPress(page: Page, x: number, y: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await page.waitForTimeout(500);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/** Свеча у x страницы (как её выбирает перекрестие LWC: ближайший логический индекс) — номер в генераторе big(). */
const barAt = (page: Page, x: number) =>
  page.evaluate((x) => {
    const el = document.querySelector('[data-testid="terminal"]') as HTMLElement & { __chart: Chart };
    const idx = Math.round(el.__chart.timeScale().coordinateToLogical(x - el.getBoundingClientRect().left)!);
    return el.__chart.panes()[0]!.getSeries()[0]!.data()[idx]!.time;
  }, x);

/** x страницы последней (идущей) свечи и середина области свечей по высоте. */
const lastBar = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="terminal"]') as HTMLElement & { __chart: Chart };
    const r = el.getBoundingClientRect();
    const n = el.__chart.panes()[0]!.getSeries()[0]!.data().length;
    return { x: r.left + el.__chart.timeScale().logicalToCoordinate(n - 1)!, y: r.top + el.__chart.paneSize(0).height * 0.5 };
  });

const group = (n: number, d: number) => {
  const [i, f] = Math.abs(n).toFixed(d).split(".");
  return i!.replace(/\B(?=(\d{3})+(?!\d))/g, " ") + (f ? `.${f}` : "");
};
/** Цена по шагу 0.1 или короткая (целым от 10 000 — formatPriceShort): строка может сжать цены на узком экране. */
const priceRe = (v: string) => `(?:${group(Number(v), 1)}|${group(Number(v), 0)})`;
const DATE = new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const TIME = new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", hour: "2-digit", minute: "2-digit" });
const text = async (page: Page) => ((await page.getByTestId("ohlc").textContent()) ?? "").replace(/\s+/g, " ");

const PHONES = [
  ["iPhone 13", devices["iPhone 13"]],
  ["Pixel 5", devices["Pixel 5"]],
] as const;

for (const [name, device] of PHONES) {
  test.describe(`${name}: перекрестие — в строке над графиком`, () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { defaultBrowserType, ...use } = device;
    test.use(use);

    test("удержание пальца: дата и O/H/L/C/V свечи — в строке состояния, на свечах ничего; график не сдвинулся; × возвращает цену и тренд", async ({ page }) => {
      await open(page);
      const before = await geo(page);
      const p = await pane(page);
      const x = p.x + p.w * 0.35, y = p.y + p.h * 0.3;
      await longPress(page, x, y);
      const ohlc = page.getByTestId("ohlc");
      await expect(ohlc).toBeVisible();
      await expect(page.getByTestId("terminal")).toHaveAttribute("data-sticky", "1");
      // строка значений — внутри строки состояния, цена и тренд на это время не видны
      const sb = (await strip(page).boundingBox())!;
      const ob = (await ohlc.boundingBox())!;
      expect(ob.y).toBeGreaterThanOrEqual(sb.y - 0.5);
      expect(ob.y + ob.height).toBeLessThanOrEqual(sb.y + sb.height + 0.5);
      await expect(strip(page).getByText("до закрытия")).toBeHidden();
      // значения той свечи, на которой палец
      const time = await barAt(page, x);
      const k = big((time - T0) / H4);
      // изменение от открытия — как в легенде десктопа: «+0.62 %», «−0.10 %»
      const ch = ((Number(k.c) - Number(k.o)) / Number(k.o)) * 100;
      const pct = `${Number(Math.abs(ch).toFixed(2)) === 0 ? "" : ch > 0 ? "+" : "−"}${Math.abs(ch).toFixed(2)}`;
      const vol = `${(Number(k.v) / 1000).toFixed(Number(k.v) >= 99_950 ? 0 : 1)}K`;
      const t = await text(page);
      expect(t).toContain(`${DATE.format(new Date(time * 1000))} UTC`);
      for (const [label, v] of [["O", k.o], ["H", k.h], ["L", k.l], ["C", k.c]] as const) expect(t).toMatch(new RegExp(`${label} ${priceRe(v)}(?!\\d)`));
      expect(t).toContain(`${pct} %`);
      expect(t).toContain(`V ${vol}`);
      await expectPaneClear(page);
      // график и строка — на прежнем месте и той же высоты
      expect(await geo(page)).toEqual(before);
      // «×» в строке убирает перекрестие: снова цена и тренд, высота та же
      await ohlc.getByRole("button", { name: "убрать перекрестие" }).tap();
      await expect(ohlc).toHaveCount(0);
      await expect(page.getByTestId("terminal")).not.toHaveAttribute("data-sticky", "1");
      await expect(strip(page).getByText("до закрытия")).toBeVisible();
      await expect(strip(page).getByText(/Тренд/)).toBeVisible();
      expect(await geo(page)).toEqual(before);
    });

    test("значения индикаторов — только по нажатию «индикаторы (n)» в строке; повторное нажатие и конец перекрестия закрывают список", async ({ page }) => {
      await open(page);
      const p = await pane(page);
      await longPress(page, p.x + p.w * 0.5, p.y + p.h * 0.5);
      const ohlc = page.getByTestId("ohlc");
      await expect(ohlc).toBeVisible();
      const list = page.getByTestId("ohlc-values");
      // по умолчанию списка нет — на графике ничего не лежит
      await expect(list).toHaveCount(0);
      await expectPaneClear(page);
      const toggle = ohlc.getByRole("button", { name: /индикаторы \(\d+\)/ });
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await toggle.tap();
      await expect(list).toBeVisible();
      await expect(list).toContainText("EMA");
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      // список — сразу под строкой, а не на месте строки
      const sb = (await strip(page).boundingBox())!;
      expect((await list.boundingBox())!.y).toBeGreaterThanOrEqual(sb.y + sb.height - 1);
      await toggle.tap();
      await expect(list).toHaveCount(0);
      // открыт и перекрестие кончилось (короткое касание графика ниже списка) — списка и строки значений нет
      await toggle.tap();
      await expect(list).toBeVisible();
      const cdp = await page.context().newCDPSession(page);
      const tx = p.x + p.w * 0.3, ty = p.y + p.h * 0.85;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: tx, y: ty }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await expect(ohlc).toHaveCount(0);
      await expect(list).toHaveCount(0);
    });
  });
}

// ландшафт телефона (высота ≤ 520, ADR-0009 «ландшафт», TSA-5) и узкий телефон: худший случай — идущая свеча (пометка
// «не закрыта») с длинными ценами и кнопкой индикаторов. Цены BTC сокращаются (formatPriceShort, от 10 000), а цены
// ETH и монет дешевле цента — нет: раньше на 360 px пометка обрезалась многоточием до «не з…» и «н…»
const NARROW: { title: string; viewport: { width: number; height: number }; rows: number; prices: Prices }[] = [
  { title: "ландшафт 844×390", viewport: { width: 844, height: 390 }, rows: 1, prices: BTC },
  { title: "узкий телефон 360×740", viewport: { width: 360, height: 740 }, rows: 2, prices: BTC },
  { title: "узкий телефон 360×740, цены ETH", viewport: { width: 360, height: 740 }, rows: 2, prices: ETH },
  { title: "узкий телефон 360×740, монета дешевле цента", viewport: { width: 360, height: 740 }, rows: 2, prices: SUBCENT },
  { title: "ландшафт 667×375 (iPhone SE), монета дешевле цента", viewport: { width: 667, height: 375 }, rows: 1, prices: SUBCENT },
];
for (const { title, viewport, rows, prices: p } of NARROW) {
  test.describe(title, () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { defaultBrowserType, ...pixel5 } = devices["Pixel 5"];
    test.use({ ...pixel5, viewport });

    test(`строка перекрестия не шире экрана и не больше ${rows === 1 ? "одной строки" : "двух строк"}: идущая свеча, длинные цены, «индикаторы» и ×`, async ({ page }) => {
      await open(page, p);
      await expect(page.locator("[data-layout]").first()).toHaveAttribute("data-layout", "phone");
      const before = await geo(page);
      const lb = await lastBar(page);
      await longPress(page, lb.x, lb.y);
      const ohlc = page.getByTestId("ohlc");
      await expect(ohlc).toBeVisible();
      await expect(ohlc).toContainText("не закрыта");
      // время идущей свечи видно всегда (дата — и на метке шкалы времени под перекрестием)
      await expect(ohlc).toContainText(TIME.format(new Date((T0 + 300 * H4) * 1000)));
      await expect(ohlc.getByRole("button", { name: /индикаторы \(\d+\)/ })).toBeVisible();
      await expect(ohlc.getByRole("button", { name: "убрать перекрестие" })).toBeVisible();
      const m = await ohlc.evaluate((el) => {
        const r = el.getBoundingClientRect();
        // видимые листья: подписи и значения строки, кнопки
        const leaves = [...el.querySelectorAll<HTMLElement>("span, strong, button")].filter((x) => x.children.length === 0 && x.getBoundingClientRect().width > 1 && getComputedStyle(x).visibility !== "hidden");
        const boxes = leaves.map((x) => ({ t: x.textContent, ...JSON.parse(JSON.stringify(x.getBoundingClientRect())) }) as { t: string; x: number; y: number; width: number; height: number; top: number; bottom: number; left: number; right: number });
        // строки значений (без кнопок справа) — группы листьев с одной вертикальной серединой текста (разрыв больше 6 px)
        const data = el.querySelector("[data-fit]")!;
        const mids = leaves.filter((x) => data.contains(x)).map((x) => { const b = x.getBoundingClientRect(); return (b.top + b.bottom) / 2; }).sort((a, b) => a - b);
        const lines = mids.filter((v, i) => i === 0 || v - mids[i - 1]! > 6).length;
        const clipped = [...el.querySelectorAll<HTMLElement>("*")].filter((x) => x.scrollWidth > x.clientWidth + 1 && getComputedStyle(x).overflow !== "visible").map((x) => `${x.className}: ${x.scrollWidth} > ${x.clientWidth}`);
        return { r: JSON.parse(JSON.stringify(r)), inner: innerWidth, doc: document.documentElement.scrollWidth, lines, out: boxes.filter((b) => b.left < r.left - 0.5 || b.right > r.right + 0.5 || b.top < r.top - 0.5 || b.bottom > r.bottom + 0.5).map((b) => b.t), clipped };
      });
      expect(m.doc).toBeLessThanOrEqual(m.inner);
      expect(m.r.right).toBeLessThanOrEqual(m.inner);
      expect(m.out, "части строки за её краем").toEqual([]);
      expect(m.clipped, "обрезанный текст").toEqual([]);
      expect(m.lines).toBeLessThanOrEqual(rows);
      await expectPaneClear(page);
      expect(await geo(page)).toEqual(before);
    });
  });
}

test.describe("Pixel 5: инструмент рисования", () => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { defaultBrowserType, ...pixel5 } = devices["Pixel 5"];
  test.use(pixel5);

  test("при удержании пальца с инструментом данные свечи — в строке над графиком, чип шага и «Отменить» открыты; отпустили — снова цена", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "Рисовать" }).tap();
    await page.getByRole("dialog", { name: "Рисование" }).getByRole("button", { name: "Трендовая линия" }).tap();
    const chip = page.getByTestId("draw-chip");
    await expect(chip).toContainText("Нажмите первую точку");
    // «Рисую: Трендовая линия» в нижней строке — график ниже; с этого места высота не меняется
    await chartSettled(page);
    const before = await geo(page);
    const p = await pane(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: p.x + p.w * 0.3, y: p.y + p.h * 0.45 }] });
    await page.waitForTimeout(400);
    // палец стоит: перекрестие LWC — значения в строке состояния; чип ничем не закрыт
    await expect(page.getByTestId("ohlc")).toBeVisible();
    await expectPaneClear(page);
    const bb = (await chip.boundingBox())!;
    const hits = await page.evaluate((bb) => {
      const out: boolean[] = [];
      for (const fx of [0.1, 0.5, 0.9]) for (const fy of [0.2, 0.5, 0.8]) out.push(!!document.elementFromPoint(bb.x + bb.width * fx, bb.y + bb.height * fy)?.closest('[data-testid="draw-chip"]'));
      return out;
    }, bb);
    expect(hits).toEqual(Array(9).fill(true));
    expect(await geo(page)).toEqual(before);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(chip).toContainText("Нажмите вторую точку");
    await expect(page.getByTestId("ohlc")).toHaveCount(0);
    await expect(strip(page).getByText("до закрытия")).toBeVisible();
    await chip.getByRole("button", { name: "Отменить рисунок" }).tap();
    await expect(chip).toHaveCount(0);
  });
});

test("десктоп без изменений: под перекрестием — строка легенды на графике «Откр … Закр»", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mock(page, [], true);
  await prices(page);
  await page.goto("/chart/BTCUSDT/4h");
  const term = page.getByTestId("terminal");
  await expect(term.locator("canvas").first()).toBeVisible();
  await chartSettled(page);
  await expect(page.locator("[data-layout]").first()).toHaveAttribute("data-layout", "desktop");
  const p = await pane(page);
  await page.mouse.move(p.x + p.w * 0.5, p.y + p.h * 0.5, { steps: 4 });
  const ohlc = page.getByTestId("ohlc");
  await expect(ohlc).toContainText("Откр");
  await expect(ohlc).toContainText("Закр");
  // легенда — в обёртке графика (угол основной панели), как до изменения
  expect(await ohlc.evaluate((el) => document.querySelector('[data-testid="terminal"]')!.parentElement!.contains(el))).toBe(true);
  await page.mouse.move(p.x - 40, p.y + 10);
  await expect(ohlc).toHaveCount(0);
});
