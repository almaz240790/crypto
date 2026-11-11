import { expect, test, type Page } from "@playwright/test";
import { FIRST_PAGE, H4, T0, mock } from "./helpers/chart";
import { installStrokes, paneStrokes, type Stroke } from "./helpers/strokes";

/**
 * Процентная шкала (план 2A.3, 2A.4; ADR-0009, дополнение «Процентная шкала: индикаторы на графике цены», 2026-11-11):
 * наложенные индикаторы стоят на своих ценах относительно свечей. LWC в процентном режиме переводит каждую серию шкалы
 * в проценты от её собственного первого видимого значения: EMA, полосы Боллинджера и остальные линии сходились в 0 % у
 * левого края и масштабировались каждая сама по себе — EMA рисовалась выше закрытий, когда она ниже, верхняя полоса —
 * под нижней. Теперь в процентном режиме линии рисует примитив основной серии — по цене через её же шкалу; в линейном
 * и логарифмическом — серии LWC, как раньше. Проверяется нарисованное на холсте (перепись обводок, helpers/strokes).
 */

/** Растущий ряд: около +0.25 % за свечу с волной — EMA 50 заметно ниже закрытий, ширина полос меняется. */
const rising = (i: number) => {
  const base = 100 * Math.exp(i / 400);
  const o = base * (1 + Math.sin(i / 7) * 0.02);
  const c = o * (1.002 + Math.cos(i / 5) * 0.008);
  return { t: T0 + i * H4, o: o.toFixed(2), h: (Math.max(o, c) * 1.004).toFixed(2), l: (Math.min(o, c) * 0.996).toFixed(2), c: c.toFixed(2), v: "1000", open: false };
};
const HISTORY_FROM = -1000;

/** Свечи BTCUSDT — растущий ряд (первая порция и история слева порциями по 500, как у заглушки). */
function risingCandles(page: Page) {
  return page.route("**/v1/chart/candles?**", (route) => {
    const u = new URL(route.request().url());
    if (u.searchParams.get("symbol") !== "BTCUSDT") return route.fallback();
    const before = u.searchParams.get("before");
    const end = before ? Math.round((Number(before) - T0) / H4) : FIRST_PAGE;
    const start = before ? Math.max(HISTORY_FROM, end - 500) : 0;
    const items = Array.from({ length: Math.max(0, end - start) }, (_, k) => rising(start + k));
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ symbol: "BTCUSDT", tf: u.searchParams.get("tf"), candles: items, current: before ? null : { ...rising(end), open: true }, has_older: start > HISTORY_FROM, tick_size: "0.1", server_time: "" }) });
  });
}

const SAVED = {
  layers_v: 5,
  type: "candles",
  indicators: [
    { uid: "ema#1", id: "ema", params: { period: 50 } },
    { uid: "bb#1", id: "bb", params: { period: 20, mult: 2 } },
  ],
  markup: { preset: "clean", overrides: {} },
  panels: [],
  scale: "percent",
  overlay: null,
};
/** Линии панели цены в порядке создания серий: EMA, средняя, верхняя и нижняя полосы Боллинджера. */
const EMA = 0;
const MID = 1;
const UP = 2;
const LO = 3;

async function open(page: Page, saved: Record<string, unknown> = SAVED) {
  await page.addInitScript((saved) => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem("pl-terminal", JSON.stringify(saved));
    localStorage.setItem("pl-panes-hint", "1");
  }, saved);
  await installStrokes(page);
  await mock(page, []);
  await risingCandles(page);
  await page.goto("/chart/BTCUSDT/4h");
  await expect(page.getByTestId("terminal").locator("canvas").first()).toBeVisible();
  await expect(page.getByLabel("состояние")).toContainText("цена");
}

type Pt = { x: number; y: number; value: number; close: number; yClose: number };
/** Линия индикатора: цвет, рисует ли её серия LWC, и где её точки должны стоять — x по шкале времени, y по цене через основную серию. */
type Line = { color: string; visible: boolean; points: Pt[] };
type Now = { mode: number; main: string; bars: number; range: { from: number; to: number } | null; lines: Line[] };

