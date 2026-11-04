import { expect, test, type Page } from "@playwright/test";
import { FIRST_PAGE, H4, RICH_C0, T0, mock } from "./helpers/chart";

/**
 * Живая цена (план 2A.3, ADR-0010): сервер шлёт тики раз в секунду на символ; здесь заглушка WebSocket
 * шлёт их каждые 250 мс. Цена в шапке и close текущей свечи меняются в пределах секунды, high/low
 * расширяются, нового бара внутри интервала нет, вид пользователя не сбрасывается; «онлайн» — пока идут
 * тики, без тиков дольше 5 с — «без связи». Ячейки мультичарта получают тики своих символов.
 */

/** Начало текущей (незакрытой) свечи заглушки: время тиков — внутри неё. */
const CUR = T0 + FIRST_PAGE * H4;
const iso = (sec: number) => new Date(sec * 1000).toISOString();
const LOW = RICH_C0 - 20;
/** k-й тик: первый — провал ниже свечи (проверка low), дальше рост на 0.1 (проверка high и close). */
const priceAt = (k: number) => (k === 1 ? LOW : RICH_C0 + 20 + k * 0.1);

type Range = { from: number; to: number };
type Bar = { time: number; open: number; high: number; low: number; close: number };

/** Заглушка /v1/ws: на подписку — тики каждые 250 мс по подписанным символам. */
async function liveSocket(page: Page) {
  const timers: ReturnType<typeof setInterval>[] = [];
  const state = { on: true, sent: 0, last: new Map<string, number>() };
  await page.routeWebSocket(/\/v1\/ws/, (ws) => {
    let subs: string[] = [];
    let k = 0;
    ws.onMessage((raw) => {
      const m = JSON.parse(String(raw)) as { sub?: string[]; ping?: number };
      if (Array.isArray(m.sub)) {
        subs = m.sub;
        ws.send(JSON.stringify({ t: "subscribed", n: subs.length }));
      } else if (m.ping) ws.send('{"t":"pong"}');
    });
    timers.push(
      setInterval(() => {
        if (!state.on || !subs.length) return;
        k++;
        for (const s of subs) {
          const p = priceAt(k);
          state.last.set(s, p);
          state.sent++;
          ws.send(JSON.stringify({ t: "tick", s, p: p.toFixed(1), at: iso(CUR + 600 + k * 0.25) }));
        }
      }, 250),
    );
  });
  return { state, dispose: () => timers.forEach(clearInterval) };
}

/** Главная серия графика (LWC через __chart): число баров и последний бар. */
function lastBar(page: Page, sel = '[data-testid="terminal"]'): Promise<{ len: number; last: Bar | null }> {
  return page.evaluate((sel) => {
    type S = { data(): Bar[] };
    const el = document.querySelector(sel) as HTMLElement & { __chart: { panes(): { getSeries(): S[] }[] } };
    const d = el.__chart.panes()[0]!.getSeries()[0]!.data();
    return { len: d.length, last: d.at(-1) ?? null };
  }, sel);
}
const logical = (page: Page) =>
  page.evaluate(() => (document.querySelector('[data-testid="terminal"]') as HTMLElement & { __chart: { timeScale(): { getVisibleLogicalRange(): Range | null } } }).__chart.timeScale().getVisibleLogicalRange());
const setLogical = (page: Page, r: Range) =>
  page.evaluate((r) => (document.querySelector('[data-testid="terminal"]') as HTMLElement & { __chart: { timeScale(): { setVisibleLogicalRange(r: Range): void } } }).__chart.timeScale().setVisibleLogicalRange(r), r);
async function headerPrice(page: Page): Promise<number> {
  const text = (await page.getByLabel("состояние").textContent()) ?? "";
  const m = text.match(/цена\s*([0-9][0-9   ,]*\.?[0-9]*)/);
  return m ? Number(m[1]!.replace(/[   ,]/g, "")) : Number.NaN;
}

test("живая цена: тики каждые 250 мс двигают цену в шапке и текущую свечу, без нового бара и сброса вида", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls);
  const live = await liveSocket(page);
  try {
    await page.goto("/chart/BTCUSDT/4h");
    await expect(page.getByTestId("terminal").locator("canvas").first()).toBeVisible();
    const strip = page.getByLabel("состояние");
    await expect(strip).toContainText("онлайн");
    // пользователь приблизил график: живые обновления вид не трогают
    await expect.poll(async () => (await lastBar(page)).len).toBe(FIRST_PAGE + 1);
    await setLogical(page, { from: 180, to: 305 });
    await page.waitForTimeout(200);
    const view = (await logical(page))!;

    // цена в шапке и close текущей свечи — свежие, в пределах секунды от тика
    await expect.poll(() => headerPrice(page), { timeout: 2000 }).toBeGreaterThan(RICH_C0 + 19);
    await expect.poll(async () => (await lastBar(page)).last!.close, { timeout: 1500 }).toBeGreaterThan(RICH_C0 + 19);
    const p1 = await headerPrice(page);
    const c1 = (await lastBar(page)).last!.close;
    await expect.poll(() => headerPrice(page), { timeout: 1500 }).toBeGreaterThan(p1);
    await expect.poll(async () => (await lastBar(page)).last!.close, { timeout: 1200 }).toBeGreaterThan(c1);

    // свёртка в текущую свечу: тот же бар, low — провал первого тика, high — не ниже close
    const { len, last } = await lastBar(page);
    expect(len).toBe(FIRST_PAGE + 1);
    expect(last!.time).toBe(CUR);
    expect(last!.low).toBeCloseTo(LOW, 1);
    expect(last!.high).toBeGreaterThanOrEqual(last!.close);
    expect(Math.abs(last!.close - live.state.last.get("BTCUSDT")!)).toBeLessThan(0.5); // отстаёт не больше чем на пару тиков
    const now = (await logical(page))!;
    expect(now.from).toBeCloseTo(view.from, 1);
    expect(now.to).toBeCloseTo(view.to, 1);
    expect(calls.filter((c) => c.startsWith("/v1/chart/candles")).length).toBe(1); // без перезагрузки свечей

    // тики прекратились — через 5 с «без связи», сокет при этом открыт
    live.state.on = false;
    await expect(strip).toContainText("без связи", { timeout: 8000 });
    live.state.on = true;
    await expect(strip).toContainText("онлайн", { timeout: 2000 });
  } finally {
    live.dispose();
  }
});

test("мультичарт: ячейки получают тики своих символов", async ({ page }) => {
  const calls: string[] = [];
  await mock(page, calls);
  const live = await liveSocket(page);
  try {
    await page.goto("/multichart");
    const cells = page.getByRole("region", { name: /^график / });
    await expect(cells).toHaveCount(2);
    for (const i of [0, 1]) {
      const cell = cells.nth(i);
      await expect(cell.locator("canvas").first()).toBeVisible();
      // подпись цены в заголовке ячейки — из тиков
      await expect.poll(async () => Number(((await cell.locator(".caption").first().textContent()) ?? "").replace(/[^\d.]/g, "")), { timeout: 3000 }).toBeGreaterThan(RICH_C0 + 19);
    }
    const first = await lastBar(page, '[aria-label="график BTCUSDT 4h"] [data-testid="terminal"]');
    expect(first.len).toBe(FIRST_PAGE + 1);
    expect(first.last!.close).toBeGreaterThan(RICH_C0 + 19);
  } finally {
    live.dispose();
  }
});
