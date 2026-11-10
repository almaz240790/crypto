import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { navFor, NAV } from "@/components/app/nav";
import { TestModeBadge, TestModeNote } from "@/components/signals/TestMode";
import en from "@/i18n/en.json";
import { needsLogin } from "@/proxy";
import {
  DEFAULT_FILTERS,
  effectiveScope,
  filtersFromSearch,
  filtersToSearch,
  signalsLinkHref,
  signalsLinkOf,
  scopeTabs,
  statusToast,
  TEST_BADGE,
  TEST_LINE,
} from "./signals";

/** Тестовые сигналы видны зарегистрированным (ADR-0013): область ленты, вкладки, пометка, меню, доступ гостя. */
describe("область ленты", () => {
  it("явный выбор из адреса; без него — пусто (решает сервер), мусор — пусто", () => {
    expect(DEFAULT_FILTERS.scope).toBe("");
    expect(filtersFromSearch(new URLSearchParams("scope=forward")).scope).toBe("forward");
    expect(filtersFromSearch(new URLSearchParams("scope=live")).scope).toBe("live");
    expect(filtersFromSearch(new URLSearchParams("")).scope).toBe("");
    expect(filtersFromSearch(new URLSearchParams("scope=backtest")).scope).toBe("");
    expect(filtersToSearch({ ...DEFAULT_FILTERS, scope: "forward" })).toBe("?scope=forward");
    expect(filtersToSearch(DEFAULT_FILTERS)).toBe("");
  });

  it("без явного выбора — по сводке: тестовые, пока нет live; сводка не пришла — запрос рано; ошибка или старый API — live", () => {
    expect(effectiveScope({ scope: "" }, { default_scope: "forward" })).toBe("forward");
    expect(effectiveScope({ scope: "" }, { default_scope: "live" })).toBe("live");
    expect(effectiveScope({ scope: "" }, undefined)).toBeNull();
    expect(effectiveScope({ scope: "" }, null)).toBe("live");
    expect(effectiveScope({ scope: "" }, {})).toBe("live");
    expect(effectiveScope({ scope: "live" }, { default_scope: "forward" })).toBe("live");
    expect(effectiveScope({ scope: "forward" }, undefined)).toBe("forward");
  });

  it("вкладки «Live» / «Тестовые»: только когда тестовые доступны и есть куда переключиться", () => {
    const onlyTest = { default_scope: "forward" as const, live_available: false, test_available: true };
    expect(scopeTabs("forward", onlyTest)).toEqual([]);
    expect(scopeTabs("live", onlyTest)).toEqual(["live", "forward"]); // открыта не та область — есть путь назад
    const both = { default_scope: "live" as const, live_available: true, test_available: true };
    expect(scopeTabs("live", both)).toEqual(["live", "forward"]);
    expect(scopeTabs("forward", both)).toEqual(["live", "forward"]);
    expect(scopeTabs("live", { default_scope: "live", live_available: true, test_available: false })).toEqual([]);
    expect(scopeTabs("live", null)).toEqual([]);
  });
});

describe("пометка «Тестовый режим»", () => {
  it("одна строка пояснения: проверка на живых данных, результаты не подтверждены, не рекомендация; без обещаний", () => {
    expect(TEST_BADGE).toBe("Тестовый режим");
    expect(TEST_LINE).toMatch(/проходит проверку на живых данных/);
    expect(TEST_LINE).toMatch(/Результаты не подтверждены/);
    expect(TEST_LINE).toMatch(/Не является инвестиционной рекомендацией/);
    // запрещённые формулировки собраны из частей, чтобы check-texts не находил их в самом тесте
    for (const banned of [["сигнал на", "покупку"].join(" "), "доходн", "прибыл", "гарантир", ["ии", "предсказ"].join(" ")]) expect(TEST_LINE.toLowerCase()).not.toContain(banned);
    expect((en as Record<string, string>)[TEST_BADGE]).toBe("Test mode");
    expect((en as Record<string, string>)[TEST_LINE]).toMatch(/Not investment advice/);
  });

  it("плашка и строка пояснения в разметке", () => {
    const badge = renderToStaticMarkup(createElement(TestModeBadge));
    expect(badge).toContain('data-testid="test-badge"');
    expect(badge).toContain("Тестовый режим");
    expect(badge).toContain(`title="${TEST_LINE}"`);
    expect(renderToStaticMarkup(createElement(TestModeBadge, { short: true }))).toContain(">тест<");
    const note = renderToStaticMarkup(createElement(TestModeNote));
    expect(note).toContain('role="note"');
    expect(note).toContain("Тестовый режим");
    expect(note).toContain(TEST_LINE);
  });

  it("сообщение о смене статуса по WebSocket: у тестового сигнала — с пометкой, у live — без", () => {
    expect(statusToast({ scope: "forward" }, "BTCUSDT", "в работе", "Тестовый режим")).toBe("Тестовый режим · BTCUSDT: в работе");
    expect(statusToast({ scope: "live" }, "BTCUSDT", "TP1", "Тестовый режим")).toBe("BTCUSDT: TP1");
    expect(statusToast({}, "ETHUSDT", "стоп", "Тестовый режим")).toBe("ETHUSDT: стоп");
  });

  it("ссылка «сигналов по инструменту» с графика: все тестовые — в тестовую область", () => {
    expect(signalsLinkOf("BTCUSDT", [])).toBeNull();
    expect(signalsLinkOf("BTCUSDT", undefined)).toBeNull();
    const test = signalsLinkOf("BTCUSDT", [{ scope: "forward" }, { scope: "forward" }])!;
    expect(test).toEqual({ symbol: "BTCUSDT", n: 2, test: true });
    expect(signalsLinkHref(test)).toBe("/signals?symbol=BTCUSDT&tab=all&scope=forward");
    const mixed = signalsLinkOf("BTCUSDT", [{ scope: "forward" }, { scope: "live" }])!;
    expect(mixed.test).toBe(false);
    expect(signalsLinkHref(mixed)).toBe("/signals?symbol=BTCUSDT&tab=all");
  });
});

describe("меню и доступ гостя", () => {
  it("«Сигналы» в меню только вошедшим, с пометкой «тест»", () => {
    const signals = NAV.find((n) => n.href === "/signals");
    expect(signals).toMatchObject({ label: "Сигналы", authed: true, badge: "тест" });
    expect(navFor(false).map((n) => n.href)).toEqual(["/chart", "/screener", "/alerts"]);
    expect(navFor(true).map((n) => n.href)).toEqual(["/chart", "/screener", "/alerts", "/signals"]);
  });

  it("/signals открыта гостю (объяснение и вход), карточки сигналов — только после входа", () => {
    expect(needsLogin("/signals")).toBe(false);
    expect(needsLogin("/signals/sig_abc")).toBe(true);
    expect(needsLogin("/settings")).toBe(true);
    expect(needsLogin("/settings/x")).toBe(true);
    expect(needsLogin("/chart")).toBe(false);
    expect(needsLogin("/signalsx")).toBe(false);
  });
});
