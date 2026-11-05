import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/auth-client";
import { isStaff, topdownAnswer } from "./useTopdown";

describe("«Разбор»: проверка ресурса topdown (план 2A.11.12)", () => {
  it("проверяют только владелец и админы: остальным сервер отвечает 404", () => {
    expect(isStaff("owner")).toBe(true);
    expect(isStaff("admin")).toBe(true);
    expect(isStaff("user")).toBe(false);
    expect(isStaff("support")).toBe(false);
    expect(isStaff(null)).toBe(false);
  });

  it("окончательный ответ — 200 (вкладка есть) или 404/403 (нет); сбой — null, повторить и не кэшировать", () => {
    expect(topdownAnswer({ ok: true })).toBe(true);
    expect(topdownAnswer({ ok: false, error: new ApiError(404, "topdown_disabled") })).toBe(false);
    expect(topdownAnswer({ ok: false, error: new ApiError(403, "нет доступа") })).toBe(false);
    expect(topdownAnswer({ ok: false, error: new ApiError(502, "ошибка 502") })).toBeNull();
    expect(topdownAnswer({ ok: false, error: new ApiError(429, "подождите") })).toBeNull();
    expect(topdownAnswer({ ok: false, error: new TypeError("Failed to fetch") })).toBeNull();
  });
});
