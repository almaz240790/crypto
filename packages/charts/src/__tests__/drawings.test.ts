import { describe, expect, it } from "vitest";
import { channelOffset, distToSegment, extend, fibLevels, hitTest, lineAt, magnetSnap, positionStats, rulerInfo, type Projector } from "../drawings/geometry";
import { addDrawing, alive, canRedo, canUndo, clearDrawings, createState, mergeRemote, redo, removeDrawing, resolve, toggleLock, undo, updateDrawing, visibleOn } from "../drawings/store";
import { HANDLE_TOUCH_PX, UNDO_STEPS, pointsNeeded, type Drawing } from "../drawings/types";
import { formatDrawingPrice } from "../drawings/primitive";
import type { Candle } from "../types";

const d = (id: string, type: Drawing["type"] = "trend", points = [{ time: 0, price: 100 }, { time: 60, price: 110 }]): Drawing => ({ id, type, points, style: { color: "accent", width: 1, dashed: false }, locked: false, timeframe: null, updated_at: 0 });

describe("хранилище рисунков", () => {
  it("добавление, правка, удаление, undo/redo, лимит 50 шагов", () => {
    let s = createState();
    s = addDrawing(s, d("a"));
    s = addDrawing(s, d("b"));
    expect(s.items.map((x) => x.id)).toEqual(["a", "b"]);
    expect(s.selectedId).toBe("b");
    s = updateDrawing(s, "a", { text: "x" });
    expect(s.items[0]!.text).toBe("x");
    s = undo(s);
    expect(s.items[0]!.text).toBeUndefined();
    s = redo(s);
    expect(s.items[0]!.text).toBe("x");
    s = removeDrawing(s, "b");
    expect(alive(s)).toHaveLength(1);
    expect(s.items.find((x) => x.id === "b")!.deleted_at).toBeTruthy();
    expect(canUndo(s)).toBe(true);
    s = undo(s);
    expect(alive(s)).toHaveLength(2);
    expect(canRedo(s)).toBe(true);
    for (let i = 0; i < 70; i++) s = addDrawing(s, d(`n${i}`));
    expect(s.past.length).toBe(UNDO_STEPS);
    s = toggleLock(s, "a");
    expect(s.items.find((x) => x.id === "a")!.locked).toBe(true);
    s = clearDrawings(s);
    expect(alive(s)).toEqual([]);
    expect(alive(undo(s)).length).toBeGreaterThan(0);
  });

  it("правка без записи в историю (перетаскивание) не плодит шаги", () => {
    let s = addDrawing(createState(), d("a"));
    const before = s.past.length;
    s = updateDrawing(s, "a", { points: [{ time: 0, price: 1 }, { time: 60, price: 2 }] }, false);
    expect(s.past.length).toBe(before);
  });

  it("видимость по таймфрейму и «скрыть все»", () => {
    let s = addDrawing(createState(), { ...d("a"), timeframe: "4h" });
    s = addDrawing(s, { ...d("b"), timeframe: null });
    expect(visibleOn(s, "4h").map((x) => x.id)).toEqual(["a", "b"]);
    expect(visibleOn(s, "1d").map((x) => x.id)).toEqual(["b"]);
    expect(visibleOn({ ...s, hidden: true }, "4h")).toEqual([]);
  });
});

