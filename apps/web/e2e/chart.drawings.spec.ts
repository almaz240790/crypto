import { devices, expect, test, type Page } from "@playwright/test";
import { mock } from "./helpers/chart";

/**
 * Рисование как в TradingView (ADR-0009, «Рисование»; замечание владельца: «Фибоначчи спамится, как только хочешь
 * натянуть»): один рисунок на выбор инструмента, точки нажатиями, жест графика не рисует, «рисовать серию»,
 * «Отменить» и Esc, нейтральный цвет Фибоначчи. Ревью: палец над готовым рисунком (сдвиг и щипок — графику, правится
 * выбранный), шкалы — жесты графика, долгое касание, двойной клик, дрожь руки, отмена перетаскивания, подписи у края.
 */

type Range = { from: number; to: number };
type Pt = { time: number; price: number };
type Chart = {
  timeScale(): { getVisibleLogicalRange(): Range | null; width(): number; timeToCoordinate(t: number): number | null };
  paneSize(i: number): { height: number };
  priceScale(id: string): { getVisibleRange(): Range | null; options(): { autoScale: boolean } };
  panes(): { getSeries(): { priceToCoordinate(p: number): number | null; data(): { time: number; high?: number }[] }[] }[];
};
const range = (page: Page) => page.evaluate(() => (document.querySelector('[data-testid="terminal"]') as HTMLElement & { __chart: Chart }).__chart.timeScale().getVisibleLogicalRange());
/** Рисунки гостя — в localStorage (без удалённых). */
const stored = (page: Page) => page.evaluate(() => (JSON.parse(localStorage.getItem("pl-drawings:BTCUSDT") ?? "[]") as { type: string; points: Pt[]; deleted_at?: number | null }[]).filter((d) => !d.deleted_at));
/** Область свечей основной панели (без шкалы цены) и шкала цены. */
const plot = (page: Page) =>
  page.evaluate(() => {
    const c = (document.querySelector('[data-testid="terminal"]') as HTMLElement & { __chart: Chart }).__chart;
    return { w: c.timeScale().width(), h: c.paneSize(0).height, price: c.priceScale("right").getVisibleRange(), auto: c.priceScale("right").options().autoScale };
  });
/** Точки рисунка на экране (координаты страницы). */
const onScreen = (page: Page, pts: Pt[]) =>
  page.evaluate((pts) => {
    const el = document.querySelector('[data-testid="terminal"]') as HTMLElement & { __chart: Chart };
    const r = el.getBoundingClientRect();
    const s = el.__chart.panes()[0]!.getSeries()[0]!;
    return pts.map((p) => ({ x: r.left + el.__chart.timeScale().timeToCoordinate(p.time)!, y: r.top + s.priceToCoordinate(p.price)! }));
  }, pts);

async function open(page: Page) {
  await mock(page, []);
  await page.goto("/chart/BTCUSDT/4h");
  const term = page.getByTestId("terminal");
  await expect(term.locator("canvas").first()).toBeVisible();
  await expect(page.getByTestId("drawings-count")).toHaveText("рисунков: 0");
  const b = (await term.boundingBox())!;
  return { X: (f: number) => b.x + b.width * f, Y: (f: number) => b.y + b.height * f };
}

/** Вид успокоился (инерция сдвига пальцем закончилась): диапазон тот же два чтения подряд. */
async function settle(page: Page) {
  let prev = JSON.stringify(await range(page));
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(150);
    const next = JSON.stringify(await range(page));
    if (next === prev) return;
    prev = next;
  }
}

