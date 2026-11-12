import { expect, test, type Page } from "@playwright/test";
import { mock, type MockServer } from "./helpers/chart";

/**
 * Синхронизация рисунков с входом (план 2A.5, 2B.7; аудит FI-1, FI-2, DTS-1…DTS-4). Заглушка API — по правилам сервера
 * (helpers/chart, mock): чтение по инструменту и курсору, последняя запись побеждает, рисунок не переходит на другой
 * инструмент, лимит тарифа, отказы — по рисунку. Проверяется состояние после ответа синхронизации и после перезагрузки:
 * раньше отмена откатывалась ответом сервера, копия оставалась призраком на исходном графике, рисунок из очереди
 * переезжал на новый инструмент, офлайн-рисунок не доходил до другого устройства, один отказ останавливал очередь.
 */

type Pt = { time: number; price: number };
type Row = { client_id: string; symbol: string; points: Pt[]; levels: number[] | null; updated_at: number; deleted_at: number | null };
type Local = { id: string; points: Pt[]; levels?: number[]; deleted_at?: number | null };

const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.705, 0.786, 1, 1.272, 1.618];
const rows = (server: MockServer, symbol = "BTCUSDT") => (server.drawings as unknown as Row[]).filter((d) => d.symbol === symbol);
const alive = (server: MockServer, symbol = "BTCUSDT") => rows(server, symbol).filter((d) => !d.deleted_at);
/** Рисунки инструмента в памяти устройства (без удалённых). */
const local = (page: Page, symbol = "BTCUSDT") => page.evaluate((s) => (JSON.parse(localStorage.getItem(`pl-drawings:${s}`) ?? "[]") as Local[]).filter((d) => !d.deleted_at), symbol);
const queue = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("pl-drawings-queue") ?? "[]") as Row[]);
/** Набор уровней для новых Фибоначчи — в настройках терминала. */
const remembered = (page: Page) => page.evaluate(() => (JSON.parse(localStorage.getItem("pl-terminal") ?? "{}") as { fibLevels?: number[] }).fibLevels ?? null);
const count = (page: Page) => page.getByTestId("drawings-count");
const undoButton = (page: Page) => page.getByRole("toolbar", { name: "панель рисования" }).getByRole("button", { name: "отменить", exact: true });
const card = (page: Page) => page.getByRole("region", { name: "выбранный рисунок" });

/** Очередь отправлена, ответ сервера применён — и ещё секунда: откат ответом синхронизации успел бы проявиться. */
async function settled(page: Page) {
  await expect.poll(() => queue(page), { timeout: 10000 }).toEqual([]);
  await expect(page.getByTestId("drawings-sync")).toHaveText("синхронизировано");
  await page.waitForTimeout(1000);
}

async function open(page: Page, server: MockServer, symbol = "BTCUSDT") {
  await mock(page, [], true, server);
  await page.goto(`/chart/${symbol}/4h`);
  const term = page.getByTestId("terminal");
  await expect(term.locator("canvas").first()).toBeVisible();
  await expect(count(page)).toHaveText(/рисунков: \d+/);
  const b = (await term.boundingBox())!;
  return { X: (f: number) => b.x + b.width * f, Y: (f: number) => b.y + b.height * f };
}

/** Горизонтальная линия: Alt+H и нажатие в график (рисунок выбран, инструмент снят). */
async function hline(page: Page, x: number, y: number) {
  await page.keyboard.press("Alt+h");
  await page.mouse.click(x, y);
}

/** y цены на странице — по шкале основной серии. */
const priceY = (page: Page, price: number) =>
  page.evaluate((price) => {
    type Chart = { panes(): { getSeries(): { priceToCoordinate(p: number): number | null }[] }[] };
    const el = document.querySelector('[data-testid="terminal"]') as HTMLElement & { __chart: Chart };
    return el.getBoundingClientRect().top + el.__chart.panes()[0]!.getSeries()[0]!.priceToCoordinate(price)!;
  }, price);