describe("геометрия", () => {
  it("число точек по типу и зона касания на телефоне", () => {
    expect(pointsNeeded("hline")).toBe(1);
    expect(pointsNeeded("trend")).toBe(2);
    expect(pointsNeeded("position-long")).toBe(3);
    expect(HANDLE_TOUCH_PX).toBe(28);
  });

  it("магнит к OHLC в пределах допуска", () => {
    const c: Candle = { time: 0, open: 100, high: 110, low: 95, close: 104, volume: 1, open_: false };
    expect(magnetSnap(c, 103.5, 1)).toBe(104);
    expect(magnetSnap(c, 107, 1)).toBe(107);
    expect(magnetSnap(c, 109.2, 1)).toBe(110);
    expect(magnetSnap(undefined, 50, 1)).toBe(50);
  });

  it("линия, канал, Фибоначчи, позиция, измеритель", () => {
    expect(lineAt({ time: 0, price: 100 }, { time: 100, price: 200 }, 150)).toBe(250);
    expect(channelOffset({ time: 0, price: 100 }, { time: 100, price: 200 }, { time: 50, price: 170 })).toBe(20);
    const fib = fibLevels({ time: 0, price: 100 }, { time: 1, price: 200 });
    expect(fib.find((f) => f.level === 0.5)!.price).toBe(150);
    expect(fib.find((f) => f.level === 1)!.price).toBe(100);
    const ps = positionStats("long", 100, 95, 115, { deposit: 10000, riskPct: 1 });
    expect(ps.rr).toBe(3);
    expect(ps.riskUsd).toBe(100);
    expect(ps.size).toBe(20);
    expect(ps.riskPct).toBeCloseTo(5, 9);
    const sh = positionStats("short", 100, 105, 90, null);
    expect(sh.rr).toBe(2);
    expect(sh.size).toBeNull();
    const r = rulerInfo({ time: 0, price: 100 }, { time: 14400 * 10, price: 110 }, 14400, 2);
    expect(r.bars).toBe(10);
    expect(r.atrMultiple).toBe(5);
    expect(r.changePct).toBeCloseTo(10, 9);
  });

  it("попадание: сначала хэндлы, потом тело; продление луча", () => {
    const proj: Projector = { x: (t) => t, y: (p) => 1000 - p, width: 1000, height: 1000 };
    const items = [d("line", "trend", [{ time: 100, price: 100 }, { time: 300, price: 300 }]), d("h", "hline", [{ time: 0, price: 500 }])];
    expect(hitTest(items, 102, 902, proj, 8)).toEqual({ id: "line", part: "point", index: 0 });
    expect(hitTest(items, 200, 800, proj, 8)).toEqual({ id: "line", part: "body", index: -1 });
    expect(hitTest(items, 700, 500, proj, 8)).toEqual({ id: "h", part: "body", index: -1 });
    expect(hitTest(items, 700, 100, proj, 8)).toBeNull();
    expect(distToSegment(0, 10, 0, 0, 10, 0)).toBe(10);
    const e = extend(0, 0, 10, 10, 100, false);
    expect(e.x2).toBe(110);
    expect(e.y2).toBe(110);
  });
});

describe("слияние с сервером (два устройства)", () => {
  it("последняя запись побеждает, при равенстве — удаление; порядок слияния не важен", () => {
    const local = addDrawing(createState(), { ...d("a"), updated_at: 100, text: "local" });
    const remoteNewer = { ...d("a"), updated_at: 200, text: "remote" };
    expect(mergeRemote(local, [remoteNewer]).items[0]!.text).toBe("remote");
    const remoteOlder = { ...d("a"), updated_at: 50, text: "old" };
    expect(mergeRemote(local, [remoteOlder]).items[0]!.text).toBe("local");
    const gone = { ...d("a"), updated_at: 100, deleted_at: 100 };
    expect(resolve(local.items[0], gone).deleted_at).toBe(100);
    const other = { ...d("b"), updated_at: 10 };
    const merged = mergeRemote(local, [other, remoteNewer]);
    expect(merged.items.map((x) => x.id)).toEqual(["b", "a"]);
    expect(visibleOn(mergeRemote(local, [gone]), "4h")).toEqual([]);
  });
});

describe("цены в подписях рисунков", () => {
  it("с точностью инструмента и разрядами, как на шкале и в шапке", () => {
    // шаг 1e-7: семь знаков, а не четыре значащие цифры («0.004700» вместо 0.0046999)
    expect(formatDrawingPrice(0.0046999, 7)).toBe("0.0046999");
    expect(formatDrawingPrice(2344.158, 2)).toBe("2 344.16");
    expect(formatDrawingPrice(80432.61, 1)).toBe("80 432.6");
  });
  it("шаг цены ещё неизвестен — прежняя запись", () => {
    expect(formatDrawingPrice(80432.61, null)).toBe("80432.6");
    expect(formatDrawingPrice(0.0046999, null)).toBe("0.004700");
  });
});
