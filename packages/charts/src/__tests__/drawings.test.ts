import { describe, expect, it } from "vitest";
import { channelOffset, distToSegment, extend, fibLevels, hitTest, lineAt, magnetSnap, positionStats, rulerInfo, type Projector } from "../drawings/geometry";
import { addDrawing, alive, canRedo, canUndo, clearDrawings, commitMove, createState, mergeRemote, redo, removeDrawing, resolve, toggleLock, undo, updateDrawing, visibleOn } from "../drawings/store";
import { HANDLE_TOUCH_PX, UNDO_STEPS, pointsNeeded, type Drawing } from "../drawings/types";
import { DrawingsPrimitive, formatDrawingPrice } from "../drawings/primitive";
import type { Candle } from "../types";
import { H, T0, TOKENS, bars, makeEnv } from "./fakes/lwc";
import { alpha } from "../theme";

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

  it("отмена после перетаскивания возвращает рисунок на место до него, а не в последнее промежуточное", () => {
    const origin = [{ time: 0, price: 100 }, { time: 60, price: 110 }];
    let s = addDrawing(createState(), d("a", "trend", origin));
    const steps = s.past.length;
    // перетаскивание: промежуточные положения без записи, конец — с положением до перетаскивания
    s = updateDrawing(s, "a", { points: [{ time: 0, price: 100 }, { time: 60, price: 95 }] }, false);
    s = updateDrawing(s, "a", { points: [{ time: 0, price: 100 }, { time: 60, price: 90 }] }, false);
    s = commitMove(s, "a", [{ time: 0, price: 100 }, { time: 60, price: 90 }], origin);
    expect(s.past.length).toBe(steps + 1);
    expect(s.items[0]!.points[1]!.price).toBe(90);
    s = undo(s);
    expect(alive(s)).toHaveLength(1);
    expect(s.items[0]!.points).toEqual(origin);
    s = redo(s);
    expect(s.items[0]!.points[1]!.price).toBe(90);
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
    expect(pointsNeeded("position-long")).toBe(1);
    expect(pointsNeeded("channel")).toBe(3);
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

describe("автомасштаб цены", () => {
  it("рисунки пользователя не растягивают шкалу цены: у примитива нет autoscaleInfo (масштаб только по ценам)", () => {
    const prim = new DrawingsPrimitive(TOKENS) as DrawingsPrimitive & { autoscaleInfo?: unknown };
    expect(prim.autoscaleInfo).toBeUndefined();
  });
});

/** Холст-подделка: записывает линии (цвет, прозрачность, толщина, пунктир), подписи и плашки. */
function canvas() {
  const strokes: { style: string; alpha: number; width: number; dash: number[]; y0: number; y1: number }[] = [];
  const texts: { text: string; fill: string; font: string; x: number; w: number }[] = [];
  const rects: string[] = [];
  const boxes: { fill: string; x: number; w: number }[] = [];
  let path: { x: number; y: number }[] = [];
  let dash: number[] = [];
  const st = { strokeStyle: "", fillStyle: "", lineWidth: 1, globalAlpha: 1, font: "", textBaseline: "" };
  const stack: (typeof st & { dash: number[] })[] = [];
  const ctx = Object.assign(st, {
    save: () => stack.push({ ...st, dash }),
    restore: () => {
      const s0 = stack.pop()!;
      dash = s0.dash;
      Object.assign(st, s0);
    },
    setLineDash: (d: number[]) => (dash = d),
    beginPath: () => (path = []),
    moveTo: (x: number, y: number) => path.push({ x, y }),
    lineTo: (x: number, y: number) => path.push({ x, y }),
    stroke: () => strokes.push({ style: st.strokeStyle, alpha: st.globalAlpha, width: st.lineWidth, dash: [...dash], y0: path[0]?.y ?? NaN, y1: path[1]?.y ?? NaN }),
    fillText: (text: string, x: number) => texts.push({ text, fill: st.fillStyle, font: st.font, x, w: text.length * 6 }),
    fillRect: (x: number, _y: number, w: number) => {
      rects.push(st.fillStyle);
      boxes.push({ fill: st.fillStyle, x, w });
    },
    strokeRect: () => undefined,
    measureText: (t: string) => ({ width: t.length * 6 }),
    arc: () => undefined,
    fill: () => undefined,
    closePath: () => undefined,
  });
  return { ctx, strokes, texts, rects, boxes };
}

const PANE_W = 800;

function render(drawings: Drawing[]) {
  const candles = bars(60);
  const env = makeEnv(() => candles, { top: 130, bottom: 70 });
  const prim = new DrawingsPrimitive(TOKENS);
  prim.attached({ chart: env.chart, series: env.series, requestUpdate: () => undefined } as never);
  prim.projector!.setBars(candles.map((c) => c.time), H);
  prim.update({ drawings });
  const c = canvas();
  prim.paneViews()[0]!.renderer()!.draw({ useMediaCoordinateSpace: (cb: (s: unknown) => void) => cb({ context: c.ctx, mediaSize: { width: PANE_W, height: 400 } }) } as never);
  return c;
}

describe("Фибоначчи и цвет рисунков по умолчанию", () => {
  const fib = (color: Drawing["style"]["color"]): Drawing => ({ ...d("f", "fib", [{ time: T0 + 10 * H, price: 120 }, { time: T0 + 40 * H, price: 80 }]), style: { color, width: 1, dashed: false }, levels: [0, 0.236, 0.382, 0.5, 0.618, 0.705, 0.786, 1, 1.272, 1.618] });

  it("уровни — нейтральный --text-2, без салатового, охры и заливки; 0.5 и 0.618 выделены толщиной и непрозрачностью", () => {
    const c = render([fib("text2")]);
    const levels = c.strokes.filter((s) => s.y0 === s.y1);
    expect(levels).toHaveLength(10);
    expect(new Set(levels.map((s) => s.style))).toEqual(new Set([TOKENS.text2]));
    for (const s of c.strokes) expect([TOKENS.accent, TOKENS.warn]).not.toContain(s.style);
    const byY = new Map(levels.map((s) => [Math.round(s.y0), s]));
    // та же шкала цены, что у render(): уровень → y
    const { series } = makeEnv(() => bars(60), { top: 130, bottom: 70 });
    const yOf = (level: number) => Math.round(series.priceToCoordinate(80 - (80 - 120) * level));
    const key = [0.5, 0.618].map((l) => byY.get(yOf(l))!);
    const minor = [0.236, 0.382, 0.705, 0.786, 1.272, 1.618].map((l) => byY.get(yOf(l))!);
    const edge = [0, 1].map((l) => byY.get(yOf(l))!);
    for (const s of key) expect(s).toMatchObject({ alpha: 1, width: 1.5, dash: [] });
    for (const s of edge) expect(s).toMatchObject({ alpha: 1, width: 1, dash: [] });
    for (const s of minor) expect(s).toMatchObject({ alpha: 0.6, width: 1, dash: [4, 3] });
    // подписи — тем же нейтральным цветом на плашке цвета фона; ключевые — полужирные
    const labels = c.texts.filter((t) => / · /.test(t.text));
    expect(labels).toHaveLength(10);
    expect(new Set(labels.map((t) => t.fill))).toEqual(new Set([TOKENS.text2]));
    expect(labels.find((t) => t.text.startsWith("0.618 · "))!.font).toMatch(/^600 /);
    expect(labels.find((t) => t.text.startsWith("0.236 · "))!.font).not.toMatch(/^600 /);
    expect(new Set(c.rects)).toEqual(new Set([alpha(TOKENS.surface, 0.85)]));
  });

  it("подписи уровней не уходят под шкалу цены: правый конец у края панели — подпись внутри рисунка, узкий — слева", () => {
    // шкала времени подделки: 0…110 логических на 800 px — свеча 108 у самого правого края
    const at = (i: number) => T0 + i * H;
    const inside = (c: ReturnType<typeof canvas>) => {
      const labels = c.texts.filter((t) => / · /.test(t.text));
      expect(labels).toHaveLength(10);
      for (const t of labels) {
        expect(t.x, t.text).toBeGreaterThanOrEqual(0);
        expect(t.x + t.w, t.text).toBeLessThanOrEqual(PANE_W);
      }
      for (const b of c.boxes) expect(b.x + b.w).toBeLessThanOrEqual(PANE_W);
      return labels;
    };
    const wide = inside(render([{ ...fib("text2"), points: [{ time: at(60), price: 120 }, { time: at(108), price: 80 }] }]));
    // внутри рисунка: конец подписи — левее правого конца
    const series = makeEnv(() => bars(60)).chart.timeScale();
    const right = series.logicalToCoordinate(108);
    for (const t of wide) expect(t.x + t.w).toBeLessThanOrEqual(right);
    // узкий у края: подписи слева от левого конца
    const narrow = inside(render([{ ...fib("text2"), points: [{ time: at(104), price: 120 }, { time: at(108), price: 80 }] }]));
    const left = series.logicalToCoordinate(104);
    for (const t of narrow) expect(t.x + t.w).toBeLessThanOrEqual(left);
    // место справа есть — подписи справа, как раньше
    const free = render([fib("text2")]).texts.filter((t) => / · /.test(t.text));
    for (const t of free) expect(t.x).toBeGreaterThan(series.logicalToCoordinate(40));
  });

  it("прежний цвет по умолчанию (accent) рисуется нейтральным; выбранный цвет — как есть", () => {
    expect(new Set(render([fib("accent")]).strokes.map((s) => s.style))).toEqual(new Set([TOKENS.text2]));
    const line = { ...d("t", "trend", [{ time: T0 + 10 * H, price: 120 }, { time: T0 + 40 * H, price: 80 }]), style: { color: "down" as const, width: 1 as const, dashed: false } };
    expect(render([line]).strokes[0]!.style).toBe(TOKENS.down);
  });
});
