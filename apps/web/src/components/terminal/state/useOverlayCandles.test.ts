import { describe, expect, it } from "vitest";
import type { Candle } from "@platform/charts";
import { applyPage, mergeCandles, overlayNeed, type OverlayState } from "./useOverlayCandles";

const H = 14400;
const c = (i: number, close = 100 + i): Candle => ({ time: i * H, open: close, high: close, low: close, close, volume: 1, open_: false });
const run = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => c(from + k));
const st = (from: number, to: number, hasOlder = true): OverlayState => ({ key: "ETHUSDT:4h", candles: run(from, to), hasOlder });

describe("свечи наложенного инструмента следуют за буфером основного (план 2A.3 v2)", () => {
  it("порции сливаются по времени без повторов; у совпавшего времени — свеча новой порции", () => {
    const merged = mergeCandles(run(5, 9), [c(8, 1), c(9, 2), c(10, 3), c(3, 4)]);
    expect(merged.map((x) => x.time / H)).toEqual([3, 5, 6, 7, 8, 9, 10]);
    expect(merged.find((x) => x.time === 8 * H)!.close).toBe(1);
    expect(mergeCandles([], [])).toEqual([]);
  });

  it("первая порция, хвост на новой закрытой свече, история слева — пока наложение не покроет буфер", () => {
    expect(overlayNeed(null, 0, 10 * H)).toEqual({ kind: "first" });
    // наложение покрывает буфер — догружать нечего
    expect(overlayNeed(st(0, 10), 0, 10 * H)).toBeNull();
    expect(overlayNeed(st(0, 10), 2 * H, 9 * H)).toBeNull();
    // основная свеча закрылась позже последней свечи наложения: раньше линия сравнения отставала на свечу с каждым закрытием
    expect(overlayNeed(st(0, 10), 0, 11 * H)).toEqual({ kind: "tail" });
    // буфер основного инструмента начинается раньше (подгрузили историю): раньше наложение начиналось посреди экрана
    expect(overlayNeed(st(5, 10), 0, 10 * H)).toEqual({ kind: "older", before: 5 * H });
    // хвост важнее истории: сначала свежая свеча
    expect(overlayNeed(st(5, 10), 0, 11 * H)).toEqual({ kind: "tail" });
    // у цели истории старше нет (инструмент моложе основного) — не запрашиваем
    expect(overlayNeed(st(5, 10, false), 0, 10 * H)).toBeNull();
    // буфер основного ещё не загружен; пустое наложение
    expect(overlayNeed(st(5, 10), null, null)).toBeNull();
    expect(overlayNeed({ key: "k", candles: [], hasOlder: true }, 0, 10 * H)).toBeNull();
  });

  it("порция истории расширяет наложение и решает, есть ли свечи старше; хвост этого не меняет", () => {
    const first = applyPage(null, "ETHUSDT:4h", { kind: "first" }, run(5, 10), true);
    expect(first).toMatchObject({ key: "ETHUSDT:4h", hasOlder: true });
    const older = applyPage(first, "ETHUSDT:4h", { kind: "older", before: 5 * H }, run(0, 4), false);
    expect(older.candles.map((x) => x.time / H)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(older.hasOlder).toBe(false);
    // хвост: последняя порция сервера (has_older у неё про свои 500 свечей) не возвращает «историю старше»
    const tail = applyPage(older, "ETHUSDT:4h", { kind: "tail" }, run(8, 11), true);
    expect(tail.candles.at(-1)!.time).toBe(11 * H);
    expect(tail.hasOlder).toBe(false);
    // и не сбрасывает её у наложения, которому ещё есть что догружать
    expect(applyPage(first, "ETHUSDT:4h", { kind: "tail" }, run(8, 11), false).hasOlder).toBe(true);
  });

  it("порция истории без свечей старше при has_older = true — дыра у цели: дальше не запрашиваем", () => {
    const first = applyPage(null, "ETHUSDT:4h", { kind: "first" }, run(5, 10), true);
    const empty = applyPage(first, "ETHUSDT:4h", { kind: "older", before: 5 * H }, [], true);
    expect(empty.hasOlder).toBe(false);
    expect(overlayNeed(empty, 0, 10 * H)).toBeNull();
    const same = applyPage(first, "ETHUSDT:4h", { kind: "older", before: 5 * H }, run(5, 6), true);
    expect(same.hasOlder).toBe(false);
  });

  it("смена инструмента или таймфрейма: порция другого ключа начинает наложение заново", () => {
    const eth = applyPage(null, "ETHUSDT:4h", { kind: "first" }, run(5, 10), true);
    const sol = applyPage(eth, "SOLUSDT:4h", { kind: "first" }, run(8, 9), false);
    expect(sol).toEqual({ key: "SOLUSDT:4h", candles: run(8, 9), hasOlder: false });
  });
});
