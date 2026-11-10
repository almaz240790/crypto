import { expect, test, type Page } from "@playwright/test";

/** Публичная статистика (план 3.10). Серверные данные — из e2e/mock-api.mjs, клиентские — перехват. */

async function mockClient(page: Page, authed: boolean) {
  if (authed) await page.context().addCookies([{ name: "pl_auth", value: "1", url: "http://localhost:3101" }]);
  await page.route("**/v1/auth/**", (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === "/v1/auth/refresh") return route.fulfill({ status: 200, contentType: "application/json", body: '{"access_token":"t"}' });
    if (p === "/v1/auth/me")
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: 1, email: "a@b.c", name: null, email_verified: true, role: "user", locale: "ru", timezone: "UTC", theme: "system", risk: {} }) });
    return route.fulfill({ status: 404, body: "{}" });
  });
  await page.route("**/v1/stats/export.csv**", (route) =>
    route.fulfill({ status: 200, contentType: "text/csv", headers: { "content-disposition": "attachment; filename=platform-backtest-signals.csv" }, body: "id,symbol\ns1,BTCUSDT\n" }),
  );
}

test("статистика: live пусто, бэктест с цифрами, фильтры в URL, таблица с пагинацией", async ({ page }) => {
  await mockClient(page, false);
  await page.goto("/stats");
  await expect(page.getByRole("heading", { name: "Статистика сигналов" })).toBeVisible();
  await expect(page.getByText(/Live-сигналов пока нет/)).toBeVisible();
  await page.getByRole("link", { name: "Бэктест" }).click();
  await expect(page).toHaveURL(/scope=backtest/);
  await expect(page.getByText("47.0 %").first()).toBeVisible();
  await expect(page.getByText("Прогон #3")).toBeVisible();
  await expect(page.getByRole("img", { name: /Распределение результата/ })).toBeVisible();
  await expect(page.getByText("История: 73 сигнала")).toBeVisible();
  await expect(page.getByText("страница 1 из 2")).toBeVisible();
  await page.getByRole("link", { name: "вперёд →" }).click();
  await expect(page).toHaveURL(/page=1/);
  await expect(page.getByText("страница 2 из 2")).toBeVisible();
  // фильтр градации уходит в URL и меняет цифры
  await page.getByRole("combobox", { name: "градация" }).selectOption("A");
  await page.getByRole("button", { name: "Применить" }).click();
  await expect(page).toHaveURL(/grade=A/);
  await expect(page.getByText("55.0 %").first()).toBeVisible();
  // форвард: фильтр градации переходит с вкладки на вкладку; у версии по умолчанию сделок нет
  await page.getByRole("link", { name: "Форвард-тест" }).click();
  await expect(page).toHaveURL(/scope=forward&grade=A/);
  await expect(page.getByText("По этим фильтрам сделок нет.")).toBeVisible();
  // у версии со сделками агрегаты есть, построчной истории нет
  await page.getByRole("combobox", { name: "версия стратегии" }).selectOption("1.1.0");
  await page.getByRole("button", { name: "Применить" }).click();
  await expect(page.getByText("построчная история форварда не публикуется")).toBeVisible();
  await page.getByRole("link", { name: "Бэктест" }).click();
  await expect(page.getByText("CSV —")).toBeVisible();
});

test("статистика: CSV скачивается после входа", async ({ page }) => {
  await mockClient(page, true);
  await page.goto("/stats?scope=backtest");
  const btn = page.getByRole("button", { name: "Скачать CSV" });
  await expect(btn).toBeVisible();
  const dl = page.waitForEvent("download");
  await btn.click();
  expect((await dl).suggestedFilename()).toBe("platform-backtest-signals.csv");
});

/**
 * Вкладка «Форвард-тест» (задание «сигналы», задача 2). Заглушка API по умолчанию отвечает как production
 * в день выкладки: 1.0.0 в архиве с записанной форвард-историей (40 сделок), 1.1.0 в форварде (12 сделок),
 * 1.2.0 в форварде без сделок — версия по умолчанию; плашка включена и без даты. Другие состояния API
 * (плашка с датой, плашка снята, ни одной версии в форварде) выбираются параметром run_id — см. mock-api.mjs.
 */
