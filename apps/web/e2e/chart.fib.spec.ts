import { expect, test, type Page } from "@playwright/test";
import { H4, T0, mock, type MockServer } from "./helpers/chart";

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
});
