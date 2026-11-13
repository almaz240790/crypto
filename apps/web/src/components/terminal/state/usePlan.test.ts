import { describe, expect, it } from "vitest";
import { multichartAccess, multichartOf, PLAN_UNKNOWN } from "./usePlan";

/**
 * Мультичарт по тарифу (план, раздел 4: Premium — «Все + мультичарт (v2)»; ADR-0009, дополнение 2026-11-13):
 * право — из /v1/billing/me (поле multichart), гостю — по billing_enabled из /v1/billing/plans. Пока оплата
 * выключена, ничего не меняется: мультичарт открыт всем. Страница — в e2e/multichart.spec.ts.
 */
describe("multichartOf: право из /v1/billing/me", () => {
  it("поле сервера решает", () => {
    expect(multichartOf({ plan: "pro", billing_enabled: true, multichart: false })).toBe(false);
    expect(multichartOf({ plan: "premium", billing_enabled: true, multichart: true })).toBe(true);
    expect(multichartOf({ plan: "pro", billing_enabled: false, multichart: true })).toBe(true);
  });
  it("API до поля multichart: Premium или оплата выключена", () => {
    expect(multichartOf({ plan: "free", billing_enabled: true })).toBe(false);
    expect(multichartOf({ plan: "pro", billing_enabled: true })).toBe(false);
    expect(multichartOf({ plan: "premium", billing_enabled: true })).toBe(true);
    expect(multichartOf({ plan: "pro", billing_enabled: false })).toBe(true);
  });
});

describe("multichartAccess: что показать на /multichart", () => {
  it("вошедший: по праву тарифа; пока тариф неизвестен — null (ни сетки, ни замка)", () => {
    expect(multichartAccess({ loading: false, authed: true, multichart: null, guestBilling: null })).toBeNull();
    expect(multichartAccess({ loading: false, authed: true, multichart: true, guestBilling: null })).toBe("ok");
    expect(multichartAccess({ loading: false, authed: true, multichart: false, guestBilling: null })).toBe("plan");
  });
  it("гость: оплата включена — замок, выключена — сетка; пока вход проверяется или ответа нет — null", () => {
    expect(multichartAccess({ loading: true, authed: false, multichart: null, guestBilling: true })).toBeNull();
    expect(multichartAccess({ loading: false, authed: false, multichart: null, guestBilling: null })).toBeNull();
    expect(multichartAccess({ loading: false, authed: false, multichart: null, guestBilling: true })).toBe("guest");
    expect(multichartAccess({ loading: false, authed: false, multichart: null, guestBilling: false })).toBe("ok");
  });
  it("биллинг не ответил (и повтор тоже): замка нет, как у минутных ТФ", () => {
    expect(multichartAccess({ loading: false, authed: false, multichart: null, guestBilling: PLAN_UNKNOWN })).toBe("ok");
  });
});