const PLAQUE = "Результаты форварда недействительны: из-за ошибки учёта сделки закрывались через 15 минут вместо 60 часов. Исправление и пересчёт — в работе.";
const PLAQUE_DATED = "Результаты форварда до 06.11.2026 недействительны: из-за ошибки учёта сделки закрывались через 15 минут вместо 60 часов. Исправление и пересчёт — в работе.";
const LOW_HINT = "Меньше 30 закрытых сделок: выводы по этим числам делать рано.";
const DEPARTED = "Эта версия больше не проходит форвард-тест: показана её записанная история.";
const DATED = "run_id=9001";
const NOTICE_OFF = "run_id=9002";
const NO_FORWARD = "run_id=9003";
const shown = (version: string) => `Показана версия Trend OB retest ${version}: форвард считается по каждой версии отдельно.`;
const versionSelect = (page: Page) => page.getByRole("combobox", { name: "версия стратегии" });
const closedCard = (page: Page) => page.locator("dl", { has: page.getByText("закрытых сделок", { exact: true }) }).locator("dd");
const apply = (page: Page) => page.getByRole("button", { name: "Применить" }).click();

test("форвард в день выкладки: по вкладке — версия по умолчанию без сделок, она названа и выбрана, плашка без даты", async ({ page }) => {
  await mockClient(page, false);
  // обычный путь: открыть /stats и нажать вкладку (переход без перезагрузки страницы)
  await page.goto("/stats");
  await expect(versionSelect(page)).toHaveValue("");
  await page.getByRole("link", { name: "Форвард-тест" }).click();
  await expect(page).toHaveURL(/\/stats\?scope=forward$/);
  await expect(page.getByRole("note")).toHaveText(PLAQUE);
  await expect(page.getByText(shown("1.2.0"))).toBeVisible();
  // селектор показывает ту же версию, что посчитана и названа; пункта «все» нет; 1.0.0 из архива в списке
  await expect(versionSelect(page)).toHaveValue("1.2.0");
  await expect(versionSelect(page).locator("option")).toHaveText(["Trend OB retest 1.0.0", "Trend OB retest 1.1.0", "Trend OB retest 1.2.0"]);
  await expect(page.getByText("У версии 1.2.0 пока нет форвард-сделок.")).toBeVisible();
  await expect(page.getByText("мало данных")).toHaveCount(0);
  // «Применить» с одним изменённым периодом остаётся на той же версии
  await page.getByRole("combobox", { name: "период" }).selectOption("30");
  await apply(page);
  await expect(page).toHaveURL(/scope=forward&version=1\.2\.0&days=30/);
  await expect(page.getByText(shown("1.2.0"))).toBeVisible();
  await expect(page.getByText("По этим фильтрам сделок нет.")).toBeVisible();
  // и с другой вкладки, и обратно: каждый раз селектор совпадает со страницей
  await page.getByRole("link", { name: "Live", exact: true }).click();
  await expect(page.getByText(/Live-сигналов пока нет/)).toBeVisible();
  await expect(versionSelect(page)).toHaveValue("");
  await expect(page.getByRole("combobox", { name: "период" })).toHaveValue("30");
  await page.getByRole("link", { name: "Форвард-тест" }).click();
  await expect(page.getByText(shown("1.2.0"))).toBeVisible();
  await expect(versionSelect(page)).toHaveValue("1.2.0");
});

test("форвард: версия со сделками — «мало данных» с пояснением; «сбросить» возвращает версию по умолчанию и фильтры", async ({ page }) => {
  await mockClient(page, false);
  await page.goto("/stats?scope=forward");
  await versionSelect(page).selectOption("1.1.0");
  await apply(page);
  await expect(page).toHaveURL(/scope=forward&version=1\.1\.0/);
  await expect(page.getByText(shown("1.1.0"))).toBeVisible();
  await expect(page.getByText(/больше не проходит форвард-тест/)).toHaveCount(0);
  await expect(page.getByRole("note")).toHaveText(PLAQUE);
  // числа не скрыты, только помечены: 12 закрытых < 30; пояснение — видимым текстом, а не подсказкой
  await expect(closedCard(page)).toContainText(/^12\s*мало данных/);
  await expect(page.getByText(LOW_HINT)).toBeVisible();
  await expect(page.getByText("построчная история форварда не публикуется")).toBeVisible();
  // фильтр, затем «сбросить» (ссылка, переход без перезагрузки)
  const grade = page.getByRole("combobox", { name: "градация" });
  await grade.selectOption("A");
  await apply(page);
  await expect(page).toHaveURL(/version=1\.1\.0.*grade=A/);
  await expect(versionSelect(page)).toHaveValue("1.1.0");
  await page.getByRole("link", { name: "сбросить" }).click();
  await expect(page).toHaveURL(/\/stats\?scope=forward$/);
  await expect(page.getByText(shown("1.2.0"))).toBeVisible();
  await expect(versionSelect(page)).toHaveValue("1.2.0");
  await expect(grade).toHaveValue("");
  await expect(page.getByRole("link", { name: "сбросить" })).toHaveCount(0);
});