function now(page: Page): Promise<Now> {
  return page.evaluate(() => {
    type S = { seriesType(): string; options(): { color?: string; visible: boolean; lineVisible?: boolean }; data(): { time: number; value?: number; close?: number }[]; priceToCoordinate(p: number): number | null };
    type C = { panes(): { getSeries(): S[] }[]; priceScale(id: string): { options(): { mode: number } }; timeScale(): { width(): number; timeToCoordinate(t: number): number | null; getVisibleLogicalRange(): { from: number; to: number } | null } };
    const chart = (document.querySelector('[data-testid="terminal"]') as HTMLElement & { __chart: C }).__chart;
    const series = chart.panes()[0]!.getSeries();
    // основная серия — свечи или бары (после смены типа она последняя в списке, а не первая)
    const main = series.find((s) => s.seriesType() === "Candlestick" || s.seriesType() === "Bar")!;
    const ts = chart.timeScale();
    const w = ts.width();
    const cv = document.createElement("canvas").getContext("2d")!;
    const norm = (c: string) => {
      cv.strokeStyle = "#000";
      cv.strokeStyle = c;
      return String(cv.strokeStyle);
    };
    const bars = main.data();
    const closes = new Map(bars.map((b) => [b.time, b.close!]));
    const lines = series
      .filter((s) => s.seriesType() === "Line")
      .map((s) => {
        const o = s.options();
        const points: { x: number; y: number; value: number; close: number; yClose: number }[] = [];
        for (const d of s.data()) {
          if (d.value === undefined) continue;
          const x = ts.timeToCoordinate(d.time);
          const y = main.priceToCoordinate(d.value);
          const close = closes.get(d.time);
          if (x === null || y === null || close === undefined || x < 0 || x > w) continue;
          points.push({ x, y, value: d.value, close, yClose: main.priceToCoordinate(close)! });
        }
        // visible — рисует ли линию сама серия LWC: экземпляр не скрыт и линия серии не выключена (процентная шкала)
        return { color: norm(o.color ?? ""), visible: o.visible && o.lineVisible !== false, points };
      });
    return { mode: chart.priceScale("right").options().mode, main: main.seriesType(), bars: bars.length, range: ts.getVisibleLogicalRange(), lines };
  });
}

/** y нарисованной линии цвета color у x: из точек всех ломаных этого цвета — ближайшая к ожидаемой y (у полос цвет общий). */
function paintedAt(strokes: readonly Stroke[], color: string, x: number, y: number): number | null {
  let best: number | null = null;
  for (const s of strokes) {
    if (s.color !== color) continue;
    for (const [px, py] of s.points) if (Math.abs(px - x) <= 0.6 && (best === null || Math.abs(py - y) < Math.abs(best - y))) best = py;
  }
  return best;
}
const polylines = (strokes: readonly Stroke[], color: string) => strokes.filter((s) => s.color === color);
/** n точек равномерно по кадру, с первой и последней. */
const sample = <T,>(a: readonly T[], n: number): T[] => Array.from({ length: Math.min(n, a.length) }, (_, k) => a[Math.round((k * (a.length - 1)) / Math.max(1, Math.min(n, a.length) - 1))]!);

/**
 * Нарисованное совпадает с ценами: у каждой линии на девяти свечах кадра нарисованная y равна
 * main.priceToCoordinate(значение) в пределах 1 px; линия нарисована ровно один раз (у полос общий цвет — две ломаные);
 * скрытая линия (hidden) не нарисована. Ждёт, пока график дорисует (данные, пересчёт индикаторов).
 */
