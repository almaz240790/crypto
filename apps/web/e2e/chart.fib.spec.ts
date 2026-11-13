import { expect, test, type Page } from "@playwright/test";
import { H4, T0, chartSettled, mock, painted, type MockServer } from "./helpers/chart";
import { installStrokes, paneStrokes } from "./helpers/strokes";

/**
 * Уровни Фибоначчи: настраиваемый набор и цели по движению (план 2A.5; ADR-0009, «Рисование», дополнение 2026-11-11).
 * В карточке выбранного Фибоначчи «уровни» раскрывают переключатели: «цели по движению» (отрицательные — за второй
 * точкой), «коррекция» (0…1), «за началом» (больше 1). Каждое нажатие — шаг отмены и обычная правка рисунка; набор,
 * выбранный последним, получает следующий Фибоначчи; «стандартные» возвращают уровни по умолчанию.
 */

const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.705, 0.786, 1, 1.272, 1.618];
/** Шаг цены BTCUSDT в заглушке API: подписи уровней — с его точностью, цена в подписи — не дальше половины шага. */
const TICK = 0.1;

type Range = { from: number; to: number };
type Pt = { time: number; price: number };
type Rect = { x: number; y: number; w: number; h: number };
type Stored = { id: string; type: string; points: Pt[]; levels?: number[]; locked: boolean; updated_at: number; deleted_at?: number | null };
type Label = { id: string; text: string; rect: Rect };
type Chart = {
  timeScale(): { getVisibleLogicalRange(): Range | null; width(): number; timeToCoordinate(t: number): number | null };
  paneSize(i: number): { height: number };
  priceScale(id: string): { getVisibleRange(): Range | null; options(): { autoScale: boolean; mode: number } };
  panes(): { getSeries(): { priceToCoordinate(p: number): number | null; data(): { time: number; high?: number; low?: number }[] }[] }[];
};
type Term = HTMLElement & { __chart: Chart; __overlay: () => { drawingLabels: Label[] } };

/** Рисунки гостя — в localStorage (без удалённых). */
const stored = (page: Page) => page.evaluate(() => (JSON.parse(localStorage.getItem("pl-drawings:BTCUSDT") ?? "[]") as Stored[]).filter((d) => !d.deleted_at));
/** Набор уровней для новых Фибоначчи — в настройках терминала. */
const remembered = (page: Page) => page.evaluate(() => (JSON.parse(localStorage.getItem("pl-terminal") ?? "{}") as { fibLevels?: number[] }).fibLevels ?? null);
/** Подписи уровней Фибоначчи, поставленные раскладкой: id — `${рисунок}#L${уровень}`, прямоугольник — в координатах панели. */
const levelLabels = (page: Page) => page.evaluate(() => (document.querySelector('[data-testid="terminal"]') as Term).__overlay().drawingLabels.filter((l) => /#L-?[\d.]+$/.test(l.id)).map((l) => ({ id: l.id, text: l.text, rect: l.rect })));
const labelOf = async (page: Page, id: string, level: number) => (await levelLabels(page)).find((l) => l.id === `${id}#L${level}`) ?? null;
/** Цена из подписи «−0.618 · 104.2» (разряды через пробел, минус типографский). */
const priceOf = (text: string) => Number(text.split(" · ")[1]!.replace(/\s/g, "").replace("−", "-"));
/** y цены в панели — по шкале основной серии (линейной или логарифмической). */
const lineY = (page: Page, price: number) => page.evaluate((price) => (document.querySelector('[data-testid="terminal"]') as Term).__chart.panes()[0]!.getSeries()[0]!.priceToCoordinate(price)!, price);
const view = (page: Page) =>
  page.evaluate(() => {
    const c = (document.querySelector('[data-testid="terminal"]') as Term).__chart;
    const ps = c.priceScale("right");
    return { time: c.timeScale().getVisibleLogicalRange(), price: ps.getVisibleRange(), auto: ps.options().autoScale, mode: ps.options().mode, w: c.timeScale().width(), h: c.paneSize(0).height };
  });
/** Точки рисунка на экране (координаты страницы). */
const onScreen = (page: Page, pts: Pt[]) =>
  page.evaluate((pts) => {
    const el = document.querySelector('[data-testid="terminal"]') as Term;
    const r = el.getBoundingClientRect();
    const s = el.__chart.panes()[0]!.getSeries()[0]!;
    return pts.map((p) => ({ x: r.left + el.__chart.timeScale().timeToCoordinate(p.time)!, y: r.top + s.priceToCoordinate(p.price)! }));
  }, pts);

/**
 * Ход «минимум → максимум» на известных свечах: минимум свечи A и максимум более поздней свечи B (не ближе шести
 * свечей), ход 2.5…4.5 — чтобы уровни от −1 (выше максимума на весь ход) до 2.618 были в видимых ценах. Координаты —
 * страницы: нажатие ровно в цену, магнит ставит точку на минимум и максимум.
 */
const swing = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="terminal"]') as Term;
    const r = el.getBoundingClientRect();
    const c = el.__chart;
    const ts = c.timeScale();
    const s = c.panes()[0]!.getSeries()[0]!;
    const w = ts.width();
    const range = c.priceScale("right").getVisibleRange()!;
    const vis: { time: number; high: number; low: number; x: number }[] = [];
    for (const d of s.data()) {
      const x = ts.timeToCoordinate(d.time);
      if (x !== null && x > w * 0.2 && x < w * 0.7 && d.high !== undefined && d.low !== undefined) vis.push({ time: d.time, high: d.high, low: d.low, x });
    }
    for (let i = 0; i < vis.length; i++)
      for (let j = i + 6; j < vis.length; j++) {
        const a = vis[i]!, b = vis[j]!;
        const move = b.high - a.low;
        if (move < 2.5 || move > 4.5) continue;
        if (b.high + move > range.to - 0.5 || b.high - 2.618 * move < range.from + 0.5) continue;
        return { a: { time: a.time, price: a.low, x: r.left + a.x, y: r.top + s.priceToCoordinate(a.low)! }, b: { time: b.time, price: b.high, x: r.left + b.x, y: r.top + s.priceToCoordinate(b.high)! } };
      }
    return null;
  });

async function open(page: Page, authed = false, server?: MockServer) {
  await mock(page, [], authed, server);
  await page.goto("/chart/BTCUSDT/4h");
  const term = page.getByTestId("terminal");
  await expect(term.locator("canvas").first()).toBeVisible();
  await expect(page.getByTestId("drawings-count")).toHaveText(/рисунков: \d+/);
  // координаты свечей (swing, onScreen) — на успокоившемся виде: точки рисунков сверяются со временем свечи точно
  await chartSettled(page);
  const b = (await term.boundingBox())!;
  return { X: (f: number) => b.x + b.width * f, Y: (f: number) => b.y + b.height * f, box: b };
}

/** Фибоначчи двумя кликами: инструмент из панели рисования, точка A, точка B. */
async function drawFib(page: Page, a: { x: number; y: number }, b: { x: number; y: number }) {
  await page.getByRole("toolbar", { name: "панель рисования" }).getByRole("button", { name: "Фибоначчи" }).click();
  await page.mouse.click(a.x, a.y);
  await page.mouse.click(b.x, b.y);
}