test("форвард: версия в архиве показывает записанную историю, а не «пока нет сделок»", async ({ page }) => {
  await mockClient(page, false);
  await page.goto("/stats?scope=forward");
  await versionSelect(page).selectOption("1.0.0");
  await apply(page);
  await expect(page).toHaveURL(/scope=forward&version=1\.0\.0/);
  await expect(page.getByText(shown("1.0.0"))).toBeVisible();
  await expect(page.getByText(DEPARTED)).toBeVisible();
  await expect(versionSelect(page)).toHaveValue("1.0.0");
  await expect(closedCard(page)).toContainText(/^40/);
  await expect(page.getByText("мало данных")).toHaveCount(0);
  await expect(page.getByText(LOW_HINT)).toHaveCount(0);
  await expect(page.getByText(/пока нет форвард-сделок/)).toHaveCount(0);
  await expect(page.getByRole("note")).toHaveText(PLAQUE);
  await expect(page.getByText("построчная история форварда не публикуется")).toBeVisible();

  // версия в архиве без форвард-истории, открытая по адресу: не «пока нет», она форвард не проходит
  await page.goto("/stats?scope=forward&version=0.9.0");
  await expect(page.getByText("Версия 0.9.0 сейчас не проходит форвард-тест, форвард-статистики по ней нет.")).toBeVisible();
  await expect(page.getByText(/пока нет форвард-сделок/)).toHaveCount(0);
  await expect(page.getByText(DEPARTED)).toHaveCount(0);
  await expect(versionSelect(page)).toHaveValue("0.9.0");
  await expect(versionSelect(page).locator("option")).toHaveText(["Trend OB retest 0.9.0", "Trend OB retest 1.0.0", "Trend OB retest 1.1.0", "Trend OB retest 1.2.0"]);

  // опечатка в версии — не «API недоступен», а версия по умолчанию
  await page.goto("/stats?scope=forward&version=9.9.9");
  await expect(page.getByText(shown("1.2.0"))).toBeVisible();
  await expect(versionSelect(page)).toHaveValue("1.2.0");
});

test("форвард: плашка с датой, выключенная плашка; на live и бэктесте плашки нет", async ({ page }) => {
  await mockClient(page, false);
  await page.goto(`/stats?scope=forward&${DATED}`);
  await expect(page.getByRole("note")).toHaveText(PLAQUE_DATED);
  await expect(page.getByText(shown("1.2.0"))).toBeVisible();

  // плашку сняли (FORWARD_NOTICE=false): остальное на месте
  await page.goto(`/stats?scope=forward&version=1.1.0&${NOTICE_OFF}`);
  await expect(page.getByText(shown("1.1.0"))).toBeVisible();
  await expect(page.getByRole("note")).toHaveCount(0);
  await expect(closedCard(page)).toContainText(/^12\s*мало данных/);
  await expect(page.getByText(LOW_HINT)).toBeVisible();

  // у live в селекторе по-прежнему есть «все»
  await page.goto("/stats");
  await expect(page.getByRole("note")).toHaveCount(0);
  await expect(versionSelect(page).locator("option").first()).toHaveText("все");
  await page.goto("/stats?scope=backtest");
  await expect(page.getByText("Прогон #3")).toBeVisible();
  await expect(page.getByRole("note")).toHaveCount(0);
  await expect(page.getByText("мало данных")).toHaveCount(0);
});