/** Призрак копии от прежней сборки: копия на ETHUSDT, а её id — и в памяти и очереди BTCUSDT. */
const GHOST = { client_id: "d_ghostcopy1", symbol: "ETHUSDT", timeframe: null, type: "hline", points: [{ time: 1_792_000_000, price: 2600 }], style: { color: "text2", width: 1, dashed: false }, text: null, levels: null, locked: false, updated_at: 1_000, deleted_at: null };
const seedGhost = (page: Page) =>
  page.addInitScript((g) => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem("pl-drawings:BTCUSDT", JSON.stringify([{ id: g.client_id, type: g.type, points: g.points, style: g.style, locked: false, timeframe: null, updated_at: g.updated_at, deleted_at: null }]));
    localStorage.setItem("pl-drawings-queue", JSON.stringify([{ ...g, symbol: "BTCUSDT" }]));
  }, GHOST);

test.describe("синхронизация рисунков с входом", () => {
  test("отмена правки уровней Фибоначчи и отмена его создания доходят до сервера: после ответа и перезагрузки — как после отмены", async ({ page }) => {
    const server: MockServer = { drawings: [], layout: null };
    const { X, Y } = await open(page, server);
    await page.getByRole("toolbar", { name: "панель рисования" }).getByRole("button", { name: "Фибоначчи" }).click();
    await page.mouse.click(X(0.3), Y(0.62));
    await page.mouse.click(X(0.45), Y(0.38));
    await expect(count(page)).toHaveText("рисунков: 1");
    await expect.poll(() => rows(server).length, { timeout: 10000 }).toBe(1);
    await card(page).getByRole("button", { name: /уровни/ }).click();
    await card(page).getByRole("group", { name: "уровни Фибоначчи" }).getByRole("button", { name: "−0.618", exact: true }).click();
    await expect.poll(() => rows(server)[0]!.levels, { timeout: 10000 }).toEqual([-0.618, ...FIB]);
    await settled(page);

    // отмена — новая версия рисунка: сервер принимает её, его ответ отмену не откатывает
    await undoButton(page).click();
    await expect.poll(() => rows(server)[0]!.levels, { timeout: 10000 }).toEqual(FIB);
    await settled(page);
    expect((await local(page))[0]!.levels).toEqual(FIB);
    expect(await remembered(page)).toEqual(FIB);
    await page.reload();
    await expect(count(page)).toHaveText("рисунков: 1");
    await settled(page);
    expect((await local(page))[0]!.levels).toEqual(FIB);

    // отмена создания (после перезагрузки истории нет — рисуем заново): удаление уходит на сервер
    await page.getByRole("toolbar", { name: "панель рисования" }).getByRole("button", { name: "Фибоначчи" }).click();
    await page.mouse.click(X(0.55), Y(0.62));
    await page.mouse.click(X(0.7), Y(0.38));
    await expect(count(page)).toHaveText("рисунков: 2");
    await expect.poll(() => alive(server).length, { timeout: 10000 }).toBe(2);
    await settled(page);
    await undoButton(page).click();
    await expect(count(page)).toHaveText("рисунков: 1");
    await expect.poll(() => alive(server).length, { timeout: 10000 }).toBe(1);
    await settled(page);
    await expect(count(page)).toHaveText("рисунков: 1");
    await page.reload();
    await expect(count(page)).toHaveText("рисунков: 1");
    await settled(page);
    await expect(count(page)).toHaveText("рисунков: 1");
  });

  test("отмена удаления, перетаскивания и создания линии доходит до сервера: после ответа и перезагрузки — как после отмены", async ({ page }) => {
    const server: MockServer = { drawings: [], layout: null };
    const { X, Y } = await open(page, server);
    await hline(page, X(0.4), Y(0.5));
    await expect(count(page)).toHaveText("рисунков: 1");
    await expect.poll(() => rows(server).length, { timeout: 10000 }).toBe(1);
    await settled(page);

    // удаление клавишей и Ctrl+Z: линия остаётся
    await page.keyboard.press("Delete");
    await expect(count(page)).toHaveText("рисунков: 0");
    await expect.poll(() => rows(server)[0]!.deleted_at, { timeout: 10000 }).not.toBeNull();
    await settled(page);
    await page.keyboard.press("Control+z");
    await expect(count(page)).toHaveText("рисунков: 1");
    await expect.poll(() => rows(server)[0]!.deleted_at, { timeout: 10000 }).toBeNull();
    await settled(page);
    await expect(count(page)).toHaveText("рисунков: 1");

    // перетаскивание линии на 80 px вниз и Ctrl+Z: линия на прежней цене
    const before = rows(server)[0]!.points[0]!.price;
    const y0 = await priceY(page, before);
    await page.mouse.click(X(0.6), y0);
    await expect(card(page)).toBeVisible();
    await page.mouse.move(X(0.6), y0);
    await page.mouse.down();
    await page.mouse.move(X(0.6), y0 + 40, { steps: 5 });
    await page.mouse.move(X(0.6), y0 + 80, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => rows(server)[0]!.points[0]!.price, { timeout: 10000 }).toBeLessThan(before);
    await settled(page);
    await page.keyboard.press("Control+z");
    await expect.poll(() => rows(server)[0]!.points[0]!.price, { timeout: 10000 }).toBe(before);
    await settled(page);
    expect((await local(page))[0]!.points[0]!.price).toBe(before);

    // ещё Ctrl+Z — отмена создания: линия удалена и на сервере, после перезагрузки её нет
    await page.keyboard.press("Control+z");
    await expect(count(page)).toHaveText("рисунков: 0");
    await expect.poll(() => rows(server)[0]!.deleted_at, { timeout: 10000 }).not.toBeNull();
    await settled(page);
    await expect(count(page)).toHaveText("рисунков: 0");
    await page.reload();
    await expect(count(page)).toHaveText("рисунков: 0");
    await settled(page);
    await expect(count(page)).toHaveText("рисунков: 0");
    // повтор после перезагрузки недоступен, линия жива только если её вернуть — сервер остался с удалением
    expect(alive(server)).toEqual([]);
  });

  test("копия на другой инструмент: на исходном графике призрака нет, на сервере копия у цели", async ({ page }) => {
    const server: MockServer = { drawings: [], layout: null };
    const { X, Y } = await open(page, server);
    await hline(page, X(0.4), Y(0.55));
    await expect.poll(() => rows(server).length, { timeout: 10000 }).toBe(1);
    const own = rows(server)[0]!.client_id;
    await card(page).getByLabel("скопировать на инструмент").selectOption("ETHUSDT");
    await expect(page.getByRole("status")).toContainText("Рисунок скопирован на ETHUSDT");
    await expect.poll(() => rows(server, "ETHUSDT").length, { timeout: 10000 }).toBe(1);
    await settled(page);
    await expect(count(page)).toHaveText("рисунков: 1");
    expect((await local(page)).map((d) => d.id)).toEqual([own]);
    await page.reload();
    await expect(count(page)).toHaveText("рисунков: 1");
    await settled(page);
    expect(rows(server).map((d) => d.client_id)).toEqual([own]);
    const copy = alive(server, "ETHUSDT")[0]!.client_id;
    expect(copy).not.toBe(own);
    await page.goto("/chart/ETHUSDT/4h");
    await expect(count(page)).toHaveText("рисунков: 1");
    await settled(page);
    expect((await local(page, "ETHUSDT")).map((d) => d.id)).toEqual([copy]);
  });

  test("рисунок в очереди и смена инструмента: он не переезжает на новый инструмент, сервер получает его у своего", async ({ page }) => {
    const server: MockServer = { drawings: [], layout: null };
    const { X, Y } = await open(page, server);
    let down = true;
    await page.route("**/v1/drawings", (r) => (down && r.request().method() === "PUT" ? r.fulfill({ status: 503, contentType: "application/json", body: "{}" }) : r.fallback()));
    await hline(page, X(0.4), Y(0.5));
    await expect(count(page)).toHaveText("рисунков: 1");
    await expect(page.getByTestId("drawings-sync")).toHaveText("в очереди");
    down = false;
    // загрузка нового инструмента отправляет общую очередь: ответ про BTCUSDT в рисунки ETHUSDT не попадает
    await page.getByLabel("инструмент", { exact: true }).selectOption("ETHUSDT");
    await expect(page).toHaveURL(/\/chart\/ETHUSDT\/4h$/);
    await expect.poll(() => rows(server).length, { timeout: 10000 }).toBe(1);
    await settled(page);
    await expect(count(page)).toHaveText("рисунков: 0");
    expect(await local(page, "ETHUSDT")).toEqual([]);
    expect(rows(server, "ETHUSDT")).toEqual([]);
    await page.getByLabel("инструмент", { exact: true }).selectOption("BTCUSDT");
    await expect(page).toHaveURL(/\/chart\/BTCUSDT\/4h$/);
    await expect(count(page)).toHaveText("рисунков: 1");
  });

  test("призрак копии, оставленный прежней сборкой, убирается с исходного графика; копия на целевом не трогается", async ({ page }) => {
    const server: MockServer = { drawings: [{ ...GHOST, __seq: 1 }], layout: null };
    await seedGhost(page);
    await open(page, server);
    await expect(count(page)).toHaveText("рисунков: 0");
    await settled(page);
    expect(await local(page)).toEqual([]);
    expect(rows(server, "ETHUSDT")).toMatchObject([{ client_id: GHOST.client_id, updated_at: 1_000, deleted_at: null }]);
    await page.reload();
    await expect(count(page)).toHaveText("рисунков: 0");
  });

  test("убранный призрак не возвращается отменой: его нет и в истории шагов", async ({ page }) => {
    const server: MockServer = { drawings: [{ ...GHOST, __seq: 1 }], layout: null };
    await seedGhost(page);
    await mock(page, [], true, server);
    // ответ на отправку очереди задержан: линия нарисована, пока призрак ещё на графике (он попадает в шаг отмены)
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sent: string[][] = [];
    await page.route("**/v1/drawings", async (r) => {
      if (r.request().method() !== "PUT") return r.fallback();
      sent.push((r.request().postDataJSON() as Row[]).map((d) => d.client_id));
      await gate;
      return r.fallback();
    });
    await page.goto("/chart/BTCUSDT/4h");
    const term = page.getByTestId("terminal");
    await expect(term.locator("canvas").first()).toBeVisible();
    await expect(count(page)).toHaveText("рисунков: 1");
    await expect.poll(() => sent.length, { timeout: 10000 }).toBeGreaterThan(0);
    const b = (await term.boundingBox())!;
    await hline(page, b.x + b.width * 0.4, b.y + b.height * 0.5);
    await expect(count(page)).toHaveText("рисунков: 2");
    // и линия ушла в очередь второй отправкой — тоже задержанной
    await expect.poll(() => sent.length, { timeout: 10000 }).toBe(2);
    release();
    await settled(page);
    await expect(count(page)).toHaveText("рисунков: 1");
    // отмена линии: призрак не оживает и снова на сервер не уходит
    const before = sent.length;
    await page.keyboard.press("Control+z");
    await expect(count(page)).toHaveText("рисунков: 0");
    await settled(page);
    expect(sent.slice(before).flat()).not.toContain(GHOST.client_id);
    expect(await local(page)).toEqual([]);
  });

  test("рисунок, нарисованный, пока шла отправка предыдущего, уходит на сервер следом: ответ не отменяет отправку", async ({ page }) => {
    const server: MockServer = { drawings: [], layout: null };
    await mock(page, [], true, server);
    // ответ на первую отправку задержан: вторая линия нарисована, пока запрос идёт
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let puts = 0;
    await page.route("**/v1/drawings", async (r) => {
      if (r.request().method() !== "PUT") return r.fallback();
      if (++puts === 1) await gate;
      return r.fallback();
    });
    await page.goto("/chart/BTCUSDT/4h");
    const term = page.getByTestId("terminal");
    await expect(term.locator("canvas").first()).toBeVisible();
    const b = (await term.boundingBox())!;
    await hline(page, b.x + b.width * 0.4, b.y + b.height * 0.4);
    await expect.poll(() => puts, { timeout: 10000 }).toBe(1);
    await page.keyboard.press("Escape");
    await hline(page, b.x + b.width * 0.4, b.y + b.height * 0.6);
    await expect(count(page)).toHaveText("рисунков: 2");
    // ответ про первую линию приходит раньше, чем истекла задержка отправки второй
    release();
    await expect.poll(() => alive(server).length, { timeout: 10000 }).toBe(2);
    await settled(page);
  });

  test("рисунок, нарисованный офлайн раньше прочитанных, приходит на другое устройство: курсор чтения — серверный", async ({ page, browser }) => {
    const server: MockServer = { drawings: [], layout: null };
    // устройство B без сети: рисунок Z остаётся в очереди
    const { X, Y } = await open(page, server);
    let offline = true;
    await page.route("**/v1/drawings", (r) => (offline && r.request().method() === "PUT" ? r.abort("internetdisconnected") : r.fallback()));
    await hline(page, X(0.4), Y(0.62));
    await expect(page.getByTestId("drawings-sync")).toHaveText("в очереди");
    // устройство C рисует Y (позже Z) и перезагружается: прочитано всё до Y
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    const c = await ctx.newPage();
    const C = await open(c, server);
    await hline(c, C.X(0.4), C.Y(0.38));
    await expect.poll(() => rows(server).length, { timeout: 10000 }).toBe(1);
    await c.reload();
    await expect(count(c)).toHaveText("рисунков: 1");
    await settled(c);
    // B снова в сети: Z записан на сервер позже чтения C, но с меткой времени раньше Y
    offline = false;
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => rows(server).length, { timeout: 10000 }).toBe(2);
    expect(rows(server)[1]!.updated_at).toBeLessThan(rows(server)[0]!.updated_at);
    await c.reload();
    await expect(count(c)).toHaveText("рисунков: 2");
    await ctx.close();
  });

  test("отказ сервера по лимиту не останавливает очередь: пользователь видит причину, остальные правки синхронизируются", async ({ page }) => {
    // на ETHUSDT уже 100 рисунков (другое устройство, тариф Pro): копия туда сверх лимита
    const full = Array.from({ length: 100 }, (_, i) => ({ client_id: `d_full${i}`, symbol: "ETHUSDT", timeframe: null, type: "hline", points: [{ time: 1_792_000_000, price: 2000 + i }], style: { color: "text2", width: 1, dashed: false }, text: null, levels: null, locked: false, updated_at: 1_000 + i, deleted_at: null, __seq: 1 }));
    const server: MockServer = { drawings: full, layout: null, plan: "pro" };
    const { X, Y } = await open(page, server);
    await hline(page, X(0.4), Y(0.5));
    await expect.poll(() => alive(server).length, { timeout: 10000 }).toBe(1);
    await card(page).getByLabel("скопировать на инструмент").selectOption("ETHUSDT");
    await expect(page.getByRole("status")).toContainText("Лимит рисунков на ETHUSDT исчерпан: рисунок сохранён только на этом устройстве");
    await settled(page);
    expect(alive(server, "ETHUSDT")).toHaveLength(100);
    expect(await queue(page)).toEqual([]);
    // следующая правка на BTCUSDT доходит до сервера
    await page.keyboard.press("Escape");
    await hline(page, X(0.4), Y(0.3));
    await expect(count(page)).toHaveText("рисунков: 2");
    await expect.poll(() => alive(server).length, { timeout: 10000 }).toBe(2);
    await settled(page);
    await expect(count(page)).toHaveText("рисунков: 2");
  });
});