const card = (page: Page) => page.getByRole("region", { name: "выбранный рисунок" });
const panel = (page: Page) => card(page).getByRole("group", { name: "уровни Фибоначчи" });
const toggle = (page: Page, level: string) => panel(page).getByRole("button", { name: level, exact: true });
/** Подпись — у своей линии: над ней (низ строки на 3 px выше) или под ней. */
function expectAtLine(l: Label, y: number) {
  const above = Math.abs(l.rect.y + l.rect.h + 3 - y);
  const below = Math.abs(l.rect.y - 3 - y);
  expect(Math.min(above, below), `${l.text}: подпись у линии y=${y}, прямоугольник ${JSON.stringify(l.rect)}`).toBeLessThanOrEqual(1);
}

/** Заблокированный Фибоначчи на свечах 250…275, цены 99…103 — в памяти устройства до загрузки страницы. */
const LOCKED_FIB = { id: "F1", type: "fib", points: [{ time: T0 + 250 * H4, price: 99 }, { time: T0 + 275 * H4, price: 103 }], style: { color: "text2", width: 1, dashed: false }, locked: true, timeframe: null, updated_at: 1 };
const seedLocked = (page: Page) => page.addInitScript((d) => localStorage.setItem("pl-drawings:BTCUSDT", JSON.stringify([d])), LOCKED_FIB);