test("форвард: ни одной версии в форварде", async ({ page }) => {
  await mockClient(page, false);
  await page.goto(`/stats?scope=forward&${NO_FORWARD}`);
  await expect(page.getByText("Ни одна версия стратегии сейчас не проходит форвард-тест.")).toBeVisible();
  await expect(page.getByText(/Показана версия/)).toHaveCount(0);
  await expect(page.getByRole("note")).toHaveText(PLAQUE);
  // версия не показана — в селекторе не выбрана ни одна; записанная история ушедших версий доступна
  await expect(versionSelect(page)).toHaveValue("");
  await expect(versionSelect(page).locator("option")).toHaveText(["—", "Trend OB retest 1.0.0", "Trend OB retest 1.1.0"]);
  await page.goto(`/stats?scope=forward&version=1.1.0&${NO_FORWARD}`);
  await expect(page.getByText(shown("1.1.0"))).toBeVisible();
  await expect(page.getByText(DEPARTED)).toBeVisible();
  await expect(closedCard(page)).toContainText(/^12\s*мало данных/);
  await expect(versionSelect(page)).toHaveValue("1.1.0");
  await expect(versionSelect(page).locator("option")).toHaveText(["Trend OB retest 1.0.0", "Trend OB retest 1.1.0"]);
});

test("форвард по-английски: плашка с датой и без, пометка и пояснения", async ({ page }) => {
  await mockClient(page, false);
  await page.context().addCookies([{ name: "pl_locale", value: "en", url: "http://localhost:3101" }]);
  await page.goto("/stats?scope=forward");
  await expect(page.getByRole("note")).toHaveText(
    "Forward-test results are invalid: because of an accounting error, trades were closed after 15 minutes instead of 60 hours. A fix and a recalculation are in progress.",
  );
  await expect(page.getByText("Version 1.2.0 has no forward-test trades yet.")).toBeVisible();
  await page.goto(`/stats?scope=forward&version=1.1.0&${DATED}`);
  await expect(page.getByRole("note")).toHaveText(
    "Forward-test results before 06.11.2026 are invalid: because of an accounting error, trades were closed after 15 minutes instead of 60 hours. A fix and a recalculation are in progress.",
  );
  await expect(page.getByText("Showing version Trend OB retest 1.1.0: the forward test is counted separately for each version.")).toBeVisible();
  await expect(page.getByText("not enough data")).toBeVisible();
  await expect(page.getByText("Fewer than 30 closed trades: it is too early to draw conclusions from these numbers.")).toBeVisible();
  await page.goto("/stats?scope=forward&version=1.0.0");
  await expect(page.getByText("This version is no longer in forward testing: its recorded history is shown.")).toBeVisible();
  await page.goto("/stats?scope=forward&version=0.9.0");
  await expect(page.getByText("Version 0.9.0 is not in forward testing now; there are no forward-test statistics for it.")).toBeVisible();
  await page.goto(`/stats?scope=forward&${NO_FORWARD}`);
  await expect(page.getByText("No strategy version is in forward testing right now.")).toBeVisible();
});

test.describe("форвард на телефоне", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("плашка стоит с тем же шагом, что остальные блоки; пояснение «мало данных» читается без наведения", async ({ page }) => {
    await mockClient(page, false);
    await page.goto(`/stats?scope=forward&version=1.1.0&${DATED}`);
    const plaque = page.getByRole("note");
    const note = page.locator("p", { hasText: "Показана версия" });
    const filters = page.locator("form", { has: versionSelect(page) });
    await expect(plaque).toHaveText(PLAQUE_DATED);
    const box = async (l: typeof plaque) => (await l.boundingBox())!;
    const [a, b, c] = [await box(plaque), await box(note), await box(filters)];
    const gap = c.y - (b.y + b.height);
    expect(gap).toBeGreaterThan(0);
    expect(Math.abs(b.y - (a.y + a.height) - gap)).toBeLessThan(0.5);
    // пояснение к пометке — обычный текст в блоке карточек: видно сразу, в пределах экрана
    await expect(closedCard(page)).toContainText(/^12\s*мало данных/);
    const hint = page.getByText(LOW_HINT);
    await expect(hint).toBeVisible();
    await hint.scrollIntoViewIfNeeded();
    const h = await box(hint);
    expect(h.x).toBeGreaterThanOrEqual(0);
    expect(h.x + h.width).toBeLessThanOrEqual(390);
    // страница не шире экрана
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});

test("статистика на телефоне: текст не прилегает к краю экрана", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockClient(page, false);
  await page.goto("/stats?scope=forward");
  const h = page.getByRole("heading", { name: "Статистика сигналов" });
  await expect(h).toBeVisible();
  const box = await h.boundingBox();
  expect(box?.x ?? 0).toBeGreaterThanOrEqual(12);
});