test("API прежней сборки (без курсора и отказов по рисунку): рисунки синхронизируются, курсор не запоминается", async ({ page }) => {
  // веб и API выкладываются отдельно: новый клиент со старым API — чтение по since (без него — всё), ответ без cursor
  const server: MockServer = { drawings: [], layout: null };
  const reads: string[] = [];
  await mock(page, [], true, server);
  await page.route(
    (u) => u.pathname === "/v1/drawings",
    (r) => {
      const json = (body: unknown) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
      if (r.request().method() === "GET") {
        const u = new URL(r.request().url());
        reads.push(u.search);
        const since = Number(u.searchParams.get("since") ?? 0);
        return json({ symbol: "BTCUSDT", items: rows(server).filter((d) => d.updated_at > since), limit: null, sync: true });
      }
      const items = r.request().postDataJSON() as Row[];
      for (const it of items) {
        const i = server.drawings.findIndex((d) => d.client_id === it.client_id);
        const cur = (server.drawings[i] as unknown as Row | undefined) ?? null;
        if (cur && (it.updated_at < cur.updated_at || (it.updated_at === cur.updated_at && !it.deleted_at))) continue;
        if (i >= 0) server.drawings[i] = it;
        else server.drawings.push(it);
      }
      return json({ items: items.map((it) => server.drawings.find((d) => d.client_id === it.client_id)) });
    },
  );
  await page.goto("/chart/BTCUSDT/4h");
  const term = page.getByTestId("terminal");
  await expect(term.locator("canvas").first()).toBeVisible();
  const b = (await term.boundingBox())!;
  await hline(page, b.x + b.width * 0.4, b.y + b.height * 0.5);
  await expect.poll(() => rows(server).length, { timeout: 10000 }).toBe(1);
  await settled(page);
  await page.keyboard.press("Delete");
  await expect.poll(() => rows(server)[0]!.deleted_at, { timeout: 10000 }).not.toBeNull();
  await page.keyboard.press("Control+z");
  await expect.poll(() => rows(server)[0]!.deleted_at, { timeout: 10000 }).toBeNull();
  await settled(page);
  await page.reload();
  await expect(count(page)).toHaveText("рисунков: 1");
  await settled(page);
  expect(reads.length).toBeGreaterThanOrEqual(2);
  expect(reads.every((q) => !q.includes("cursor"))).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem("pl-drawings-cursor:BTCUSDT"))).toBeNull();
});

