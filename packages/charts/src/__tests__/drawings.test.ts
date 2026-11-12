import { afterEach, describe, expect, it, vi } from "vitest";
import { channelOffset, distToSegment, extend, fibLevels, hitTest, lineAt, magnetSnap, positionStats, rulerInfo, type Projector } from "../drawings/geometry";
import { addDrawing, alive, canRedo, canUndo, clearDrawings, commitMove, createState, mergeRemote, redo, removeDrawing, resolve, toggleLock, undo, updateDrawing, visibleOn } from "../drawings/store";
import { atrAt } from "../drawings/position";
import { HANDLE_TOUCH_PX, UNDO_STEPS, pointsNeeded, type Drawing, type Point } from "../drawings/types";
import { DrawingsPrimitive, formatDrawingPrice } from "../drawings/primitive";
import { fibXs, handleRects } from "../drawings/labels";
import { intersects } from "../layout/labels";
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

describe("отмена и повтор с синхронизацией — новая версия рисунка (аудит FI-1, DTS-2)", () => {
  // сервер и слияние на клиенте: последняя запись побеждает по updated_at, при равенстве — удаление. Отмена уже
  // записанной правки должна выиграть у версии сервера, иначе следующая синхронизация её откатывает.
  const serverKeeps = (server: Drawing, incoming: Drawing) => resolve(server, incoming) === server;
  const at = (ms: number) => vi.setSystemTime(ms);
  afterEach(() => {
    vi.useRealTimers();
  });

  it("отмена правки, перетаскивания и удаления — прежний рисунок с новым updated_at, он побеждает версию сервера", () => {
    vi.useFakeTimers();
    at(1000);
    let s = addDrawing(createState(), { ...d("a", "fib"), levels: [0, 0.5, 1], updated_at: 1000 });
    at(2000);
    s = updateDrawing(s, "a", { levels: [-0.618, 0, 0.5, 1] });
    const edited = s.items[0]!;
    at(3000);
    s = undo(s);
    expect(s.items[0]!.levels).toEqual([0, 0.5, 1]);
    expect(s.items[0]!.updated_at).toBe(3000);
    expect(serverKeeps(edited, s.items[0]!)).toBe(false);
    // повтор — тоже новая версия
    at(4000);
    s = redo(s);
    expect(s.items[0]!.levels).toEqual([-0.618, 0, 0.5, 1]);
    expect(s.items[0]!.updated_at).toBe(4000);

    const origin = s.items[0]!.points;
    at(5000);
    s = commitMove(s, "a", [{ time: 0, price: 90 }, { time: 60, price: 95 }], origin);
    const moved = s.items[0]!;
    at(6000);
    s = undo(s);
    expect(s.items[0]!.points).toEqual(origin);
    expect(s.items[0]!.updated_at).toBe(6000);
    expect(serverKeeps(moved, s.items[0]!)).toBe(false);

    at(7000);
    s = removeDrawing(s, "a");
    const gone = s.items[0]!;
    at(8000);
    s = undo(s);
    expect(alive(s)).toHaveLength(1);
    expect(s.items[0]!.deleted_at ?? null).toBeNull();
    expect(s.items[0]!.updated_at).toBe(8000);
    expect(serverKeeps(gone, s.items[0]!)).toBe(false);
  });

  it("отмена создания — удаление (deleted_at), а не выброшенный рисунок; повтор возвращает его новой версией", () => {
    vi.useFakeTimers();
    at(1000);
    let s = addDrawing(createState(), { ...d("a"), updated_at: 1000 });
    const created = s.items[0]!;
    at(2000);
    s = undo(s);
    expect(alive(s)).toEqual([]);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]!.deleted_at).toBe(2000);
    expect(s.items[0]!.updated_at).toBe(2000);
    // удаление доходит до сервера: живая версия там старше
    expect(serverKeeps(created, s.items[0]!)).toBe(false);
    const tomb = s.items[0]!;
    at(3000);
    s = redo(s);
    expect(alive(s)).toHaveLength(1);
    expect(s.items[0]!.deleted_at ?? null).toBeNull();
    expect(s.items[0]!.updated_at).toBe(3000);
    expect(serverKeeps(tomb, s.items[0]!)).toBe(false);
  });

  it("отмена в ту же миллисекунду, что и правка, всё равно новее; нетронутые рисунки — те же объекты (без лишней синхронизации)", () => {
    vi.useFakeTimers();
    at(1000);
    let s = addDrawing(addDrawing(createState(), { ...d("a"), updated_at: 1000 }), { ...d("b"), updated_at: 1000 });
    const b = s.items[1]!;
    s = updateDrawing(s, "a", { text: "x" });
    const edited = s.items[0]!;
    s = undo(s);
    expect(s.items[0]!.text).toBeUndefined();
    expect(s.items[0]!.updated_at).toBeGreaterThan(edited.updated_at);
    expect(s.items[1]).toBe(b);
  });

  it("рисунок с другого устройства отмена своего шага не удаляет, а чужое удаление не отменяет", () => {
    vi.useFakeTimers();
    at(1000);
    let s = addDrawing(createState(), { ...d("b"), updated_at: 1000 });
    at(2000);
    s = addDrawing(s, { ...d("a"), updated_at: 2000 });
    // слияние с сервером при непустой истории: новый рисунок r и удаление b другим устройством
    const r = { ...d("r"), updated_at: 2500 };
    s = mergeRemote(s, [r, { ...s.items[0]!, updated_at: 2600, deleted_at: 2600 }]);
    at(3000);
    s = undo(s); // отмена создания a
    expect(alive(s).map((x) => x.id)).toEqual(["r"]);
    expect(s.items.find((x) => x.id === "r")).toBe(r);
    expect(s.items.find((x) => x.id === "b")!.updated_at).toBe(2600);
    expect(s.items.find((x) => x.id === "a")!.deleted_at).toBe(3000);
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
    const r = rulerInfo({ time: 0, price: 100 }, { time: 14400 * 10, price: 110 }, (t) => t / 14400, 2);
    expect(r.bars).toBe(10);
    expect(r.atrMultiple).toBe(5);
    expect(r.changePct).toBeCloseTo(10, 9);
    // справа налево: знак — по ходу, свечи, время и ход в ATR — расстояние; ATR нет — хода в ATR нет
    expect(rulerInfo({ time: 14400 * 10, price: 110 }, { time: 0, price: 99 }, (t) => t / 14400, null)).toEqual({ changePct: -10, priceDiff: -11, bars: 10, seconds: 144000, atrMultiple: null });
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
  const strokes: { style: string; alpha: number; width: number; dash: number[]; x0: number; x1: number; y0: number; y1: number }[] = [];
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
    stroke: () => strokes.push({ style: st.strokeStyle, alpha: st.globalAlpha, width: st.lineWidth, dash: [...dash], x0: path[0]?.x ?? NaN, x1: path[1]?.x ?? NaN, y0: path[0]?.y ?? NaN, y1: path[1]?.y ?? NaN }),
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
  // шкала цены 150…70: все уровни Фибоначчи 120 → 80 (и 1.618 = 144.7) — в панели, подписи на экране
  const env = makeEnv(() => candles, { top: 150, bottom: 70 });
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
    const { series } = makeEnv(() => bars(60), { top: 150, bottom: 70 });
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

describe("рисунок «на всех таймфреймах» с точками между свечами текущего таймфрейма", () => {
  // шкала подделки — как у render(): 0…110 логических на 800 px; LWC даёт x только целому индексу (дробный — 0)
  const spacing = PANE_W / 110;
  const xAt = (logical: number) => logical * spacing + spacing / 2;
  const HOUR = 3600;
  /** Фибоначчи, нарисованный на 1ч: 15:00 и 17:00 — между свечами 4ч (12:00 + 3 ч, 16:00 + 1 ч). */
  const fib: Drawing = { ...d("h", "fib", [{ time: T0 + 10 * H + 3 * HOUR, price: 120 }, { time: T0 + 40 * H + HOUR, price: 80 }]), levels: [0, 0.5, 0.618, 1] };

  it("проекция — между свечами по доле интервала, а не у левого края (x = 0); за краями — шагом таймфрейма", () => {
    const candles = bars(60);
    const env = makeEnv(() => candles, { top: 150, bottom: 70 });
    const prim = new DrawingsPrimitive(TOKENS);
    prim.attached({ chart: env.chart, series: env.series, requestUpdate: () => undefined } as never);
    prim.projector!.setBars(candles.map((c) => c.time), H);
    const proj = prim.projector!;
    expect(proj.x(T0 + 10 * H)).toBeCloseTo(xAt(10), 9);
    expect(proj.x(T0 + 10 * H + 3 * HOUR)).toBeCloseTo(xAt(10.75), 9);
    expect(proj.x(T0 + 40 * H + HOUR)).toBeCloseTo(xAt(40.25), 9);
    // правее последней свечи (1Д с утра, 1Н со среды) и левее первой
    expect(proj.x(T0 + 59 * H + 1.5 * H)).toBeCloseTo(xAt(60.5), 9);
    expect(proj.x(T0 - 2.5 * H)).toBeCloseTo(xAt(-2.5), 9);
  });

  it("линии уровней — от A до B, подписи — у правого конца, а не стопкой у левого края панели", () => {
    const c = render([fib]);
    const levels = c.strokes.filter((s) => s.y0 === s.y1);
    expect(levels).toHaveLength(4);
    for (const s of levels) {
      expect(s.x0).toBeCloseTo(xAt(10.75), 6);
      expect(s.x1).toBeCloseTo(xAt(40.25), 6);
    }
    const labels = c.texts.filter((t) => / · /.test(t.text));
    expect(labels).toHaveLength(4);
    for (const t of labels) expect(t.x, t.text).toBeGreaterThan(xAt(40.25));
  });
});

describe("процент трендовой у выбранного рисунка", () => {
  const candles = bars(60);
  /** Своя раскладка примитива (без разметки): подписи и их места, ручки — занятые места. */
  const layout = (drawing: Drawing, o: { selected?: boolean; draft?: boolean; touch?: boolean }) => {
    const env = makeEnv(() => candles, { top: 150, bottom: 70 });
    const prim = new DrawingsPrimitive(TOKENS);
    prim.attached({ chart: env.chart, series: env.series, requestUpdate: () => undefined } as never);
    prim.projector!.setBars(candles.map((c) => c.time), H);
    prim.update({ drawings: o.draft ? [] : [drawing], draft: o.draft ? drawing : null, selectedId: o.selected ? drawing.id : null, touch: o.touch ?? false });
    const proj = prim.projector!.projector();
    const { placed } = prim.paintLabels(canvas().ctx as never, proj);
    const handles = handleRects({ drawings: o.draft ? [] : [drawing], draft: o.draft ? drawing : null, selectedId: o.selected ? drawing.id : null, proj }, o.touch ?? false);
    return { pct: placed.get(`${drawing.id}#pct`) ?? null, handles, b: { x: proj.x(drawing.points[1]!.time)!, y: proj.y(drawing.points[1]!.price)! } };
  };
  const down: Point[] = [{ time: T0 + 10 * H, price: 120 }, { time: T0 + 30 * H, price: 100 }];
  const up: Point[] = [{ time: T0 + 10 * H, price: 100 }, { time: T0 + 30 * H, price: 120 }];

  for (const pts of [down, up])
    for (const touch of [false, true])
      it(`${pts === down ? "вниз" : "вверх"}, ${touch ? "палец" : "мышь"}: выбранная и начатая — с процентом рядом с точкой B, не под ручкой`, () => {
        const dr = d("R", "trend", pts);
        const free = layout(dr, {});
        expect(free.pct, "без выбора").not.toBeNull();
        for (const o of [{ selected: true, touch }, { draft: true, touch }]) {
          const { pct, handles, b } = layout(dr, o);
          expect(pct, JSON.stringify(o)).not.toBeNull();
          for (const h of handles) expect(intersects(pct!, h.rect), `${JSON.stringify(o)}: подпись ${JSON.stringify(pct)} на ручке ${h.id}`).toBe(false);
          // рядом с B: не дальше ручки и зазора по горизонтали, по вертикали — у самой линии
          const dx = Math.min(Math.abs(pct!.x - b.x), Math.abs(pct!.x + pct!.w - b.x));
          expect(dx, JSON.stringify(o)).toBeLessThanOrEqual(16);
          expect(Math.min(Math.abs(pct!.y + pct!.h - b.y), Math.abs(pct!.y - b.y)), JSON.stringify(o)).toBeLessThanOrEqual(3);
        }
      });
});

describe("измеритель (план 2A.5): временный, подпись — Δ цены · % · свечи · время · ход в ATR(14)", () => {
  // свечи 0…19 и 25…59: пять свечей пропуска (биржа стояла) — не свечи; последняя — незакрытая, с огромным ходом
  const closed = [...bars(20), ...bars(35, 25)];
  const live: Candle = { ...closed[closed.length - 1]!, time: T0 + 60 * H, high: 200, low: 10, open_: true };
  const candles = [...closed, live];
  const layout = (o: { drawings?: Drawing[]; draft?: Drawing | null; ruler?: Drawing | null; selectedId?: string | null; touch?: boolean }) => {
    const env = makeEnv(() => candles, { top: 150, bottom: 70 });
    const prim = new DrawingsPrimitive(TOKENS);
    prim.attached({ chart: env.chart, series: env.series, requestUpdate: () => undefined } as never);
    prim.projector!.setBars(candles.map((c) => c.time), H);
    prim.candles = () => candles;
    prim.update({ drawings: o.drawings ?? [], draft: o.draft ?? null, ruler: o.ruler ?? null, selectedId: o.selectedId ?? null, precision: 2, touch: o.touch ?? false });
    const proj = prim.projector!.projector();
    const c = canvas();
    const { labels, placed } = prim.paintLabels(c.ctx as never, proj);
    const handles = handleRects({ drawings: o.drawings ?? [], draft: o.draft ?? null, selectedId: o.selectedId ?? null, proj }, o.touch ?? false);
    return { prim, proj, labels, placed, handles, c };
  };
  // A — свеча 15, B — 30 интервалов 4ч спустя, через пропуск: 25 свечей, 5 дней
  const A: Point = { time: T0 + 15 * H, price: 100 };
  const B: Point = { time: T0 + 45 * H, price: 95.5 };
  const lines = (o: Parameters<typeof layout>[0], id = "R") => layout(o).labels.find((l) => l.id === `${id}#ruler`)?.lines ?? null;

  it("Δ цены и % — от первой точки; свечи — по свечам графика (пропуск — не свеча); время — по часам; ход — в ATR(14) по закрытым свечам на левой точке", () => {
    const k = (4.5 / atrAt(closed, A.time)!).toFixed(1);
    const want = ["−4.50 · −4.50 %", `25 свечей · 5д · ${k} ATR`];
    // временный, начатый и сохранённый раньше (рисунок старых версий) — одна подпись
    expect(lines({ ruler: d("R", "ruler", [A, B]) })).toEqual(want);
    expect(lines({ draft: d("R", "ruler", [A, B]) })).toEqual(want);
    expect(lines({ drawings: [d("R", "ruler", [A, B])] })).toEqual(want);
    // справа налево: знак — по ходу от первой точки, свечи, время и ход в ATR — расстояние
    expect(lines({ ruler: d("R", "ruler", [B, A]) })).toEqual(["+4.50 · +4.71 %", `25 свечей · 5д · ${k} ATR`]);
    // правее последней свечи — шагом таймфрейма; ATR — по закрытым: незакрытая свеча с ходом 190 его не раздувает
    const far: Point[] = [{ time: live.time + 2 * H, price: 100 }, { time: live.time + 6 * H, price: 103 }];
    const kFar = (3 / atrAt(closed, far[0]!.time)!).toFixed(1);
    expect(Number(kFar)).toBeGreaterThan(0.5);
    expect(lines({ ruler: d("R", "ruler", far) })).toEqual(["+3.00 · +3.00 %", `4 свечи · 16ч · ${kFar} ATR`]);
    // одна свеча, часы и минуты; ATR ещё нет (меньше 14 закрытых свечей до левой точки) — без хода в ATR
    expect(lines({ ruler: d("R", "ruler", [{ time: T0 + 2 * H, price: 100 }, { time: T0 + 3 * H, price: 100 }]) })).toEqual(["+0.00 · +0.00 %", "1 свеча · 4ч"]);
  });

  it("подпись — у точки B (за ней по ходу), в панели, не под ручками; у временного ручек нет; рисуется двумя строками", () => {
    for (const pts of [[A, B], [B, A]])
      for (const touch of [false, true])
        for (const o of [{ ruler: d("R", "ruler", pts) }, { draft: d("R", "ruler", pts) }, { drawings: [d("R", "ruler", pts)], selectedId: "R" }]) {
          const r = layout({ ...o, touch });
          const tag = `${JSON.stringify(pts.map((p) => p.price))} ${touch ? "палец" : "мышь"} ${Object.keys(o).join("+")}`;
          const rect = r.placed.get("R#ruler");
          expect(rect, tag).toBeDefined();
          for (const h of r.handles) expect(intersects(rect!, h.rect), `${tag}: подпись на ручке ${h.id}`).toBe(false);
          expect(rect!.x, tag).toBeGreaterThanOrEqual(0);
          expect(rect!.x + rect!.w, tag).toBeLessThanOrEqual(r.proj.width);
          const ya = r.proj.y(pts[0]!.price)!, yb = r.proj.y(pts[1]!.price)!;
          const xa = r.proj.x(pts[0]!.time)!, xb = r.proj.x(pts[1]!.time)!;
          // по вертикали — за точкой B (вниз — под ней, вверх — над ней), рядом; по горизонтали — над измерением
          if (yb > ya) expect(rect!.y - yb, tag).toBeGreaterThan(0);
          else expect(yb - (rect!.y + rect!.h), tag).toBeGreaterThan(0);
          expect(Math.min(Math.abs(rect!.y - yb), Math.abs(rect!.y + rect!.h - yb)), tag).toBeLessThanOrEqual(16);
          expect(rect!.x < Math.max(xa, xb) && rect!.x + rect!.w > Math.min(xa, xb), tag).toBe(true);
          if ("ruler" in o) expect(r.handles, tag).toEqual([]);
        }
    const r = layout({ ruler: d("R", "ruler", [A, B]) });
    r.prim.paneViews()[0]!.renderer()!.draw({ useMediaCoordinateSpace: (cb: (s: unknown) => void) => cb({ context: r.c.ctx, mediaSize: { width: PANE_W, height: 400 } }) } as never);
    const texts = r.c.texts.map((t) => t.text);
    expect(texts).toContain("−4.50 · −4.50 %");
    expect(texts.some((t) => t.startsWith("25 свечей · 5д · "))).toBe(true);
    // линия A–B — нарисована
    expect(r.c.strokes.some((st) => st.x0 === r.proj.x(A.time) && st.x1 === r.proj.x(B.time))).toBe(true);
  });
});

describe("параллельный канал на любой шкале цены", () => {
  /** Линия через две точки (x, y) — y в точке x. */
  const yOn = (s: { x0: number; y0: number; x1: number; y1: number }, x: number) => s.y0 + ((s.y1 - s.y0) * (x - s.x0)) / (s.x1 - s.x0);
  const slope = (s: { x0: number; y0: number; x1: number; y1: number }) => (s.y1 - s.y0) / (s.x1 - s.x0);
  const channel: Drawing = d("C", "channel", [{ time: 100, price: 100 }, { time: 500, price: 400 }, { time: 300, price: 200 }]);
  /** Рисует канал примитивом с заданной проекцией; линии: основная, параллельная, середина. */
  const draw = (proj: Projector) => {
    const prim = new DrawingsPrimitive(TOKENS);
    prim.projector = { projector: () => proj } as never;
    prim.update({ drawings: [channel] });
    const c = canvas();
    prim.paneViews()[0]!.renderer()!.draw({ useMediaCoordinateSpace: (cb: (s: unknown) => void) => cb({ context: c.ctx, mediaSize: { width: proj.width, height: proj.height } }) } as never);
    return c.strokes;
  };
  const scales: [string, (p: number) => number | null][] = [
    ["логарифмическая (300 px на порядок)", (p) => (p > 0 ? (3 - Math.log10(p)) * 300 : null)],
    ["линейная", (p) => 600 - p],
  ];
  for (const [name, y] of scales) {
    it(`${name}: вторая линия параллельна первой на экране и проходит через третью точку; нажатие по ней выбирает канал`, () => {
      const proj: Projector = { x: (t) => t, y, width: 800, height: 600 };
      const [main, par, mid] = draw(proj);
      expect(slope(par!)).toBeCloseTo(slope(main!), 9);
      expect(yOn(par!, 300)).toBeCloseTo(y(200)!, 6);
      // середина — посередине между линиями
      expect(slope(mid!)).toBeCloseTo(slope(main!), 9);
      expect(yOn(mid!, 300)).toBeCloseTo((yOn(main!, 300) + y(200)!) / 2, 6);
      // что нарисовано, то и выбирается: по второй линии — канал, в стороне от неё (дальше допуска) — ничего
      expect(hitTest([channel], 200, yOn(par!, 200), proj, 8)).toEqual({ id: "C", part: "body", index: -1 });
      expect(hitTest([channel], 200, yOn(par!, 200) + 20, proj, 8)).toBeNull();
    });
  }
});

describe("Фибоначчи: уровни за пределами A–B, подписи небольшого рисунка, проекция после смены серии", () => {
  const proj: Projector = { x: (t) => ((t - T0) / H) * 10, y: (p) => (200 - p) * 4, width: 1000, height: 800 };
  const fib: Drawing = { id: "F", type: "fib", points: [{ time: T0 + 20 * H, price: 100 }, { time: T0 + 60 * H, price: 120 }], style: { color: "text2", width: 1, dashed: false }, locked: false, timeframe: null, updated_at: 0 };

  it("линии 1.272 и 1.618 выбираются нажатием, промежуток между ними — нет (там сдвиг графика)", () => {
    const y = (level: number) => proj.y(fibLevels(fib.points[0]!, fib.points[1]!, [level])[0]!.price)!;
    expect(y(1)).toBe(400);
    expect(hitTest([fib], 400, proj.y(110)!, proj, 8)).toEqual({ id: "F", part: "body", index: -1 });
    // раньше — null: линия нарисована и подписана, а нажатие по ней снимало выбор
    expect(hitTest([fib], 400, y(1.272), proj, 8)).toEqual({ id: "F", part: "body", index: -1 });
    expect(hitTest([fib], 400, y(1.618), proj, 8)).toEqual({ id: "F", part: "body", index: -1 });
    expect(hitTest([fib], 400, y(1.618) - 6, proj, 8)).toEqual({ id: "F", part: "body", index: -1 });
    // между 1.272 и 1.618, дальше допуска от обеих линий, и ниже 1.618 — не рисунок
    expect(hitTest([fib], 400, (y(1.272) + y(1.618)) / 2, proj, 8)).toBeNull();
    expect(hitTest([fib], 400, y(1.618) + 20, proj, 8)).toBeNull();
    // левее и правее рисунка линии уровня нет
    expect(hitTest([fib], 150, y(1.618), proj, 8)).toBeNull();
    expect(hitTest([fib], 650, y(1.618), proj, 8)).toBeNull();
    // свои уровни: отрицательный (цель по тренду выше B) тоже выбирается
    const custom = { ...fib, levels: [0, 1, -0.618] };
    expect(hitTest([custom], 400, proj.y(120 + 20 * 0.618)!, proj, 8)).toEqual({ id: "F", part: "body", index: -1 });
  });

  it("подпись уровня не уезжает к краю панели от небольшого рисунка посреди экрана", () => {
    // рисунок 150…358 в панели 1146: справа, внутри и слева место есть — у края панели подпись не предлагается
    expect(fibXs(90, 150, 358, 1146)).toEqual([358, 266, 58]);
    // рисунок у правого края (справа подпись не помещается) или частично за экраном — запасное место у края остаётся
    expect(fibXs(90, 900, 1100, 1146)).toContain(1146 - 90);
    expect(fibXs(90, -50, 200, 1146)).toContain(1146 - 90);
    // совсем нет места рядом (рисунок уже подписи у левого края панели шириной с подпись) — единственное место у края
    expect(fibXs(90, 10, 40, 100)).toEqual([10]);
  });

  it("проекция для контроллера переживает пересоздание серии (смена типа графика)", () => {
    const candles = bars(50);
    const a = makeEnv(() => candles, { top: 110, bottom: 90 });
    const prim = new DrawingsPrimitive(TOKENS);
    prim.attached({ chart: a.chart, series: a.series, requestUpdate: () => undefined } as never);
    prim.projector!.setBars(candles.map((c) => c.time), H);
    const live = prim.live;
    const t = live.timeAt(100);
    expect(t).not.toBeNull();
    expect(live.priceAt(0)).toBe(110);
    // серию убрали: координат нет, под указателем ничего — но объект проекции тот же
    prim.detached();
    expect(live.priceAt(0)).toBeNull();
    expect(live.timeAt(100)).toBeNull();
    expect(live.projector().x(candles[0]!.time)).toBeNull();
    // новая серия (другой тип графика, другой диапазон цен): проекция работает и помнит бары до следующей синхронизации
    const b = makeEnv(() => candles, { top: 220, bottom: 180 });
    prim.attached({ chart: b.chart, series: b.series, requestUpdate: () => undefined } as never);
    expect(prim.live).toBe(live);
    expect(live.priceAt(0)).toBe(220);
    expect(live.timeAt(100)).toBe(t);
    expect(live.projector().y(200)).toBe(prim.projector!.y(200));
  });
});