/** Свеча у доли ширины области свечей: x и y её максимума (координаты страницы). */
const candleTop = (page: Page, frac: number) =>
  page.evaluate((frac) => {
    const el = document.querySelector('[data-testid="terminal"]') as HTMLElement & { __chart: Chart };
    const r = el.getBoundingClientRect();
    const ts = el.__chart.timeScale();
    const s = el.__chart.panes()[0]!.getSeries()[0]!;
    const want = ts.width() * frac;
    let best: { x: number; high: number } | null = null;
    for (const c of s.data()) {
      const x = ts.timeToCoordinate(c.time);
      if (x === null || c.high === undefined) continue;
      if (!best || Math.abs(x - want) < Math.abs(best.x - want)) best = { x, high: c.high };
    }
    return { x: r.left + best!.x, y: r.top + s.priceToCoordinate(best!.high)! };
  }, frac);

/** Палец через CDP: Chromium делает из этого и pointer-, и touch-события (touchscreen Playwright умеет только tap). */
async function finger(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type: "touchStart" | "touchMove" | "touchEnd", pts: [number, number][]) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
  return {
    tap: async (x: number, y: number) => {
      await send("touchStart", [[x, y]]);
      await send("touchEnd", []);
    },
    /** Удержание пальца (ставят точку «аккуратно»): дольше 240 мс — у LWC это режим перекрестия. */
    hold: async (x: number, y: number, ms: number) => {
      await send("touchStart", [[x, y]]);
      await page.waitForTimeout(ms);
      await send("touchEnd", []);
    },
    /** Щипок: пальцы — по горизонтали вокруг (cx, cy), расстояние от d0 до d1 (staggered — второй палец позже). */
    pinch: async (cx: number, cy: number, d0: number, d1: number, staggered = false, steps = 10) => {
      if (staggered) {
        await send("touchStart", [[cx - d0, cy]]);
        await page.waitForTimeout(80);
      }
      await send("touchStart", [[cx - d0, cy], [cx + d0, cy]]);
      for (let i = 1; i <= steps; i++) {
        const d = d0 + ((d1 - d0) * i) / steps;
        await send("touchMove", [[cx - d, cy], [cx + d, cy]]);
      }
      await send("touchEnd", []);
    },
    drag: async (x1: number, y1: number, x2: number, y2: number, steps = 10) => {
      await send("touchStart", [[x1, y1]]);
      for (let i = 1; i <= steps; i++) await send("touchMove", [[x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps]]);
      await send("touchEnd", []);
    },
  };
}

