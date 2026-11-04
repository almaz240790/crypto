import { devices, expect, test, type Page } from "@playwright/test";
import { mock } from "./helpers/chart";

/**
 * Рисование как в TradingView (ADR-0009, «Рисование»; замечание владельца: «Фибоначчи спамится, как только хочешь
 * натянуть»): один рисунок на выбор инструмента, точки нажатиями, жест графика не рисует, «рисовать серию»,
 * «Отменить» и Esc, нейтральный цвет Фибоначчи.
 */

type Range = { from: number; to: number };
const range = (page: Page) => page.evaluate(() => (document.querySelector('[data-testid="terminal"]') as HTMLElement & { __chart: { timeScale(): { getVisibleLogicalRange(): Range | null } } }).__chart.timeScale().getVisibleLogicalRange());

async function open(page: Page) {
  await mock(page, []);
  await page.goto("/chart/BTCUSDT/4h");
  const term = page.getByTestId("terminal");
  await expect(term.locator("canvas").first()).toBeVisible();
  await expect(page.getByTestId("drawings-count")).toHaveText("рисунков: 0");
  const b = (await term.boundingBox())!;
  return { X: (f: number) => b.x + b.width * f, Y: (f: number) => b.y + b.height * f };
}

/** Палец через CDP: Chromium делает из этого и pointer-, и touch-события (touchscreen Playwright умеет только tap). */
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
      // подпись уровня — справа от линии (x + 4) и над ней (y − 3): по ней находим линию этого уровня
      const labels = log.texts.filter((t) => /^\d+(\.\d+)? · /.test(t.t)).slice(-10);
      return labels.map((l) => ({ label: l, line: [...log.strokes].reverse().find((s) => s.y0 === s.y1 && Math.abs(s.y0 - (l.y + 3)) < 0.01 && Math.abs(s.x1 - (l.x - 4)) < 0.01) ?? null }));
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
});