test("копия на инструмент с исчерпанным лимитом (без входа — 10): не копируется, причина — в сообщении", async ({ page }) => {
  const line = (i: number) => ({ id: `d_eth${i}`, type: "hline", points: [{ time: 1_792_000_000, price: 2000 + i }], style: { color: "text2", width: 1, dashed: false }, locked: false, timeframe: null, updated_at: 1_000 + i });
  await page.addInitScript((items) => localStorage.setItem("pl-drawings:ETHUSDT", JSON.stringify(items)), Array.from({ length: 10 }, (_, i) => line(i)));
  await mock(page, []);
  await page.goto("/chart/BTCUSDT/4h");
  const term = page.getByTestId("terminal");
  await expect(term.locator("canvas").first()).toBeVisible();
  const b = (await term.boundingBox())!;
  await hline(page, b.x + b.width * 0.4, b.y + b.height * 0.5);
  await expect(count(page)).toHaveText("рисунков: 1");
  await card(page).getByLabel("скопировать на инструмент").selectOption("ETHUSDT");
  await expect(page.getByRole("status")).toContainText("Лимит рисунков на ETHUSDT: 10. Рисунок не скопирован");
  expect(await local(page, "ETHUSDT")).toHaveLength(10);
  await expect(count(page)).toHaveText("рисунков: 1");
});
