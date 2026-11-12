import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/auth-client";
import { loadError, loadErrorKind, retryable, retryDelayMs } from "./loadError";

/** Сбой первой порции свечей (аудит chart-data-live-1, TSA-2): статус сохраняется, объяснение — по статусу. */
describe("loadError", () => {
  it("статус ответа API сохраняется; сеть — null", () => {
    expect(loadError(new ApiError(403, "таймфреймы 1m–15m доступны на тарифе Pro"))).toEqual({ status: 403, message: "таймфреймы 1m–15m доступны на тарифе Pro" });
    expect(loadError(new TypeError("Failed to fetch"))).toEqual({ status: null, message: "Failed to fetch" });
  });

  it("«1m–15m — Pro» — только 403 на минутном ТФ: 403 на 4ч, 404, 500 и сеть у гостя — не «Pro»", () => {
    expect(loadErrorKind({ status: 403, message: "" }, "5m")).toBe("intraday");
    expect(loadErrorKind({ status: 403, message: "" }, "4h")).toBe("failed");
    expect(loadErrorKind({ status: 404, message: "инструмент не найден" }, "4h")).toBe("not_found");
    expect(loadErrorKind({ status: 404, message: "" }, "1m")).toBe("not_found");
    expect(loadErrorKind({ status: 500, message: "" }, "1m")).toBe("failed");
    expect(loadErrorKind({ status: null, message: "Failed to fetch" }, "1d")).toBe("failed");
  });

  it("сами повторяем сеть, 5xx, 408 и 429; отказ и «не найден» — окончательно; паузы 2, 5, 15, 30, 30… с", () => {
    for (const s of [null, 500, 502, 503, 504, 408, 429]) expect(retryable({ status: s, message: "" })).toBe(true);
    for (const s of [400, 401, 403, 404, 422]) expect(retryable({ status: s, message: "" })).toBe(false);
    expect([0, 1, 2, 3, 4, 10].map(retryDelayMs)).toEqual([2000, 5000, 15000, 30000, 30000, 30000]);
  });
});