async function expectOnPrices(page: Page, want: { lines: number; hidden?: readonly number[] }): Promise<{ now: Now; strokes: Stroke[] }> {
  let out: { now: Now; strokes: Stroke[] } | null = null;
  await expect(async () => {
    const strokes = await paneStrokes(page);
    const n = await now(page);
    expect(n.lines.length, "линий индикаторов на панели цены").toBe(want.lines);
    const colors = new Map<string, number>();
    n.lines.forEach((line, k) => {
      expect(line.points.length, `линия ${k}: точек в кадре`).toBeGreaterThan(20);
      if (want.hidden?.includes(k)) return;
      colors.set(line.color, (colors.get(line.color) ?? 0) + 1);
      for (const p of sample(line.points, 9)) {
        const y = paintedAt(strokes, line.color, p.x, p.y);
        expect(y, `линия ${k}: у x=${p.x.toFixed(1)} ничего не нарисовано`).not.toBeNull();
        expect(Math.abs(y! - p.y), `линия ${k}, x=${p.x.toFixed(1)}: нарисовано y=${y!.toFixed(2)}, цена ${p.value} стоит на y=${p.y.toFixed(2)}`).toBeLessThanOrEqual(1);
      }
    });
    // каждая линия — одна ломаная: серия LWC и примитив не рисуют её вдвоём
    for (const [color, count] of colors) expect(polylines(strokes, color).length, `ломаных цвета ${color}`).toBe(count);
    for (const k of want.hidden ?? []) if (!colors.has(n.lines[k]!.color)) expect(polylines(strokes, n.lines[k]!.color).length, `скрытая линия ${k} нарисована`).toBe(0);
    out = { now: n, strokes };
  }).toPass({ timeout: 10_000 });
  return out!;
}

/** EMA ниже закрытий там, где её значение ниже; верхняя полоса выше нижней во всём кадре. */
function expectOrder({ now: n, strokes }: { now: Now; strokes: Stroke[] }) {
  const ema = n.lines[EMA]!;
  const below = ema.points.filter((p) => p.value < p.close && p.y - p.yClose > 1.5);
  expect(below.length, "свечей, где EMA ниже закрытия").toBeGreaterThan(20);
  for (const p of below) {
    const y = paintedAt(strokes, ema.color, p.x, p.y);
    expect(y, `EMA у x=${p.x.toFixed(1)}`).not.toBeNull();
    expect(y!, `EMA ${ema.points.length ? p.value : ""} ниже закрытия ${p.close}, а нарисована выше (x=${p.x.toFixed(1)})`).toBeGreaterThan(p.yClose);
  }
  // полосы: верхняя — ломаная, проходящая через ожидаемую точку верхней полосы
  const up = n.lines[UP]!;
  const bands = polylines(strokes, up.color);
  expect(bands.length).toBe(2);
  const probe = up.points[Math.floor(up.points.length / 2)]!;
  const at = (s: Stroke, x: number) => s.points.find(([px]) => Math.abs(px - x) <= 0.6)?.[1] ?? null;
  const upper = bands.find((s) => Math.abs((at(s, probe.x) ?? Infinity) - probe.y) <= 1);
  expect(upper, "ломаная верхней полосы").toBeTruthy();
  const lower = bands.find((s) => s !== upper)!;
  let common = 0;
  for (const [x, y] of upper!.points) {
    const yl = at(lower, x);
    if (yl === null) continue;
    common++;
    expect(y, `верхняя полоса ниже нижней у x=${x.toFixed(1)}`).toBeLessThan(yl);
  }
  expect(common, "общих свечей у полос").toBeGreaterThan(20);
}

const setLogical = (page: Page, r: { from: number; to: number }) =>
  page.evaluate((r) => (document.querySelector('[data-testid="terminal"]') as HTMLElement & { __chart: { timeScale(): { setVisibleLogicalRange(r: { from: number; to: number }): void } } }).__chart.timeScale().setVisibleLogicalRange(r), r);
const setScale = async (page: Page, scale: "linear" | "log" | "percent") => {
  await page.getByRole("button", { name: "Вид", exact: true }).click();
  await page.getByRole("dialog", { name: "Вид" }).getByLabel("шкала").selectOption(scale);
  await page.keyboard.press("Escape");
};
const setType = async (page: Page, type: string) => {
  await page.getByRole("button", { name: "Вид", exact: true }).click();
  await page.getByRole("dialog", { name: "Вид" }).getByLabel("тип графика").selectOption(type);
  await page.keyboard.press("Escape");
};