test.describe("десктоп, мышь", () => {
  test("цель −0.618 выше максимума, выключение 0.236, отмена и повтор, перезагрузка, новый Фибоначчи с тем же набором, «стандартные»", async ({ page }) => {
    const { X, Y } = await open(page);
    const s = (await swing(page))!;
    expect(s, "на видимых свечах есть ход минимум → максимум").not.toBeNull();
    const low = s.a.price, high = s.b.price;
    await drawFib(page, s.a, s.b);
    await expect(page.getByTestId("drawings-count")).toHaveText("рисунков: 1");
    const d0 = (await stored(page))[0]!;
    // магнит: точки — ровно минимум свечи A и максимум свечи B; уровни — по умолчанию
    expect(d0.points).toEqual([{ time: s.a.time, price: low }, { time: s.b.time, price: high }]);
    expect(d0.levels).toEqual(FIB);
    expect(await remembered(page)).toBeNull();

    // свёрнутая карточка: «уровни» есть, переключателей нет; целей на графике нет
    const more = card(page).getByRole("button", { name: /уровни/ });
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await expect(panel(page)).toHaveCount(0);
    await expect.poll(async () => (await labelOf(page, d0.id, 0.236))?.text ?? null).toMatch(/^0\.236 · /);
    expect((await levelLabels(page)).filter((l) => l.text.startsWith("−"))).toEqual([]);
    const before = await view(page);

    await more.click();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    for (const g of ["цели по движению", "коррекция", "за началом"]) await expect(panel(page).getByRole("group", { name: g })).toBeVisible();
    await expect(panel(page).locator("button[aria-pressed]")).toHaveCount(14);
    await expect(panel(page).locator('button[aria-pressed="true"]')).toHaveText(FIB.map(String));
    await expect(toggle(page, "−0.618")).toHaveAttribute("aria-pressed", "false");

    // включить −0.618: линия и подпись цели — на 61.8 % хода выше максимума
    await toggle(page, "−0.618").click();
    await expect(toggle(page, "−0.618")).toHaveAttribute("aria-pressed", "true");
    const want = high + 0.618 * (high - low);
    await expect.poll(async () => (await labelOf(page, d0.id, -0.618))?.text ?? null).toMatch(/^−0\.618 · \d/);
    const target = (await labelOf(page, d0.id, -0.618))!;
    expect(Math.abs(priceOf(target.text) - want)).toBeLessThanOrEqual(TICK / 2 + 1e-9);
    expect(priceOf(target.text)).toBeGreaterThan(high);
    expectAtLine(target, await lineY(page, want));
    const withTarget = [-0.618, ...FIB];
    expect((await stored(page))[0]!.levels).toEqual(withTarget);
    expect(await remembered(page)).toEqual(withTarget);
    // рисунок шкалу цены не растягивает и вид не двигает (ADR-0003: масштаб только по ценам)
    const after = await view(page);
    expect(after.price).toEqual(before.price);
    expect(after.time).toEqual(before.time);
    expect(after.auto).toBe(true);

    // выключить 0.236: подписи нет; каждое нажатие — правка рисунка (updated_at растёт)
    const t1 = (await stored(page))[0]!.updated_at;
    await toggle(page, "0.236").click();
    await expect(toggle(page, "0.236")).toHaveAttribute("aria-pressed", "false");
    await expect.poll(async () => await labelOf(page, d0.id, 0.236)).toBeNull();
    const off = (await stored(page))[0]!;
    expect(off.levels).toEqual(withTarget.filter((l) => l !== 0.236));
    expect(off.updated_at).toBeGreaterThan(t1);
    expect(await remembered(page)).toEqual(off.levels);

    // Ctrl+Z возвращает 0.236 — и рисунку, и набору для новых; ещё раз — убирает цель; повтор — возвращает
    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await labelOf(page, d0.id, 0.236))?.text ?? null).toMatch(/^0\.236 · /);
    expect((await stored(page))[0]!.levels).toEqual(withTarget);
    await expect.poll(() => remembered(page)).toEqual(withTarget);
    await page.keyboard.press("Control+z");
    await expect.poll(async () => await labelOf(page, d0.id, -0.618)).toBeNull();
    expect((await stored(page))[0]!.levels).toEqual(FIB);
    await expect.poll(() => remembered(page)).toEqual(FIB);
    await page.keyboard.press("Control+Shift+z");
    await expect.poll(async () => (await labelOf(page, d0.id, -0.618))?.text ?? null).toBe(target.text);
    expect((await stored(page))[0]!.levels).toEqual(withTarget);
    await expect.poll(() => remembered(page)).toEqual(withTarget);

    // перезагрузка: набор рисунка тот же
    await page.reload();
    await expect(page.getByTestId("drawings-count")).toHaveText("рисунков: 1");
    await expect.poll(async () => (await labelOf(page, d0.id, -0.618))?.text ?? null).toBe(target.text);
    expect((await labelOf(page, d0.id, 0.236))?.text).toMatch(/^0\.236 · /);
    expect((await stored(page))[0]!.levels).toEqual(withTarget);

    // новый Фибоначчи — с тем же набором: цель −0.618 уже на графике
    await drawFib(page, { x: X(0.12), y: Y(0.56) }, { x: X(0.3), y: Y(0.46) });
    await expect(page.getByTestId("drawings-count")).toHaveText("рисунков: 2");
    const d1 = (await stored(page))[1]!;
    expect(d1.levels).toEqual(withTarget);
    const [p1, p2] = d1.points as [Pt, Pt];
    const want1 = p2.price + 0.618 * (p2.price - p1.price);
    await expect.poll(async () => (await labelOf(page, d1.id, -0.618))?.text ?? null).toMatch(/^−0\.618 · \d/);
    expect(Math.abs(priceOf((await labelOf(page, d1.id, -0.618))!.text) - want1)).toBeLessThanOrEqual(TICK / 2 + 1e-9);

    // «стандартные»: уровни по умолчанию — у выбранного рисунка и у новых; первый рисунок не тронут
    await expect(card(page)).toContainText("Фибоначчи");
    await card(page).getByRole("button", { name: /уровни/ }).click();
    await expect(toggle(page, "−0.618")).toHaveAttribute("aria-pressed", "true");
    await panel(page).getByRole("button", { name: "стандартные" }).click();
    await expect(toggle(page, "−0.618")).toHaveAttribute("aria-pressed", "false");
    await expect(panel(page).locator('button[aria-pressed="true"]')).toHaveText(FIB.map(String));
    await expect.poll(async () => await labelOf(page, d1.id, -0.618)).toBeNull();
    const reset = await stored(page);
    expect(reset[1]!.levels).toEqual(FIB);
    expect(reset[0]!.levels).toEqual(withTarget);
    expect(await remembered(page)).toEqual(FIB);
    await drawFib(page, { x: X(0.12), y: Y(0.3) }, { x: X(0.26), y: Y(0.22) });
    await expect(page.getByTestId("drawings-count")).toHaveText("рисунков: 3");
    expect((await stored(page))[2]!.levels).toEqual(FIB);
  });

  test("логарифмическая шкала: −1 и 2.618 — подпись и выбор на своей цене; промежуток между линиями — не рисунок; шкала от рисунка не растягивается", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("pl-terminal", JSON.stringify({ layers_v: 5, type: "candles", indicators: [{ id: "ema", params: { period: 50 } }], markup: { preset: "clean", overrides: {} }, panels: [], scale: "log", overlay: null })));
    await open(page);
    await expect.poll(async () => (await view(page)).mode).toBe(1);
    const s = (await swing(page))!;
    expect(s).not.toBeNull();
    const low = s.a.price, high = s.b.price, move = high - low;
    await drawFib(page, s.a, s.b);
    const d = (await stored(page))[0]!;
    expect(d.points.map((p) => p.price)).toEqual([low, high]);
    const before = await view(page);
    await card(page).getByRole("button", { name: /уровни/ }).click();
    await toggle(page, "−1").click();
    await toggle(page, "2.618").click();
    await expect(toggle(page, "2.618")).toHaveAttribute("aria-pressed", "true");
    expect((await stored(page))[0]!.levels).toEqual([-1, ...FIB, 2.618]);
    // −1 — на весь ход выше максимума, 2.618 — на 1.618 хода ниже минимума; подписи — у своих линий на лог-шкале
    const wants: Record<number, number> = { [-1]: high + move, [2.618]: high - 2.618 * move };
    for (const level of [-1, 2.618]) {
      const want = wants[level]!;
      await expect.poll(async () => (await labelOf(page, d.id, level))?.text ?? null, `подпись уровня ${level}`).not.toBeNull();
      const l = (await labelOf(page, d.id, level))!;
      expect(l.text.startsWith(level < 0 ? "−1 · " : "2.618 · ")).toBe(true);
      expect(Math.abs(priceOf(l.text) - want)).toBeLessThanOrEqual(TICK / 2 + 1e-9);
      expectAtLine(l, await lineY(page, want));
    }
    // на логарифмической шкале равные ходы цены — не равные отрезки: −1 ближе к максимуму, чем минимум
    const yHigh = await lineY(page, high), yLow = await lineY(page, low), yTarget = await lineY(page, wants[-1]!);
    expect(yHigh - yTarget).toBeLessThan(yLow - yHigh);
    const after = await view(page);
    expect(after.price).toEqual(before.price);
    expect(after.auto).toBe(true);

    // выбор: нажатие по линии уровня за пределами A–B выбирает рисунок, промежуток между линиями — нет
    const [a, b] = await onScreen(page, d.points);
    const top = (await page.getByTestId("terminal").boundingBox())!.y;
    const x = (a!.x + b!.x) / 2;
    await page.keyboard.press("Escape");
    await expect(card(page)).toHaveCount(0);
    await page.mouse.click(x, top + yTarget);
    await expect(card(page)).toContainText("Фибоначчи");
    await page.mouse.click(x, top + (yTarget + yHigh) / 2);
    await expect(card(page)).toHaveCount(0);
    await page.mouse.click(x, top + (await lineY(page, wants[2.618]!)));
    await expect(card(page)).toContainText("Фибоначчи");
    expect((await stored(page))[0]!.points).toEqual(d.points);
    expect((await view(page)).time).toEqual(before.time);
  });

  test("копия на другой инструмент — с уровнями рисунка; рисунок частично за экраном: подписи целей остаются в панели", async ({ page }) => {
    const { X, Y } = await open(page);
    const s = (await swing(page))!;
    await drawFib(page, s.a, s.b);
    const d = (await stored(page))[0]!;
    await card(page).getByRole("button", { name: /уровни/ }).click();
    await toggle(page, "−1").click();
    await toggle(page, "−0.618").click();
    await expect.poll(async () => (await labelOf(page, d.id, -1))?.text ?? null).toMatch(/^−1 · /);
    // копия на другой инструмент — с уровнями своего рисунка
    await card(page).getByLabel("скопировать на инструмент").selectOption("ETHUSDT");
    await expect.poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem("pl-drawings:ETHUSDT") ?? "[]") as { levels?: number[] }[]).map((c) => c.levels))).toEqual([[-1, -0.618, ...FIB]]);
    await page.keyboard.press("Escape");
    // график — влево: точка A уходит за левый край панели, B остаётся
    const [a, b] = await onScreen(page, d.points);
    const left = (await page.getByTestId("terminal").boundingBox())!.x;
    const shift = a!.x - left + (b!.x - a!.x) / 2;
    await page.mouse.move(X(0.85), Y(0.75));
    await page.mouse.down();
    await page.mouse.move(X(0.85) - shift, Y(0.75), { steps: 10 });
    await page.mouse.up();
    await expect.poll(async () => (await onScreen(page, d.points))[0]!.x).toBeLessThan(left);
    const [, b2] = await onScreen(page, d.points);
    expect(b2!.x).toBeGreaterThan(left + 20);
    const { w, h } = await view(page);
    await expect.poll(async () => (await levelLabels(page)).length).toBeGreaterThan(3);
    const ls = await levelLabels(page);
    expect(ls.map((l) => l.id)).toContain(`${d.id}#L-1`);
    expect(ls.map((l) => l.id)).toContain(`${d.id}#L-0.618`);
    for (const l of ls) {
      expect(l.rect.x, l.text).toBeGreaterThanOrEqual(0);
      expect(l.rect.x + l.rect.w, l.text).toBeLessThanOrEqual(w + 0.5);
      expect(l.rect.y, l.text).toBeGreaterThanOrEqual(0);
      expect(l.rect.y + l.rect.h, l.text).toBeLessThanOrEqual(h + 0.5);
    }
    expect((await stored(page))[0]!.points).toEqual(d.points);
  });

  test("сохранённые Фибоначчи с пустым и испорченным набором рисуются уровнями по умолчанию; заблокированный не правится", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const fib = (id: string, from: number, to: number, levels: unknown) => ({ id, type: "fib", points: [{ time: T0 + from * H4, price: 99.5 }, { time: T0 + to * H4, price: 102.5 }], style: { color: "text2", width: 1, dashed: false }, locked: false, timeframe: null, levels, updated_at: 1 });
    await page.addInitScript(
      (items) => {
        localStorage.setItem("pl-drawings:BTCUSDT", JSON.stringify(items));
        localStorage.setItem("pl-terminal", JSON.stringify({ layers_v: 5, type: "candles", indicators: [], markup: { preset: "clean", overrides: {} }, panels: [], scale: "linear", overlay: null, fibLevels: ["x", null] }));
      },
      [fib("empty", 225, 245, []), fib("junk", 255, 275, ["x", null, 1e99, 0.5000001])],
    );
    const { X, Y } = await open(page);
    await expect(page.getByTestId("drawings-count")).toHaveText("рисунков: 2");
    // пустой набор — уровни по умолчанию (раньше — рисунок без линий); из мусора остаётся единственное число 0.5
    await expect.poll(async () => (await levelLabels(page)).filter((l) => l.id.startsWith("empty#")).map((l) => l.id)).toEqual(expect.arrayContaining(["empty#L0", "empty#L0.5", "empty#L0.618", "empty#L1"]));
    expect((await levelLabels(page)).filter((l) => l.id.startsWith("junk#")).map((l) => l.text)).toEqual(["0.5 · 101.0"]);
    // выбрать первый: в карточке нажаты уровни по умолчанию
    const pts = await onScreen(page, [{ time: T0 + 235 * H4, price: 101 }]);
    await page.mouse.click(pts[0]!.x, pts[0]!.y);
    await expect(card(page)).toContainText("Фибоначчи");
    await card(page).getByRole("button", { name: /уровни/ }).click();
    await expect(panel(page).locator('button[aria-pressed="true"]')).toHaveText(FIB.map(String));
    // заблокированный рисунок: переключатели и «стандартные» недоступны, после разблокировки — снова доступны
    await card(page).getByRole("button", { name: "заблокировать" }).click();
    await expect(toggle(page, "−0.618")).toBeDisabled();
    await expect(toggle(page, "0.5")).toBeDisabled();
    await expect(panel(page).getByRole("button", { name: "стандартные" })).toBeDisabled();
    await card(page).getByRole("button", { name: "разблокировать" }).click();
    await expect(toggle(page, "−0.618")).toBeEnabled();
    // сохранённые наборы приведены и у рисунков в памяти устройства
    expect((await stored(page)).map((d) => d.levels)).toEqual([FIB, [0.5]]);
    // мусор в настройках («набор для новых») — новый Фибоначчи с уровнями по умолчанию
    await drawFib(page, { x: X(0.12), y: Y(0.3) }, { x: X(0.26), y: Y(0.22) });
    await expect(page.getByTestId("drawings-count")).toHaveText("рисунков: 3");
    expect((await stored(page))[2]!.levels).toEqual(FIB);
    expect(errors).toEqual([]);
  });

  test("с входом: правка уровней уходит на сервер как любая правка, набор для новых — в настройках; второе устройство видит и то и другое", async ({ page, browser }) => {
    const server: MockServer = { drawings: [], layout: null };
    const { X, Y } = await open(page, true, server);
    const s = (await swing(page))!;
    await drawFib(page, s.a, s.b);
    await expect.poll(() => server.drawings.length, { timeout: 10000 }).toBe(1);
    expect(server.drawings[0]!.levels).toEqual(FIB);
    const sent = server.drawings[0]!.updated_at as number;
    await card(page).getByRole("button", { name: /уровни/ }).click();
    await toggle(page, "−0.618").click();
    await toggle(page, "0.705").click();
    const want = [-0.618, ...FIB.filter((l) => l !== 0.705)];
    await expect.poll(() => server.drawings[0]!.levels, { timeout: 10000 }).toEqual(want);
    expect(server.drawings[0]!.updated_at as number).toBeGreaterThan(sent);
    await expect.poll(() => server.layout?.fibLevels ?? null, { timeout: 10000 }).toEqual(want);
    await expect(page.getByTestId("drawings-sync")).toHaveText("синхронизировано");
    // второе устройство: рисунок с теми же уровнями, новый Фибоначчи — с набором из настроек
    const ctx2 = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    const page2 = await ctx2.newPage();
    await mock(page2, [], true, server);
    await page2.goto("/chart/BTCUSDT/4h");
    await expect(page2.getByTestId("drawings-count")).toHaveText("рисунков: 1");
    const id = server.drawings[0]!.client_id as string;
    await expect.poll(async () => (await labelOf(page2, id, -0.618))?.text ?? null).toMatch(/^−0\.618 · /);
    await expect.poll(() => remembered(page2)).toEqual(want);
    await drawFib(page2, { x: X(0.12), y: Y(0.56) }, { x: X(0.3), y: Y(0.46) });
    await expect(page2.getByTestId("drawings-count")).toHaveText("рисунков: 2");
    await expect.poll(() => server.drawings.length, { timeout: 10000 }).toBe(2);
    expect(server.drawings[1]!.levels).toEqual(want);
    await ctx2.close();
  });
});

