import { describe, expect, it } from "vitest";
import { createBuffer, EDGE, MAX_CANDLES, needsNewer, needsOlder, prependOlder, pushLatest, replaceNewest } from "../buffer";
import type { Candle } from "../types";

const mk = (from: number, n: number): Candle[] => Array.from({ length: n }, (_, i) => ({ time: from + i * 60, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1, open_: false }));

describe("буфер свечей", () => {
  it("сортирует и убирает дубли", () => {
    const b = createBuffer([...mk(600, 3), ...mk(0, 5)]);
    expect(b.candles.map((c) => c.time)).toEqual([0, 60, 120, 180, 240, 600, 660, 720]);
  });

  it("подгрузка слева не превышает лимит и никогда не выгружает свежие свечи справа", () => {
    let b = createBuffer(mk(100_000, MAX_CANDLES - 100));
    const newest = b.candles.at(-1)!.time;
    b = prependOlder(b, mk(0, 500), true);
    expect(b.candles.length).toBe(MAX_CANDLES);
    // из порции взята самая новая часть, правый край на месте
    expect(b.candles[0]!.time).toBe(400 * 60);
    expect(b.candles.at(-1)!.time).toBe(newest);
    expect(b.trimmedRight).toBe(0);
    expect(b.hasOlder).toBe(true);
    // буфер полон — дальше влево не грузим, живые обновления продолжают приходить
    expect(needsOlder(b, 0)).toBe(false);
    expect(needsNewer(b, MAX_CANDLES - 10)).toBe(false);
    const after = pushLatest(b, { ...mk(9_999_999, 1)[0]! });
    expect(after.candles.at(-1)!.time).toBe(9_999_999);
  });

  it("порция без пересечений: свечи не старше первой отбрасываются", () => {
    let b = createBuffer(mk(600, 5));
    b = prependOlder(b, mk(0, 12), false);
    expect(b.candles.map((c) => c.time)).toEqual([0, 60, 120, 180, 240, 300, 360, 420, 480, 540, 600, 660, 720, 780, 840]);
    expect(b.hasOlder).toBe(false);
  });

  it("возврат вправо подменяет свежую часть", () => {
    let b = createBuffer(mk(0, 10));
    b = { ...b, trimmedRight: 3 };
    b = replaceNewest(b, mk(600, 5));
    expect(b.trimmedRight).toBe(0);
    expect(b.candles.length).toBe(15);
  });

  it("живое обновление: текущая свеча заменяется, новая добавляется, старая слева выгружается", () => {
    let b = createBuffer(mk(0, MAX_CANDLES), false);
    const last = b.candles[b.candles.length - 1]!;
    b = pushLatest(b, { ...last, close: 9 });
    expect(b.candles.length).toBe(MAX_CANDLES);
    expect(b.candles[b.candles.length - 1]!.close).toBe(9);
    b = pushLatest(b, { ...last, time: last.time + 60 });
    expect(b.candles.length).toBe(MAX_CANDLES);
    expect(b.candles[0]!.time).toBe(60);
    expect(b.hasOlder).toBe(true);
    // свеча из прошлого не переписывает историю
    const same = pushLatest(b, { ...last, time: 120, close: 42 });
    expect(same).toBe(b);
  });

  it("порция слева запрашивается у края и только если история есть", () => {
    const b = createBuffer(mk(0, 1000), true);
    expect(needsOlder(b, EDGE - 1)).toBe(true);
    expect(needsOlder(b, EDGE + 1)).toBe(false);
    expect(needsOlder({ ...b, hasOlder: false }, 0)).toBe(false);
  });
});