test("процентная шкала: EMA 50 и полосы Боллинджера стоят на своих ценах — и после прокрутки, масштаба, смены таймфрейма и типа графика", async ({ page }) => {
  await open(page);
  const first = await expectOnPrices(page, { lines: 4 });
  expect(first.now.mode).toBe(2);
  // серии LWC скрыты: в процентном режиме LWC рисовал бы каждую в процентах от её первого видимого значения
  expect(first.now.lines.map((l) => l.visible)).toEqual([false, false, false, false]);
  expectOrder(first);
  // значения в легенде — цены, как раньше (не проценты)
  const lastEma = first.now.lines[EMA]!.points.at(-1)!.value;
  await expect(page.getByTestId("legend")).toContainText(lastEma.toFixed(1));

  // у левого края первой порции: подгружается история слева, EMA пересчитывается на всех свечах
  const box = (await page.getByTestId("terminal").boundingBox())!;
  const cx = box.x + box.width * 0.4;
  const cy = box.y + box.height * 0.5;
  await setLogical(page, { from: 20, to: 130 });
  await expect.poll(async () => (await now(page)).bars).toBe(FIRST_PAGE + 1 + 500);
  const scrolled = await expectOnPrices(page, { lines: 4 });
  expect(scrolled.now.range!.to).toBeLessThan(scrolled.now.bars - 60);
  expectOrder(scrolled);

  // масштаб колесом
  const before = scrolled.now.range!;
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, 300);
  await expect.poll(async () => { const r = (await now(page)).range!; return r.to - r.from; }).toBeGreaterThan((before.to - before.from) * 1.2);
  expectOrder(await expectOnPrices(page, { lines: 4 }));

  // таймфрейм и обратно: свечи заменяются, вид сбрасывается
  await page.getByRole("link", { name: "1Д" }).click();
  await expect(page).toHaveURL(/\/chart\/BTCUSDT\/1d$/);
  expectOrder(await expectOnPrices(page, { lines: 4 }));
  await page.getByRole("link", { name: "4ч" }).click();
  await expect(page).toHaveURL(/\/chart\/BTCUSDT\/4h$/);
  expectOrder(await expectOnPrices(page, { lines: 4 }));

  // тип графика: основная серия пересоздаётся — линии остаются на её шкале
  await setType(page, "bars");
  await expect.poll(async () => (await now(page)).main).toBe("Bar");
  const bars = await expectOnPrices(page, { lines: 4 });
  expect(bars.now.lines.map((l) => l.visible)).toEqual([false, false, false, false]);
  expectOrder(bars);
  await setType(page, "candles");
  await expect.poll(async () => (await now(page)).main).toBe("Candlestick");
  expectOrder(await expectOnPrices(page, { lines: 4 }));
});

test("линейная и логарифмическая шкала: линии рисуют серии LWC; после процентной — та же картинка, нигде не дважды", async ({ page }) => {
  await open(page, { ...SAVED, scale: "linear" });
  const linear = await expectOnPrices(page, { lines: 4 });
  expect(linear.now.mode).toBe(0);
  expect(linear.now.lines.map((l) => l.visible)).toEqual([true, true, true, true]);
  expectOrder(linear);

  await setScale(page, "percent");
  await expect.poll(async () => (await now(page)).mode).toBe(2);
  const percent = await expectOnPrices(page, { lines: 4 });
  expect(percent.now.lines.map((l) => l.visible)).toEqual([false, false, false, false]);
  expectOrder(percent);

  await setScale(page, "log");
  await expect.poll(async () => (await now(page)).mode).toBe(1);
  const log = await expectOnPrices(page, { lines: 4 });
  expect(log.now.lines.map((l) => l.visible)).toEqual([true, true, true, true]);
  expectOrder(log);

  await setScale(page, "percent");
  await expect.poll(async () => (await now(page)).mode).toBe(2);
  expectOrder(await expectOnPrices(page, { lines: 4 }));

  // обратно в линейную: серии LWC видны снова, линии — там же, где до переключений
  await setScale(page, "linear");
  await expect.poll(async () => (await now(page)).mode).toBe(0);
  const back = await expectOnPrices(page, { lines: 4 });
  expect(back.now.lines.map((l) => l.visible)).toEqual([true, true, true, true]);
  for (const k of [EMA, MID, UP, LO]) {
    const a = linear.now.lines[k]!.points;
    const b = back.now.lines[k]!.points;
    expect(b.length).toBe(a.length);
    for (const [i, p] of a.entries()) {
      expect(Math.abs(b[i]!.x - p.x)).toBeLessThan(0.01);
      expect(Math.abs(b[i]!.y - p.y)).toBeLessThan(0.01);
    }
  }
  const ys = (r: { strokes: Stroke[] }, color: string) => polylines(r.strokes, color).flatMap((s) => s.points.map(([, y]) => y)).sort((p, q) => p - q);
  for (const color of new Set(linear.now.lines.map((l) => l.color))) {
    const a = ys(linear, color);
    const b = ys(back, color);
    expect(b.length).toBe(a.length);
    for (const [i, y] of a.entries()) expect(Math.abs(b[i]! - y)).toBeLessThan(0.01);
  }
});

