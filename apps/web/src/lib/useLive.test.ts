import { afterEach, describe, expect, it, vi } from "vitest";
import { isNewer, mergePrices, PriceBatch, PRICE_STATE_MS, type LivePrice } from "./useLive";

/** Цена в шапке (ADR-0010): тики копятся и попадают в состояние React не чаще раза в секунду. */

afterEach(() => {
  vi.useRealTimers();
});

const at = (s: number) => new Date(Date.UTC(2026, 10, 4, 8, 0, s)).toISOString();

describe("цена в шапке", () => {
  it("тики каждые 250 мс: первый сразу, дальше не чаще раза в секунду и только последняя цена", () => {
    vi.useFakeTimers();
    const flushed: Record<string, LivePrice>[] = [];
    const batch = new PriceBatch((b) => flushed.push(b));
    for (let i = 0; i < 8; i++) {
      batch.push("BTCUSDT", { p: String(100 + i), at: at(i) });
      vi.advanceTimersByTime(250);
    }
    // 2 с тиков: сразу, на 1-й и на 2-й секунде (последняя цена к этому моменту) — 3 обновления, не 8
    expect(flushed.map((b) => b.BTCUSDT!.p)).toEqual(["100", "103", "107"]);
    vi.advanceTimersByTime(5 * PRICE_STATE_MS);
    expect(flushed).toHaveLength(3); // новых тиков нет — и обновлений нет
    batch.dispose();
  });

  it("много символов за секунду — одно обновление состояния", () => {
    vi.useFakeTimers();
    const flushed: Record<string, LivePrice>[] = [];
    const batch = new PriceBatch((b) => flushed.push(b));
    batch.push("BTCUSDT", { p: "1", at: at(0) });
    for (const s of ["ETHUSDT", "SOLUSDT", "XRPUSDT"]) batch.push(s, { p: "2", at: at(0) });
    expect(flushed).toHaveLength(1);
    vi.advanceTimersByTime(PRICE_STATE_MS);
    expect(flushed).toHaveLength(2);
    expect(Object.keys(flushed[1]!).sort()).toEqual(["ETHUSDT", "SOLUSDT", "XRPUSDT"]);
    batch.dispose();
    vi.advanceTimersByTime(PRICE_STATE_MS);
    batch.push("BTCUSDT", { p: "3", at: at(5) });
    expect(flushed).toHaveLength(3); // после секунды тишины — снова сразу
  });

  it("закрытая минута (price) старше тика цену не откатывает; без изменений — то же состояние", () => {
    const prev = { BTCUSDT: { p: "101.5", at: at(30) } };
    expect(isNewer(prev.BTCUSDT, { p: "100", at: at(0) })).toBe(false);
    expect(mergePrices(prev, { BTCUSDT: { p: "100", at: at(0) } })).toBe(prev);
    expect(mergePrices(prev, { BTCUSDT: { p: "101.5", at: at(30) } })).toBe(prev);
    const next = mergePrices(prev, { BTCUSDT: { p: "101.7", at: at(31) }, ETHUSDT: { p: "2500", at: at(31) } });
    expect(next).toEqual({ BTCUSDT: { p: "101.7", at: at(31) }, ETHUSDT: { p: "2500", at: at(31) } });
    expect(isNewer(undefined, { p: "1", at: "" })).toBe(true);
  });
});
