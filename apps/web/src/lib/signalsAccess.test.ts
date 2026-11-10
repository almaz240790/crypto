import { describe, expect, it } from "vitest";
import { canSeeSignals } from "./signalsAccess";

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