test.describe("десктоп, мышь", () => {
  test("Фибоначчи кликом и кликом: подсказка шага, один рисунок, затем курсор; дальше клики и протягивания не рисуют", async ({ page }) => {
    const { X, Y } = await open(page);
    const tools = page.getByRole("toolbar", { name: "панель рисования" });
    const fib = tools.getByRole("button", { name: "Фибоначчи" });
    const chip = page.getByTestId("draw-chip");
    const count = page.getByTestId("drawings-count");
    await fib.click();
    await expect(chip).toContainText("Фибоначчи");
    await expect(chip).toContainText("Нажмите первую точку");
    await page.mouse.click(X(0.3), Y(0.3));
    await expect(chip).toContainText("Нажмите вторую точку");
    await expect(count).toHaveText("рисунков: 0");
    await page.mouse.move(X(0.45), Y(0.5), { steps: 4 });
    await page.mouse.click(X(0.55), Y(0.6));
    await expect(count).toHaveText("рисунков: 1");
    // инструмент снят: кнопка не нажата, чипа нет, рисунок выбран
    await expect(fib).toHaveAttribute("aria-pressed", "false");
    await expect(chip).toHaveCount(0);
    await expect(page.getByRole("region", { name: "выбранный рисунок" })).toContainText("Фибоначчи");
    // раньше каждые два клика давали ещё один рисунок; теперь клик мимо снимает выбор, протягивание сдвигает график
    await page.mouse.click(X(0.8), Y(0.2));
    await expect(page.getByRole("region", { name: "выбранный рисунок" })).toHaveCount(0);
    const before = await range(page);
    await page.mouse.move(X(0.75), Y(0.45));
    await page.mouse.down();
    await page.mouse.move(X(0.45), Y(0.45), { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await range(page))!.from).not.toBe(before!.from);
    await page.mouse.click(X(0.2), Y(0.7));
    await page.mouse.click(X(0.4), Y(0.75));
    await expect(count).toHaveText("рисунков: 1");
  });

  test("нажать-протянуть-отпустить: рисунок готов, график под мышью не сдвигается", async ({ page }) => {
    const { X, Y } = await open(page);
    await page.getByRole("toolbar", { name: "панель рисования" }).getByRole("button", { name: "Трендовая линия" }).click();
    const before = await range(page);
    await page.mouse.move(X(0.25), Y(0.65));
    await page.mouse.down();
    await page.mouse.move(X(0.5), Y(0.35), { steps: 8 });
    await page.mouse.up();
    await expect(page.getByTestId("drawings-count")).toHaveText("рисунков: 1");
    expect(await range(page)).toEqual(before);
    await expect(page.getByRole("region", { name: "выбранный рисунок" })).toContainText("Трендовая линия");
    await expect(page.getByTestId("draw-chip")).toHaveCount(0);
  });

  test("«рисовать серию»: инструмент остаётся до «Готово»; настройка запоминается на устройстве", async ({ page }) => {
    const { X, Y } = await open(page);
    const tools = page.getByRole("toolbar", { name: "панель рисования" });
    const series = tools.getByRole("button", { name: "рисовать серию" });
    await expect(series).toHaveAttribute("aria-pressed", "false");
    await series.click();
    await expect(series).toHaveAttribute("aria-pressed", "true");
    const hline = tools.getByRole("button", { name: "Горизонтальная линия" });
    await hline.click();
    const chip = page.getByTestId("draw-chip");
    await expect(chip).toContainText("Нажмите на график");
    for (const f of [0.2, 0.3, 0.4]) await page.mouse.click(X(0.5), Y(f));
    await expect(page.getByTestId("drawings-count")).toHaveText("рисунков: 3");
    await expect(hline).toHaveAttribute("aria-pressed", "true");
    await chip.getByRole("button", { name: "Готово — закончить рисование" }).click();
    await expect(hline).toHaveAttribute("aria-pressed", "false");
    await expect(chip).toHaveCount(0);
    await page.reload();
    await expect(tools.getByRole("button", { name: "рисовать серию" })).toHaveAttribute("aria-pressed", "true");
  });

  test("«Отменить» и Esc бросают начатый рисунок и возвращают курсор", async ({ page }) => {
    const { X, Y } = await open(page);
    const tools = page.getByRole("toolbar", { name: "панель рисования" });
    const count = page.getByTestId("drawings-count");
    const chip = page.getByTestId("draw-chip");
    await tools.getByRole("button", { name: "Фибоначчи" }).click();
    await page.mouse.click(X(0.3), Y(0.3));
    await expect(chip).toContainText("Нажмите вторую точку");
    await chip.getByRole("button", { name: "Отменить рисунок" }).click();
    await expect(chip).toHaveCount(0);
    await page.mouse.click(X(0.5), Y(0.5));
    await expect(count).toHaveText("рисунков: 0");
    await tools.getByRole("button", { name: "Прямоугольник" }).click();
    await page.mouse.click(X(0.3), Y(0.3));
    await page.mouse.move(X(0.4), Y(0.45));
    await page.keyboard.press("Escape");
    await expect(chip).toHaveCount(0);
    await expect(tools.getByRole("button", { name: "Прямоугольник" })).toHaveAttribute("aria-pressed", "false");
    await page.mouse.click(X(0.5), Y(0.5));
    await expect(count).toHaveText("рисунков: 0");
  });

  test("Фибоначчи — нейтральный цвет: линии и подписи уровней --text-2, не салатовый и не охра; 0.618 выделен", async ({ page }) => {
    // линии и подписи рисунков — в canvas: записываем цвет каждой горизонтальной линии и подписи
    await page.addInitScript(() => {
      type Rec = { texts: { t: string; x: number; y: number; fill: string; font: string }[]; strokes: { x0: number; y0: number; x1: number; y1: number; style: string; width: number; alpha: number }[] };
      const log: Rec = { texts: [], strokes: [] };
      (window as unknown as { __draw: Rec }).__draw = log;
      const P = CanvasRenderingContext2D.prototype as CanvasRenderingContext2D & { __m?: number[]; __l?: number[] };
      const { fillText, moveTo, lineTo, stroke } = P;
      P.fillText = function (t: string, x: number, y: number, w?: number) {
        log.texts.push({ t: String(t), x, y, fill: String(this.fillStyle), font: this.font });
        return fillText.call(this, t, x, y, w);
      };
      P.moveTo = function (this: typeof P, x: number, y: number) {
        this.__m = [x, y];
        return moveTo.call(this, x, y);
      };
      P.lineTo = function (this: typeof P, x: number, y: number) {
        this.__l = [x, y];
        return lineTo.call(this, x, y);
      };
      P.stroke = function (this: typeof P, ...a: unknown[]) {
        if (this.__m && this.__l) log.strokes.push({ x0: this.__m[0]!, y0: this.__m[1]!, x1: this.__l[0]!, y1: this.__l[1]!, style: String(this.strokeStyle), width: this.lineWidth, alpha: this.globalAlpha });
        return (stroke as (...args: unknown[]) => void).apply(this, a);
      } as typeof P.stroke;
    });
    const { X, Y } = await open(page);
    await page.getByRole("toolbar", { name: "панель рисования" }).getByRole("button", { name: "Фибоначчи" }).click();
    await page.mouse.click(X(0.3), Y(0.3));
    await page.mouse.click(X(0.55), Y(0.6));
    await expect(page.getByTestId("drawings-count")).toHaveText("рисунков: 1");
    // снять выбор — без хэндлов, только сам рисунок
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    const tokens = await page.getByTestId("terminal").evaluate((el) => {
      const cs = getComputedStyle(el);
      return { text2: cs.getPropertyValue("--text-2").trim().toLowerCase(), accent: cs.getPropertyValue("--accent").trim().toLowerCase(), warn: cs.getPropertyValue("--warn").trim().toLowerCase() };
    });
    const drawn = await page.evaluate(() => {
      const log = (window as unknown as { __draw: { texts: { t: string; x: number; y: number; fill: string; font: string }[]; strokes: { x0: number; y0: number; x1: number; y1: number; style: string; width: number; alpha: number }[] } }).__draw;
      // подпись уровня — над линией (y − 3; у края панели — внутри рисунка): по ней находим линию этого уровня
      const labels = log.texts.filter((t) => /^\d+(\.\d+)? · /.test(t.t)).slice(-10);
      return labels.map((l) => ({ label: l, line: [...log.strokes].reverse().find((s) => s.y0 === s.y1 && s.x1 > s.x0 && Math.abs(s.y0 - (l.y + 3)) < 0.01) ?? null }));
    });
    expect(drawn).toHaveLength(10);
    for (const { label, line } of drawn) {
      expect(label.fill.toLowerCase(), label.t).toBe(tokens.text2);
      expect(line, label.t).not.toBeNull();
      expect(line!.style.toLowerCase(), label.t).toBe(tokens.text2);
      expect([tokens.accent, tokens.warn]).not.toContain(line!.style.toLowerCase());
    }
    const key = drawn.find((d) => d.label.t.startsWith("0.618 · "))!;
    const minor = drawn.find((d) => d.label.t.startsWith("0.236 · "))!;
    expect(key.line!.width).toBeGreaterThan(minor.line!.width);
    expect(key.line!.alpha).toBeGreaterThan(minor.line!.alpha);
    expect(key.label.font).toMatch(/^600 /);
  });
});