/** Палец через CDP: Chromium делает из этого и pointer-, и touch-события. */
async function finger(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type: "touchStart" | "touchMove" | "touchEnd", pts: [number, number][]) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
  return {
    tap: async (x: number, y: number) => {
      await send("touchStart", [[x, y]]);
      await send("touchEnd", []);
    },
    drag: async (x1: number, y1: number, x2: number, y2: number, steps = 10) => {
      await send("touchStart", [[x1, y1]]);
      for (let i = 1; i <= steps; i++) await send("touchMove", [[x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps]]);
      await send("touchEnd", []);
    },
  };
}

test.describe("заблокированный Фибоначчи, мышь", () => {
  test("клик по телу, линии уровня и точке выбирает — в карточке «разблокировать»; протягивание по нему двигает график; после разблокировки правится", async ({ page }) => {
    await seedLocked(page);
    await open(page);
    await expect(page.getByTestId("drawings-count")).toHaveText("рисунков: 1");
    const [body, level, anchor] = await onScreen(page, [{ time: T0 + 262 * H4, price: 101 }, { time: T0 + 262 * H4, price: 103 - 4 * 1.272 }, LOCKED_FIB.points[0]!]);
    for (const p of [body!, level!, anchor!]) {
      await page.mouse.click(p.x, p.y);
      await expect(card(page), `клик ${JSON.stringify(p)}`).toContainText("Фибоначчи");
      await expect(card(page).getByRole("button", { name: "разблокировать" })).toBeVisible();
      await expect(card(page).getByRole("button", { name: "удалить" })).toBeDisabled();
      await card(page).getByRole("button", { name: "снять выделение" }).click();
      await expect(card(page)).toHaveCount(0);
    }
    // протягивание из середины — сдвиг графика, рисунок на месте
    const r0 = (await view(page)).time!;
    await page.mouse.move(body!.x, body!.y);
    await page.mouse.down();
    await page.mouse.move(body!.x + 150, body!.y, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await view(page)).time!.from).not.toBe(r0.from);
    expect((await stored(page))[0]!.points).toEqual(LOCKED_FIB.points);
    // разблокировать — снова правится и удаляется
    const [b2] = await onScreen(page, [{ time: T0 + 262 * H4, price: 101 }]);
    await page.mouse.click(b2!.x, b2!.y);
    await card(page).getByRole("button", { name: "разблокировать" }).click();
    await expect(card(page).getByRole("button", { name: "заблокировать" })).toBeVisible();
    await card(page).getByRole("button", { name: "удалить" }).click();
    await expect(page.getByTestId("drawings-count")).toHaveText("рисунков: 0");
  });
});

