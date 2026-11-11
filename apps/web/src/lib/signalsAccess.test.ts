import { describe, expect, it } from "vitest";
import en from "../i18n/en.json";
import signalsEn from "../i18n/en.signals.json";
import { makeT } from "../i18n";
import { canSeeSignals, signalsRoute, siteSignalsHref } from "./signalsAccess";

describe("canSeeSignals (ADR-0013)", () => {
  it("гостю — только когда сигналы открыты всем", () => {
    expect(canSeeSignals(null)).toBe(false);
    expect(canSeeSignals(undefined)).toBe(false);
    expect(canSeeSignals(null, true)).toBe(true);
  });

  it("вошедшему — как ответил API (поле signals), независимо от роли", () => {
    expect(canSeeSignals({ role: "user", signals: false })).toBe(false);
    expect(canSeeSignals({ role: "user", signals: true })).toBe(true);
    expect(canSeeSignals({ role: "admin", signals: true })).toBe(true);
    expect(canSeeSignals({ role: "owner", signals: false })).toBe(false);
  });

  it("сигналы открыты всем — видны и тем, кому API ответил false (флаг страницы важнее)", () => {
    expect(canSeeSignals({ role: "user", signals: false }, true)).toBe(true);
  });

  it("API без поля signals (старше ADR-0013, сигналы тогда видны всем вошедшим) — как раньше", () => {
    expect(canSeeSignals({ role: "user" })).toBe(true);
    expect(canSeeSignals({ role: "admin" })).toBe(true);
  });
});

describe("signalsRoute — адрес раздела сигналов на сервере (ADR-0013)", () => {
  it("сигналы закрыты: страница — только вошедшему с подсказкой доступа, остальным — как несуществующий адрес", () => {
    expect(signalsRoute(false, true, true)).toBe("show");
    expect(signalsRoute(false, true, false)).toBe("absent");
    expect(signalsRoute(false, false, false)).toBe("absent");
    // подсказка без входа (осталась после выхода) — тоже нет
    expect(signalsRoute(false, false, true)).toBe("absent");
  });

  it("сигналы открыты всем: гостю — вход, вошедшему — страница, подсказка не нужна", () => {
    expect(signalsRoute(true, false, false)).toBe("login");
    expect(signalsRoute(true, true, false)).toBe("show");
  });
});

describe("siteSignalsHref — ссылки из админки на страницы сигналов", () => {
  it("на сайте вошли под admin или owner — прямая ссылка", () => {
    expect(siteSignalsHref("/signals", { role: "owner", signals: true })).toBe("/signals");
    expect(siteSignalsHref("/stats?scope=live", { role: "admin", signals: true })).toBe("/stats?scope=live");
  });

  it("на сайте не вошли (сеанс админки отдельный) — вход сайта с возвратом на страницу, а не 404", () => {
    expect(siteSignalsHref("/signals", null)).toBe("/login?next=%2Fsignals");
    expect(siteSignalsHref("/stats?scope=forward", undefined)).toBe("/login?next=%2Fstats%3Fscope%3Dforward");
  });

  it("на сайте вошли под аккаунтом без доступа — тоже через вход", () => {
    expect(siteSignalsHref("/signals", { role: "user", signals: false })).toBe("/login?next=%2Fsignals");
  });
});

describe("словари переводов (ADR-0013)", () => {
  it("в общем en.json (JS каждой страницы) нет текстов о сигналах — они в en.signals.json", () => {
    const words = /Статистика сигналов|Лента сигналов|Движок сигналов|Трекер сделок|форвард|бэктест|сигнал публикуется/i;
    expect(Object.keys(en).filter((k) => words.test(k))).toEqual([]);
    expect(Object.keys(signalsEn)).toEqual(expect.arrayContaining(["Статистика сигналов", "Движок сигналов", "Трекер сделок"]));
  });

  it("переводы о сигналах подключаются отдельным словарём; без него — русский исходник", () => {
    expect(makeT("en")("Статистика сигналов")).toBe("Статистика сигналов");
    expect(makeT("en", signalsEn)("Статистика сигналов")).toBe("Signal statistics");
    expect(makeT("en", signalsEn)("Отработка свечных паттернов")).toBe(makeT("en")("Отработка свечных паттернов"));
    expect(makeT("ru", signalsEn)("Статистика сигналов")).toBe("Статистика сигналов");
  });
});