test.describe("десктоп, мышь: шкалы, двойной клик, дрожь руки, отмена", () => {
  test("с инструментом протягивание по шкале цены масштабирует шкалу и не рисует; клик по шкале времени — не точка", async ({ page }) => {
    await open(page);
    const tools = page.getByRole("toolbar", { name: "панель рисования" });
    const chip = page.getByTestId("draw-chip");
    const box = (await page.getByTestId("terminal").boundingBox())!;
    const p0 = await plot(page);
    expect(p0.auto).toBe(true);
    await tools.getByRole("button", { name: "Фибоначчи" }).click();
    const ax = box.x + p0.w + 30;
    await page.mouse.move(ax, box.y + p0.h * 0.35);
    await page.mouse.down();
    await page.mouse.move(ax, box.y + p0.h * 0.6, { steps: 8 });
    await page.mouse.up();
    // раньше: невидимый Фибоначчи нулевой ширины за последней свечой, шкала на месте, инструмент снят
    await expect(page.getByTestId("drawings-count")).toHaveText("рисунков: 0");
    await expect(chip).toContainText("Нажмите первую точку");
    const p1 = await plot(page);
    expect(p1.auto).toBe(false);
    expect(p1.price).not.toEqual(p0.price);
    await page.mouse.click(box.x + p0.w * 0.4, box.y + box.height - 8);
    await expect(chip).toContainText("Нажмите первую точку");
    expect(await stored(page)).toEqual([]);
  });

  test("двойной клик у максимума свечи (магнит) — не Фибоначчи нулевой длины; двойной клик, закончивший рисунок, вид не сбрасывает", async ({ page }) => {
    const { X, Y } = await open(page);
    const tools = page.getByRole("toolbar", { name: "панель рисования" });
    const chip = page.getByTestId("draw-chip");
    const count = page.getByTestId("drawings-count");
    await tools.getByRole("button", { name: "Фибоначчи" }).click();
    // 9 px выше максимума: магнит ставит точку на максимум, дальше допуска «того же места» от клика
    const top = await candleTop(page, 0.45);
    await page.mouse.dblclick(top.x, top.y - 9);
    await expect(chip).toContainText("Нажмите вторую точку");
    await expect(count).toHaveText("рисунков: 0");
    await expect(tools.getByRole("button", { name: "Фибоначчи" })).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    // вид — в истории; Alt+H и двойной клик: линия, вид не прыгает к правому краю
    await page.mouse.move(X(0.3), Y(0.5));
    await page.mouse.down();
    await page.mouse.move(X(0.7), Y(0.5), { steps: 8 });
    await page.mouse.up();
    const r0 = await range(page);
    await page.keyboard.press("Alt+h");
    await page.mouse.dblclick(X(0.5), Y(0.3));
    await expect(count).toHaveText("рисунков: 1");
    await page.waitForTimeout(300);
    expect(await range(page)).toEqual(r0);
  });

  test("горизонтальная линия: дрожь руки при клике — линия сразу и там, где нажали; отмена после перетаскивания возвращает рисунок", async ({ page }) => {
    const { X, Y } = await open(page);
    const count = page.getByTestId("drawings-count");
    const chip = page.getByTestId("draw-chip");
    await page.keyboard.press("Alt+h");
    await page.mouse.move(X(0.5), Y(0.3));
    await page.mouse.down();
    await page.mouse.move(X(0.5) + 4, Y(0.3) + 1);
    await page.mouse.up();
    await expect(count).toHaveText("рисунков: 1");
    await expect(chip).toHaveCount(0);
    // следующий клик линию не переносит (раньше вторая линия вставала в место первого нажатия)
    await page.mouse.click(X(0.4), Y(0.7));
    await expect(count).toHaveText("рисунков: 1");
    // трендовая: перетащить хэндл B, Ctrl+Z — на месте до перетаскивания
    await page.keyboard.press("Alt+t");
    await page.mouse.click(X(0.3), Y(0.6));
    await page.mouse.click(X(0.5), Y(0.45));
    await expect(count).toHaveText("рисунков: 2");
    const trend = (await stored(page)).find((d) => d.type === "trend")!;
    const [, b] = await onScreen(page, trend.points);
    await page.mouse.move(b!.x, b!.y);
    await page.mouse.down();
    await page.mouse.move(b!.x + 60, b!.y + 90, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (await stored(page)).find((d) => d.type === "trend")!.points).not.toEqual(trend.points);
    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await stored(page)).find((d) => d.type === "trend")?.points).toEqual(trend.points);
  });
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { defaultBrowserType, ...pixel5 } = devices["Pixel 5"];