/**
 * Свечи по таймфрейму (1ч, 4ч, 1Д) из одной непрерывной цены: общая заглушка отдаёт свечи 4ч на любой таймфрейм, и
 * рисунок с 1ч на 4ч в ней всегда стоит на свечах. Текущая свеча каждого таймфрейма — та, что содержит текущую свечу 4ч
 * заглушки; истории левее первой порции нет.
 */
const TF_STEP: Record<string, number> = { "1h": 3600, "4h": H4, "1d": 86400 };
async function candlesByTf(page: Page) {
  const now = T0 + 300 * H4;
  const price = (t: number) => 100 + Math.sin(t / (7 * H4)) * 5 + Math.sin(t / 5000) * 0.6;
  await page.route("**/v1/chart/candles**", (route) => {
    const u = new URL(route.request().url());
    const tf = u.searchParams.get("tf") ?? "";
    const step = TF_STEP[tf];
    if (!step) return route.fallback();
    const cur = Math.floor(now / step) * step;
    const mk = (t: number, open: boolean) => {
      const o = price(t), c = price(t + step);
      return { t, o: o.toFixed(2), h: (Math.max(o, c) + 0.3).toFixed(2), l: (Math.min(o, c) - 0.3).toFixed(2), c: c.toFixed(2), v: "1000", open };
    };
    const older = u.searchParams.get("before") !== null;
    const candles = older ? [] : Array.from({ length: 300 }, (_, i) => mk(cur - (300 - i) * step, false));
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ symbol: "BTCUSDT", tf, candles, current: older ? null : mk(cur, true), has_older: false, tick_size: "0.1", server_time: "" }) });
  });
}

/**
 * Где точки рисунка на экране (координаты панели): между свечами — по доле интервала, правее последней — шагом таймфрейма.
 */
const pointsAt = (page: Page, pts: Pt[], step: number) =>
  page.evaluate(
    ({ pts, step }) => {
      const el = document.querySelector('[data-testid="terminal"]') as Term;
      const ts = el.__chart.timeScale();
      const s = el.__chart.panes()[0]!.getSeries()[0]!;
      const times = s.data().map((c) => c.time);
      return pts.map((p) => {
        let i = times.length - 1;
        while (i > 0 && times[i]! > p.time) i--;
        const x0 = ts.timeToCoordinate(times[i]!)!;
        const next = times[i + 1];
        const x1 = next !== undefined ? ts.timeToCoordinate(next)! : x0 + (x0 - ts.timeToCoordinate(times[i - 1]!)!);
        return { x: x0 + ((p.time - times[i]!) / ((next ?? times[i]! + step) - times[i]!)) * (x1 - x0), y: s.priceToCoordinate(p.price)! };
      });
    },
    { pts, step },
  );

/** Правый край плашки подписи продлённого Фибоначчи — на столько левее края панели (FIB_LABEL_EDGE_PX). */
const EDGE_GAP = 4;

/**
 * Вид Фибоначчи на успокоившемся графике (ADR-0009, «Рисование», дополнение 2026-11-13). extended: линии уровней 0
 * и 1 — от A до B и дальше от B до правого края панели; подписи 0, 0.5, 0.618, 1 и остальные поместившиеся — столбцом
 * у шкалы цены (правый край — край панели минус зазор), у своих линий; есть место правее B — подписи не на свечах A–B.
 * Не продлённый: линии только от A до B, подписи — вплотную к рисунку (справа, внутри или слева), как раньше.
 */
async function expectFibView(page: Page, d: Stored, step: number, extended: boolean, name: string) {
  await chartSettled(page);
  await painted(page);
  const [a, b] = (await pointsAt(page, d.points, step)) as [{ x: number; y: number }, { x: number; y: number }];
  const { w, h } = await view(page);
  expect(b.x - a.x, `${name}: B правее A`).toBeGreaterThan(2);
  const strokes = await paneStrokes(page, 2);
  for (const y of [b.y, a.y]) {
    const lvl = strokes.filter((st) => st.points.length === 2 && Math.abs(st.points[0]![1] - y) < 1 && Math.abs(st.points[1]![1] - y) < 1);
    const span = (st: (typeof lvl)[number]) => [Math.min(st.points[0]![0], st.points[1]![0]), Math.max(st.points[0]![0], st.points[1]![0])] as const;
    const found = JSON.stringify(lvl.map((st) => st.points));
    expect(lvl.some((st) => Math.abs(span(st)[0] - a.x) < 1.5 && Math.abs(span(st)[1] - b.x) < 1.5), `${name}: линия уровня на y=${y.toFixed(1)} от A ${a.x.toFixed(1)} до B ${b.x.toFixed(1)}; найдено ${found}`).toBe(true);
    const edge = lvl.some((st) => Math.abs(span(st)[0] - b.x) < 1.5 && Math.abs(span(st)[1] - w) < 1);
    expect(edge, `${name}: продление уровня на y=${y.toFixed(1)} от B ${b.x.toFixed(1)} до края ${w}; найдено ${found}`).toBe(extended);
  }
  await expect.poll(async () => (await levelLabels(page)).filter((l) => l.id.startsWith(`${d.id}#`)).length, `${name}: подписи уровней`).toBeGreaterThanOrEqual(4);
  const ls = (await levelLabels(page)).filter((l) => l.id.startsWith(`${d.id}#`));
  for (const key of [0, 0.5, 0.618, 1]) expect(ls.map((l) => l.id), `${name}: подпись ${key}`).toContain(`${d.id}#L${key}`);
  for (const l of ls) {
    const r = l.rect;
    expect(r.x >= 0 && r.x + r.w <= w + 0.5 && r.y >= 0 && r.y + r.h <= h + 0.5, `${name}: ${l.text} в панели ${JSON.stringify(r)}`).toBe(true);
    if (extended) {
      expect(Math.abs(r.x + r.w - (w - EDGE_GAP)), `${name}: ${l.text} — у шкалы цены (край ${w}), прямоугольник ${JSON.stringify(r)}`).toBeLessThanOrEqual(1);
      // цена уровня точно (в подписи — округлённая до шага): B − (B − A) × уровень
      const level = Number(l.id.slice(l.id.indexOf("#L") + 2));
      const [p1, p2] = d.points as [Pt, Pt];
      expectAtLine(l, await lineY(page, p2.price - (p2.price - p1.price) * level));
      if (w - EDGE_GAP - r.w >= b.x + 2) expect(r.x, `${name}: ${l.text} не на свечах A–B (B ${b.x.toFixed(1)})`).toBeGreaterThanOrEqual(b.x);
    } else {
      expect(r.x <= b.x + 4 && r.x + r.w >= a.x - 4, `${name}: ${l.text} у рисунка ${a.x.toFixed(1)}…${b.x.toFixed(1)}, прямоугольник ${JSON.stringify(r)}`).toBe(true);
    }
  }
  return { a, b };
}

/** Флажок «Линии до края» в панели уровней выбранного Фибоначчи. */
const extendBox = (page: Page) => panel(page).getByRole("checkbox", { name: "Линии до края" });
const storedExtend = async (page: Page, i = 0) => ((await stored(page))[i] as Stored & { style: { extend?: boolean } }).style.extend;
/** «Линии до края» для новых Фибоначчи — в настройках терминала, как набор уровней (null — ещё не выбирали). */
const rememberedExtend = (page: Page) => page.evaluate(() => (JSON.parse(localStorage.getItem("pl-terminal") ?? "{}") as { fibExtend?: boolean }).fibExtend ?? null);