test("процентная шкала: скрыть и показать, параметр, убрать и добавить индикатор — линии на ценах, серии LWC не рисуют", async ({ page }) => {
  await open(page);
  const legend = page.getByTestId("legend");
  const start = await expectOnPrices(page, { lines: 4 });

  // скрыть EMA: её линии нет, полосы на месте
  await legend.getByText("EMA 50").hover();
  await page.getByRole("button", { name: "скрыть EMA 50" }).click();
  const hidden = await expectOnPrices(page, { lines: 4, hidden: [EMA] });
  expect(polylines(hidden.strokes, hidden.now.lines[EMA]!.color).length).toBe(0);
  // скрытая остаётся скрытой и в линейной шкале; остальные снова рисует LWC
  await setScale(page, "linear");
  await expect.poll(async () => (await now(page)).mode).toBe(0);
  const hiddenLinear = await expectOnPrices(page, { lines: 4, hidden: [EMA] });
  expect(hiddenLinear.now.lines.map((l) => l.visible)).toEqual([false, true, true, true]);
  await setScale(page, "percent");
  await expect.poll(async () => (await now(page)).mode).toBe(2);
  await expectOnPrices(page, { lines: 4, hidden: [EMA] });
  // показать — в процентной шкале линию рисует примитив, серия LWC остаётся скрытой
  await legend.getByText("EMA 50").hover();
  await page.getByRole("button", { name: "показать EMA 50" }).click();
  const shown = await expectOnPrices(page, { lines: 4 });
  expect(shown.now.lines.map((l) => l.visible)).toEqual([false, false, false, false]);

  // параметр: EMA 50 → EMA 20 — линия идёт по новым значениям
  await legend.getByText("EMA 50").hover();
  await page.getByRole("button", { name: "настроить EMA 50" }).click();
  const params = page.getByRole("dialog", { name: "Параметры EMA 50" });
  await params.getByLabel("Период EMA 50").fill("20");
  await params.getByLabel("Период EMA 50").press("Enter");
  await expect(legend).toContainText("EMA 20");
  await page.keyboard.press("Escape");
  const ema20 = await expectOnPrices(page, { lines: 4 });
  expect(ema20.now.lines[EMA]!.points.at(-1)!.value).toBeGreaterThan(start.now.lines[EMA]!.points.at(-1)!.value + 1);
  expectOrder(ema20);

  // убрать Боллинджера: его линий нет
  await legend.getByText("BB 20 2").hover();
  await page.getByRole("button", { name: "убрать BB 20 2" }).click();
  const only = await expectOnPrices(page, { lines: 1 });
  expect(polylines(only.strokes, start.now.lines[UP]!.color).length).toBe(0);
  expect(polylines(only.strokes, start.now.lines[MID]!.color).length).toBe(0);

  // добавить SMA в процентной шкале: новая серия сразу скрыта от LWC, линия — на ценах
  await page.getByRole("button", { name: /^Индикаторы/ }).click();
  await page.getByRole("dialog", { name: "Индикаторы" }).getByRole("checkbox", { name: /SMA/ }).check();
  await page.getByRole("button", { name: "Готово" }).click();
  const added = await expectOnPrices(page, { lines: 2 });
  expect(added.now.lines.map((l) => l.visible)).toEqual([false, false]);
  // и в линейной шкале обе — снова серии LWC
  await setScale(page, "linear");
  await expect.poll(async () => (await now(page)).mode).toBe(0);
  const end = await expectOnPrices(page, { lines: 2 });
  expect(end.now.lines.map((l) => l.visible)).toEqual([true, true]);
});