test.describe("телефон, палец", () => {
  test.use(pixel5);

  test("Фибоначчи: сдвиг до точки A двигает график, касание — A, протягивание двигает B, касание — B; лишних рисунков нет", async ({ page }) => {
    const { X, Y } = await open(page);
    const f = await finger(page);
    const count = page.getByTestId("drawings-count");
    const chip = page.getByTestId("draw-chip");
    await page.getByRole("button", { name: "Рисовать" }).tap();
    await page.getByRole("dialog", { name: "Рисование" }).getByRole("button", { name: "Фибоначчи" }).tap();
    await expect(chip).toContainText("Нажмите первую точку");
    await expect(page.getByRole("button", { name: "Рисую: Фибоначчи" })).toBeVisible();
    // жест графика до точки A: график едет, точки нет
    const r0 = await range(page);
    await f.drag(X(0.7), Y(0.55), X(0.4), Y(0.55));
    await expect.poll(async () => (await range(page))!.from).not.toBe(r0!.from);
    await expect(chip).toContainText("Нажмите первую точку");
    // касание — точка A
    await f.tap(X(0.2), Y(0.35));
    await expect(chip).toContainText("Нажмите вторую точку");
    // протягивание: точка B за пальцем, график стоит, рисунок не завершён
    const r1 = await range(page);
    await f.drag(X(0.3), Y(0.45), X(0.55), Y(0.7));
    await expect(count).toHaveText("рисунков: 0");
    await expect(chip).toContainText("Нажмите вторую точку");
    expect(await range(page)).toEqual(r1);
    // касание — точка B: готово, инструмент снят
    await f.tap(X(0.55), Y(0.7));
    await expect(count).toHaveText("рисунков: 1");
    await expect(chip).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Рисовать", exact: true })).toBeVisible();
    // дальше сдвиги и касания — без новых рисунков (раньше каждые два жеста давали ещё один)
    await f.drag(X(0.7), Y(0.5), X(0.3), Y(0.5));
    await f.drag(X(0.5), Y(0.75), X(0.2), Y(0.75));
    await f.tap(X(0.15), Y(0.8));
    await f.tap(X(0.4), Y(0.3));
    await page.waitForTimeout(300);
    await expect(count).toHaveText("рисунков: 1");
  });

  test("«рисовать серию» в листе «Рисование» и «Отменить» в чипе", async ({ page }) => {
    const { X, Y } = await open(page);
    const f = await finger(page);
    const count = page.getByTestId("drawings-count");
    const chip = page.getByTestId("draw-chip");
    await page.getByRole("button", { name: "Рисовать" }).tap();
    const sheet = page.getByRole("dialog", { name: "Рисование" });
    await sheet.getByRole("checkbox", { name: /рисовать серию/ }).check();
    await sheet.getByRole("button", { name: "Горизонтальная линия" }).tap();
    // лист закрылся, чип на месте — касания идут в график
    await expect(page.getByRole("dialog", { name: "Рисование" })).toHaveCount(0);
    await expect(chip).toContainText("Нажмите на график");
    await f.tap(X(0.4), Y(0.4));
    await expect(count).toHaveText("рисунков: 1");
    // низ колонки графика на телефоне занимает карточка выбранного рисунка — второе касание выше
    await f.tap(X(0.4), Y(0.25));
    await expect(count).toHaveText("рисунков: 2");
    await expect(chip).toContainText("Нажмите на график");
    await chip.getByRole("button", { name: "Готово — закончить рисование" }).tap();
    await expect(chip).toHaveCount(0);
    // «Отменить» после точки A: рисунка нет, инструмент снят
    await page.getByRole("button", { name: "Рисовать" }).tap();
    await page.getByRole("dialog", { name: "Рисование" }).getByRole("button", { name: "Фибоначчи" }).tap();
    await expect(chip).toContainText("Нажмите первую точку");
    await f.tap(X(0.3), Y(0.32));
    await expect(chip).toContainText("Нажмите вторую точку");
    await chip.getByRole("button", { name: "Отменить рисунок" }).tap();
    await expect(chip).toHaveCount(0);
    await f.tap(X(0.6), Y(0.35));
    await expect(count).toHaveText("рисунков: 2");
  });

  test("над готовым Фибоначчи: сдвиг и щипок — графику, касание выбирает, выбранный тянется за хэндл; подписи уровней в пределах панели", async ({ page }) => {
    // подписи уровней — в canvas: начало и ширина текста каждой
    await page.addInitScript(() => {
      const labels: { t: string; x: number; w: number }[] = [];
      (window as unknown as { __labels: typeof labels }).__labels = labels;
      const P = CanvasRenderingContext2D.prototype;
      const { fillText } = P;
      P.fillText = function (t: string, x: number, y: number, w?: number) {
        if (/^\d+(\.\d+)? · /.test(String(t))) labels.push({ t: String(t), x, w: this.measureText(String(t)).width });
        return fillText.call(this, t, x, y, w);
      };
    });
    const { X, Y } = await open(page);
    const f = await finger(page);
    const count = page.getByTestId("drawings-count");
    const card = page.getByRole("region", { name: "выбранный рисунок" });
    await page.getByRole("button", { name: "Рисовать" }).tap();
    await page.getByRole("dialog", { name: "Рисование" }).getByRole("button", { name: "Фибоначчи" }).tap();
    await f.tap(X(0.15), Y(0.2));
    await f.tap(X(0.65), Y(0.6));
    await expect(count).toHaveText("рисунков: 1");
    await expect(card).toContainText("Фибоначчи");
    // правый конец у последних свечей: подписи не уходят под шкалу цены
    const { w } = await plot(page);
    const labels = await page.evaluate(() => (window as unknown as { __labels: { t: string; x: number; w: number }[] }).__labels.slice(-10));
    expect(labels).toHaveLength(10);
    for (const l of labels) expect(l.x + l.w, l.t).toBeLessThanOrEqual(w + 0.5);
    // касание мимо — выбор снят
    await f.tap(X(0.78), Y(0.3));
    await expect(card).toHaveCount(0);
    const fib = (await stored(page))[0]!;
    const mid = async (pts: Pt[]) => {
      const [a, b] = await onScreen(page, pts);
      return { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2, b: b! };
    };
    // сдвиг пальцем из середины невыбранного рисунка: график едет, рисунок на месте (раньше — наоборот)
    let c = await mid(fib.points);
    let r = (await range(page))!;
    await f.drag(c.x, c.y, c.x - 120, c.y + 10);
    await expect.poll(async () => (await range(page))!.from).not.toBe(r.from);
    await settle(page);
    expect((await stored(page))[0]!.points).toEqual(fib.points);
    await expect(card).toHaveCount(0);
    // щипок, начатый внутри рисунка (второй палец позже): масштаб, рисунок на месте; сводим пальцы — рисунок
    // остаётся на экране целиком (хэндл B ниже — в области свечей, не под шкалой цены)
    c = await mid(fib.points);
    r = (await range(page))!;
    await f.pinch(c.x, c.y, 70, 25, true);
    await expect.poll(async () => { const q = (await range(page))!; return Math.round((q.to - q.from) * 10); }).not.toBe(Math.round((r.to - r.from) * 10));
    await settle(page);
    expect((await stored(page))[0]!.points).toEqual(fib.points);
    // касание по рисунку — выбор; выбранный тянется за хэндл B пальцем, график стоит
    c = await mid(fib.points);
    expect(c.b.x).toBeLessThan((await page.getByTestId("terminal").boundingBox())!.x + (await plot(page)).w - 20);
    await f.tap(c.x, c.y);
    await expect(card).toContainText("Фибоначчи");
    r = (await range(page))!;
    await f.drag(c.b.x, c.b.y, c.b.x - 30, c.b.y + 40);
    await expect.poll(async () => (await stored(page))[0]!.points[1]).not.toEqual(fib.points[1]);
    expect((await stored(page))[0]!.points[0]).toEqual(fib.points[0]);
    expect(await range(page)).toEqual(r);
    // щипок, начатый пальцем на выбранном рисунке: правка отменена, масштаб — графику
    const moved = (await stored(page))[0]!.points;
    c = await mid(moved);
    r = (await range(page))!;
    await f.pinch(c.x, c.y, 20, 60, true);
    await expect.poll(async () => { const q = (await range(page))!; return Math.round((q.to - q.from) * 10); }).not.toBe(Math.round((r.to - r.from) * 10));
    await settle(page);
    expect((await stored(page))[0]!.points).toEqual(moved);
    await expect(count).toHaveText("рисунков: 1");
  });

  test("точку ставят удержанием: карточка свечи не закрывает чип, после рисунка сдвиг двигает график, а не перекрестие", async ({ page }) => {
    const { X, Y } = await open(page);
    const f = await finger(page);
    const count = page.getByTestId("drawings-count");
    const chip = page.getByTestId("draw-chip");
    await page.getByRole("button", { name: "Рисовать" }).tap();
    await page.getByRole("dialog", { name: "Рисование" }).getByRole("button", { name: "Трендовая линия" }).tap();
    // удержание дольше long-tap LWC (240 мс)
    await f.hold(X(0.3), Y(0.45), 400);
    await expect(chip).toContainText("Нажмите вторую точку");
    await expect(page.getByTestId("ohlc")).toHaveCount(0);
    // «Отменить» сверху: в любой точке кнопки под пальцем — она (раньше часть закрывал «×» карточки свечи)
    const cancel = chip.getByRole("button", { name: "Отменить рисунок" });
    const bb = (await cancel.boundingBox())!;
    const hits = await page.evaluate((bb) => {
      const out: boolean[] = [];
      for (const fx of [0.1, 0.5, 0.9]) for (const fy of [0.15, 0.5, 0.85]) out.push(!!document.elementFromPoint(bb.x + bb.width * fx, bb.y + bb.height * fy)?.closest('[data-testid="draw-chip"] button'));
      return out;
    }, bb);
    expect(hits).toEqual(Array(9).fill(true));
    await cancel.tap();
    await expect(chip).toHaveCount(0);
    // горизонтальная линия удержанием: после неё сдвиги двигают график
    await page.getByRole("button", { name: "Рисовать" }).tap();
    await page.getByRole("dialog", { name: "Рисование" }).getByRole("button", { name: "Горизонтальная линия" }).tap();
    await f.hold(X(0.3), Y(0.3), 400);
    await expect(count).toHaveText("рисунков: 1");
    await page.getByRole("region", { name: "выбранный рисунок" }).getByRole("button", { name: "снять выделение" }).tap();
    const r = (await range(page))!;
    await f.drag(X(0.7), Y(0.55), X(0.35), Y(0.55));
    await expect.poll(async () => (await range(page))!.from).not.toBe(r.from);
    await expect(page.getByTestId("ohlc")).toHaveCount(0);
    await expect(count).toHaveText("рисунков: 1");
  });
});