test.describe("рисунок с другого таймфрейма", () => {
  test("Фибоначчи с 1ч на 4ч и 1Д: линии уровней от A до B и до правого края, подписи у шкалы цены; «Линии до края» — прежний вид, после перезагрузки тоже", async ({ page }) => {
    await installStrokes(page);
    await mock(page, []);
    await candlesByTf(page);
    await page.goto("/chart/BTCUSDT/1h");
    const term = page.getByTestId("terminal");
    await expect(term.locator("canvas").first()).toBeVisible();
    await expect(page.getByTestId("drawings-count")).toHaveText("рисунков: 0");
    const step = () => page.evaluate(() => { const d = (document.querySelector('[data-testid="terminal"]') as Term).__chart.panes()[0]!.getSeries()[0]!.data(); return d.length > 1 ? d[1]!.time - d[0]!.time : 0; });
    await expect.poll(step).toBe(3600);
    // свечи в серии — раньше, чем вид перестроился по ширине шкалы цены (chartSettled): координаты свечей — после него,
    // иначе клик по прежнему x попадает на соседнюю свечу
    await chartSettled(page);
    // свечи 1ч не на границе свечи 4ч: A — 3 ч после неё (около 30 % ширины), B — 1 ч после (около 60 %)
    const pick = await page.evaluate((H4) => {
      const el = document.querySelector('[data-testid="terminal"]') as Term;
      const r = el.getBoundingClientRect();
      const ts = el.__chart.timeScale();
      const s = el.__chart.panes()[0]!.getSeries()[0]!;
      const near = (frac: number, hour: number) => {
        let best: { time: number; x: number; y: number } | null = null;
        for (const c of s.data()) {
          const x = ts.timeToCoordinate(c.time);
          if (x === null || c.high === undefined || c.time % H4 !== hour * 3600) continue;
          if (!best || Math.abs(x - ts.width() * frac) < Math.abs(best.x - r.left - ts.width() * frac)) best = { time: c.time, x: r.left + x, y: r.top + s.priceToCoordinate(c.high)! };
        }
        return best!;
      };
      return { a: near(0.3, 3), b: near(0.6, 1) };
    }, H4);
    await drawFib(page, pick.a, { x: pick.b.x, y: pick.b.y + 120 });
    await expect(page.getByTestId("drawings-count")).toHaveText("рисунков: 1");
    const d0 = (await stored(page))[0]!;
    expect(d0.points.map((p) => p.time)).toEqual([pick.a.time, pick.b.time]);
    // новый рисунок — продлённый по умолчанию: поля в стиле нет
    expect(await storedExtend(page)).toBeUndefined();
    await card(page).getByRole("button", { name: "снять выделение" }).click();

    for (const [name, url, want] of [["4ч", "4h", H4], ["1Д", "1d", 86400]] as const) {
      await page.getByRole("link", { name }).click();
      await expect(page).toHaveURL(new RegExp(`/chart/BTCUSDT/${url}$`));
      await expect.poll(step).toBe(want);
      // график таймфрейма — новый: координаты точек и подписи сравниваются на успокоившемся виде, а не на кадре, после
      // которого вид ещё перестраивается
      await expectFibView(page, d0, want, true, name);
    }

    // 1Д: выбрать рисунок (клик по телу A–B), «уровни» → «Линии до края» выключить — линии от A до B, подписи у
    // рисунка (правка рисунка: шаг отмены и синхронизация)
    const mid = async () => {
      const box = (await term.boundingBox())!;
      const [p, q] = await pointsAt(page, d0.points, 86400);
      return { x: box.x + (p!.x + q!.x) / 2, y: box.y + (p!.y + q!.y) / 2 };
    };
    const m1 = await mid();
    await page.mouse.click(m1.x, m1.y);
    await expect(card(page)).toContainText("Фибоначчи");
    await card(page).getByRole("button", { name: /уровни/ }).click();
    await expect(extendBox(page)).toBeChecked();
    await extendBox(page).click();
    await expect(extendBox(page)).not.toBeChecked();
    await expect.poll(() => storedExtend(page)).toBe(false);
    expect((await stored(page))[0]!.points).toEqual(d0.points);
    // выбор запоминается для новых Фибоначчи (настройки терминала), как набор уровней
    await expect.poll(() => rememberedExtend(page)).toBe(false);
    // фокус — на флажке, но флажок не поле ввода: Esc снимает выбор, как после нажатия кнопки карточки
    await expect(extendBox(page)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(card(page)).toHaveCount(0);
    await expectFibView(page, d0, 86400, false, "1Д, не продлён");

    // выбор переживает перезагрузку (память гостя); включили снова — снова до края
    await page.reload();
    await expect(page.getByTestId("drawings-count")).toHaveText("рисунков: 1");
    await expect.poll(step).toBe(86400);
    await expectFibView(page, d0, 86400, false, "1Д после перезагрузки");
    expect(await storedExtend(page)).toBe(false);
    const m2 = await mid();
    await page.mouse.click(m2.x, m2.y);
    await expect(card(page)).toContainText("Фибоначчи");
    await card(page).getByRole("button", { name: /уровни/ }).click();
    await expect(extendBox(page)).not.toBeChecked();
    await extendBox(page).click();
    await expect.poll(() => storedExtend(page)).toBe(true);
    await expect.poll(() => rememberedExtend(page)).toBe(true);
    // Ctrl+Z с фокусом на флажке отменяет правку (отмена снимает выбор) — и рисунку, и выбору для новых; Ctrl+Y — повтор
    await expect(extendBox(page)).toBeFocused();
    await page.keyboard.press("Control+z");
    await expect.poll(() => storedExtend(page)).toBe(false);
    await expect(card(page)).toHaveCount(0);
    await expect.poll(() => rememberedExtend(page)).toBe(false);
    await page.keyboard.press("Control+y");
    await expect.poll(() => storedExtend(page)).toBe(true);
    await expect.poll(() => rememberedExtend(page)).toBe(true);
    await expectFibView(page, d0, 86400, true, "1Д, снова до края");

    // выключили ещё раз — и новый Фибоначчи не продлён: в стиле extend: false (выбор из настроек, как набор уровней)
    const m3 = await mid();
    await page.mouse.click(m3.x, m3.y);
    await expect(card(page)).toContainText("Фибоначчи");
    await card(page).getByRole("button", { name: /уровни/ }).click();
    await extendBox(page).click();
    await expect.poll(() => rememberedExtend(page)).toBe(false);
    await page.keyboard.press("Escape");
    await expect(card(page)).toHaveCount(0);
    const box = (await term.boundingBox())!;
    await drawFib(page, { x: box.x + box.width * 0.12, y: box.y + box.height * 0.56 }, { x: box.x + box.width * 0.3, y: box.y + box.height * 0.46 });
    await expect(page.getByTestId("drawings-count")).toHaveText("рисунков: 2");
    expect(await storedExtend(page, 1)).toBe(false);
    expect(await storedExtend(page, 0)).toBe(false);
  });
});

test.describe("телефон 390×844, палец", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("карточка — одна строка с «уровни»; раскрытая — строка переключателей не меньше 44×44; касание переключает, график не едет", async ({ page }) => {
    const { X, Y, box } = await open(page);
    const f = await finger(page);
    await page.getByRole("button", { name: "Рисовать" }).tap();
    await page.getByRole("dialog", { name: "Рисование" }).getByRole("button", { name: "Фибоначчи" }).tap();
    await f.tap(X(0.2), Y(0.42));
    await f.tap(X(0.6), Y(0.25));
    await expect(page.getByTestId("drawings-count")).toHaveText("рисунков: 1");
    const d0 = (await stored(page))[0]!;
    expect(d0.levels).toEqual(FIB);

    // свёрнутая карточка — одна строка: название, «уровни», закрыть; переключателей и остальных кнопок нет
    await expect(card(page)).toContainText("Фибоначчи");
    const more = card(page).getByRole("button", { name: /уровни/ });
    await expect(more).toHaveAttribute("aria-expanded", "false");
    const bar = (await card(page).boundingBox())!;
    expect(bar.height).toBeLessThanOrEqual(72);
    await expect(card(page).locator("button[aria-pressed]")).toHaveCount(0);
    await expect(card(page).getByRole("button", { name: "удалить" })).toHaveCount(0);
    await expect(card(page).getByRole("button")).toHaveCount(2);
    const r0 = (await view(page)).time;

    // раскрытая: 14 переключателей, каждый — цель касания не меньше 44×44; карточка ниже раскрытой карточки позиции
    // (337 px) и не закрывает ручки своего рисунка
    await more.tap();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    const chips = panel(page).locator("button[aria-pressed]");
    await expect(chips).toHaveCount(14);
    const sizes = await chips.evaluateAll((els) => els.map((e) => ({ name: e.textContent ?? "", w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height })));
    for (const c of sizes) {
      expect(c.w, c.name).toBeGreaterThanOrEqual(44);
      expect(c.h, c.name).toBeGreaterThanOrEqual(44);
    }
    for (const name of ["стандартные", "заблокировать", "удалить", "снять выделение"]) {
      const b = (await card(page).getByRole("button", { name }).boundingBox())!;
      expect(b.height, name).toBeGreaterThanOrEqual(44);
    }
    const opened = (await card(page).boundingBox())!;
    expect(opened.height).toBeLessThanOrEqual(box.height * 0.45);
    // шрифт шире (другая система; так было на сервере проверок): «на всех таймфреймах» и список «скопировать на…»
    // остаются в одной строке — карточка не вырастает на строку и не закрывает половину свечей
    const wide = await page.addStyleTag({ content: "*{letter-spacing:0.9px !important}" });
    expect((await card(page).boundingBox())!.height, "карточка при широком шрифте").toBeLessThanOrEqual(box.height * 0.45);
    await wide.evaluate((el) => (el as HTMLElement).remove());
    expect(opened.width).toBeLessThanOrEqual(390);
    for (const h of await onScreen(page, d0.points)) expect(h.y + 10, "ручка рисунка — над карточкой").toBeLessThanOrEqual(opened.y);
    // страница вбок не едет: строка уровней прокручивается внутри карточки
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // касание включает цель: подпись «−0.618 · цена» на графике, цена — за второй точкой на 61.8 % хода
    await toggle(page, "−0.618").tap();
    await expect(toggle(page, "−0.618")).toHaveAttribute("aria-pressed", "true");
    const [p1, p2] = d0.points as [Pt, Pt];
    const want = p2.price + 0.618 * (p2.price - p1.price);
    await expect.poll(async () => (await labelOf(page, d0.id, -0.618))?.text ?? null).toMatch(/^−0\.618 · \d/);
    expect(Math.abs(priceOf((await labelOf(page, d0.id, -0.618))!.text) - want)).toBeLessThanOrEqual(TICK / 2 + 1e-9);
    // переключатель за краем строки: касание прокручивает строку к нему и включает
    await toggle(page, "2.618").tap();
    await expect(toggle(page, "2.618")).toHaveAttribute("aria-pressed", "true");
    await toggle(page, "0.236").tap();
    await expect(toggle(page, "0.236")).toHaveAttribute("aria-pressed", "false");
    const want3 = [-0.618, ...FIB.filter((l) => l !== 0.236), 2.618];
    expect((await stored(page))[0]!.levels).toEqual(want3);
    expect(await remembered(page)).toEqual(want3);

    // палец тянет строку уровней вбок: едет строка, а не график; рисунок на месте и выбран
    const strip = (await panel(page).boundingBox())!;
    await panel(page).evaluate((el) => (el.scrollLeft = 0));
    await f.drag(strip.x + strip.width - 30, strip.y + strip.height - 22, strip.x + 40, strip.y + strip.height - 22);
    await expect.poll(() => panel(page).evaluate((el) => el.scrollLeft)).toBeGreaterThan(40);
    await page.waitForTimeout(500);
    expect((await view(page)).time).toEqual(r0);
    expect((await stored(page))[0]!.points).toEqual(d0.points);
    await expect(card(page)).toContainText("Фибоначчи");

    // свернуть — снова одна строка без переключателей
    await more.tap();
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await expect(card(page).locator("button[aria-pressed]")).toHaveCount(0);
    expect((await card(page).boundingBox())!.height).toBeLessThanOrEqual(72);
    // «отменить» в нижней строке — шаг назад: 0.236 снова показан у рисунка и в наборе для новых
    await page.getByRole("button", { name: "отменить", exact: true }).tap();
    await expect.poll(async () => (await stored(page))[0]!.levels).toEqual([-0.618, ...FIB, 2.618]);
    await expect.poll(() => remembered(page)).toEqual([-0.618, ...FIB, 2.618]);
  });

  test("Фибоначчи в нижней части области свечей (последний ход у текущей цены): раскрытые «уровни» его не закрывают — график над карточкой, переключение видно", async ({ page }) => {
    const { X, Y } = await open(page);
    const f = await finger(page);
    const margin = () => page.evaluate(() => (document.querySelector('[data-testid="terminal"]') as HTMLElement & { __chart: { priceScale(id: string): { options(): { scaleMargins: { top: number; bottom: number } } } } }).__chart.priceScale("right").options().scaleMargins.bottom);
    expect(await margin()).toBeCloseTo(0.2, 6);
    await page.getByRole("button", { name: "Рисовать" }).tap();
    await page.getByRole("dialog", { name: "Рисование" }).getByRole("button", { name: "Фибоначчи" }).tap();
    // нижние 40 % колонки: там раскрытая карточка (234 px из ~600)
    await f.tap(X(0.2), Y(0.55));
    await f.tap(X(0.6), Y(0.8));
    await expect(page.getByTestId("drawings-count")).toHaveText("рисунков: 1");
    const d0 = (await stored(page))[0]!;
    // свёрнутая карточка (одна строка) — в нижнем поле шкалы: график не сжимается
    await expect(card(page)).toContainText("Фибоначчи");
    expect(await margin()).toBeCloseTo(0.2, 6);

    const more = card(page).getByRole("button", { name: /уровни/ });
    await more.tap();
    await expect(panel(page).locator("button[aria-pressed]")).toHaveCount(14);
    // ручки и уровни коррекции — над карточкой (раньше ручка B и 0…0.5 — под ней): нижнее поле шкалы растёт
    const opened = (await card(page).boundingBox())!;
    await expect.poll(async () => Math.max(...(await onScreen(page, d0.points)).map((h) => h.y)), "ручки — над карточкой").toBeLessThanOrEqual(opened.y - 10);
    expect(await margin()).toBeGreaterThan(0.25);
    const t = (await page.getByTestId("terminal").boundingBox())!;
    // ключевые уровни коррекции подписаны всегда и над карточкой; второстепенные (0.236, 0.382) столбцом у шкалы цены
    // подписаны, когда им хватает места рядом с соседними (тесные — без подписи, ADR-0009, дополнение 2026-11-13), и
    // тогда тоже над карточкой
    const key = [0, 0.5, 0.618, 1];
    await expect
      .poll(async () => {
        const ls = await levelLabels(page);
        return key.filter((l) => {
          const x = ls.find((q) => q.id === `${d0.id}#L${l}`);
          return x && t.y + x.rect.y + x.rect.h <= opened.y;
        });
      }, "подписи ключевых уровней коррекции — над карточкой")
      .toEqual(key);
    for (const l of [0.236, 0.382]) {
      const x = await labelOf(page, d0.id, l);
      if (x) expect(t.y + x.rect.y + x.rect.h, `подпись ${l} — над карточкой`).toBeLessThanOrEqual(opened.y);
    }
    // переключение видно на графике: 0.618 выключили — его подписи нет, включили — снова есть
    await toggle(page, "0.618").tap();
    await expect(toggle(page, "0.618")).toHaveAttribute("aria-pressed", "false");
    await expect.poll(() => labelOf(page, d0.id, 0.618)).toBeNull();
    await toggle(page, "0.618").tap();
    await expect.poll(async () => (await labelOf(page, d0.id, 0.618))?.text ?? null).toMatch(/^0\.618 · /);
    // ручку B тянут пальцем вниз, к карточке: поле шкалы за ней не растёт — точка остаётся под пальцем, а не уезжает
    const m0 = await margin();
    const [, hb] = await onScreen(page, d0.points);
    await f.drag(hb!.x, hb!.y, hb!.x - 20, hb!.y + 8);
    await expect.poll(async () => (await stored(page))[0]!.points[1]!.time).not.toBe(d0.points[1]!.time);
    expect(await margin()).toBeCloseTo(m0, 6);
    const [, nb] = await onScreen(page, (await stored(page))[0]!.points);
    expect(Math.abs(nb!.y - (hb!.y + 8)), "точка B — под пальцем").toBeLessThanOrEqual(13);
    // свернули — поле шкалы прежнее; сняли выделение — тоже
    await more.tap();
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await expect.poll(margin).toBeCloseTo(0.2, 6);
    await more.tap();
    await expect.poll(margin).toBeGreaterThan(0.25);
    await card(page).getByRole("button", { name: "снять выделение" }).tap();
    await expect(card(page)).toHaveCount(0);
    await expect.poll(margin).toBeCloseTo(0.2, 6);
  });

  test("Фибоначчи со свинга 1ч на 1Д (как у владельца на 1Н): линии до правого края, подписи столбцом у шкалы цены; «Линии до края» в карточке — прежний вид, и после перезагрузки", async ({ page }) => {
    // рисунок «на всех таймфреймах» с точками между свечами 1Д — в памяти гостя до загрузки (свинг последних часов)
    const now = T0 + 300 * H4;
    const hour = Math.floor(now / 3600) * 3600;
    const seeded = { id: "FX", type: "fib", points: [{ time: hour - 60 * 3600, price: 98 }, { time: hour - 20 * 3600, price: 103 }], style: { color: "text2", width: 1, dashed: false }, locked: false, timeframe: null, updated_at: 1 };
    await page.addInitScript((d) => {
      if (!localStorage.getItem("pl-drawings:BTCUSDT")) localStorage.setItem("pl-drawings:BTCUSDT", JSON.stringify([d]));
    }, seeded);
    await installStrokes(page);
    await mock(page, []);
    await candlesByTf(page);
    await page.goto("/chart/BTCUSDT/1d");
    await expect(page.getByTestId("drawings-count")).toHaveText("рисунков: 1");
    const f = await finger(page);
    const d0 = (await stored(page))[0]!;
    await expectFibView(page, d0, 86400, true, "телефон 1Д");

    // касание по рисунку — выбор; свёрнутая карточка — одна строка; «уровни» → флажок «Линии до края» — первым в строке
    const box = (await page.getByTestId("terminal").boundingBox())!;
    const [p, q] = await pointsAt(page, d0.points, 86400);
    await f.tap(box.x + (p!.x + q!.x) / 2, box.y + (p!.y + q!.y) / 2);
    await expect(card(page)).toContainText("Фибоначчи");
    expect((await card(page).boundingBox())!.height).toBeLessThanOrEqual(72);
    await card(page).getByRole("button", { name: /уровни/ }).tap();
    await expect(extendBox(page)).toBeChecked();
    const cb = (await extendBox(page).locator("xpath=..").boundingBox())!;
    const strip = (await panel(page).boundingBox())!;
    expect(cb.x + cb.width, "флажок виден без прокрутки строки").toBeLessThanOrEqual(strip.x + strip.width);
    expect(cb.height, "цель касания").toBeGreaterThanOrEqual(44);
    await extendBox(page).tap();
    await expect(extendBox(page)).not.toBeChecked();
    await expect.poll(() => storedExtend(page)).toBe(false);
    await card(page).getByRole("button", { name: "снять выделение" }).tap();
    await expect(card(page)).toHaveCount(0);
    await expectFibView(page, d0, 86400, false, "телефон 1Д, не продлён");

    await page.reload();
    await expect(page.getByTestId("drawings-count")).toHaveText("рисунков: 1");
    expect(await storedExtend(page)).toBe(false);
    await expectFibView(page, d0, 86400, false, "телефон 1Д после перезагрузки");
  });

  test("заблокированный Фибоначчи: касание выбирает — в раскрытой карточке «разблокировать» и «удалить»; сдвиг по нему — графику", async ({ page }) => {
    await seedLocked(page);
    await open(page);
    const f = await finger(page);
    await expect(page.getByTestId("drawings-count")).toHaveText("рисунков: 1");
    const [p] = await onScreen(page, [{ time: T0 + 262 * H4, price: 101 }]);
    // сдвиг пальцем по нему — график едет, рисунок на месте, выбора нет
    const r0 = (await view(page)).time!;
    await f.drag(p!.x, p!.y, p!.x + 120, p!.y);
    await expect.poll(async () => (await view(page)).time!.from).not.toBe(r0.from);
    await page.waitForTimeout(500);
    expect((await stored(page))[0]!.points).toEqual(LOCKED_FIB.points);
    await expect(card(page)).toHaveCount(0);
    // касание — выбор (раньше — ничего: на телефоне его нельзя было ни разблокировать, ни удалить)
    const [q] = await onScreen(page, [{ time: T0 + 262 * H4, price: 101 }]);
    await f.tap(q!.x, q!.y);
    await expect(card(page)).toContainText("Фибоначчи");
    await card(page).getByRole("button", { name: /уровни/ }).tap();
    await expect(card(page).getByRole("button", { name: "удалить" })).toBeDisabled();
    await card(page).getByRole("button", { name: "разблокировать" }).tap();
    await expect(card(page).getByRole("button", { name: "заблокировать" })).toBeVisible();
    await card(page).getByRole("button", { name: "удалить" }).tap();
    await expect(page.getByTestId("drawings-count")).toHaveText("рисунков: 0");
  });
});
