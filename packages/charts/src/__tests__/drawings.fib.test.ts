import { describe, expect, it } from "vitest";
import { FIB_LEVEL_GROUPS, changedFibLevels, cleanDrawingLevels, fibLevelGroup, fibLevelText, normalizeFibLevels, sameFibLevels, toggleFibLevel } from "../drawings/fib";
import { fibLevels, hitTest, type Projector } from "../drawings/geometry";
import { DRAWING_TEXT, drawingLabels, formatDrawingPrice, toCandidate } from "../drawings/labels";
import { DrawingsPrimitive } from "../drawings/primitive";
import { addDrawing, createState, redo, undo, updateDrawing } from "../drawings/store";
import { FIB_LEVELS, FIB_LEVELS_MAX, FIB_PRESET_LEVELS, type Drawing } from "../drawings/types";
import { layoutLabels } from "../layout/labels";
import type { Viewport } from "../layout/types";
import { bars, H, makeEnv, T0, TOKENS } from "./fakes/lwc";

/**
 * Уровни Фибоначчи: настраиваемый набор и цели по движению (план 2A.5; ADR-0009, «Рисование», дополнение 2026-11-11).
 * Приведение набора, переключение уровня, подписи и линии уровней за пределами A–B (−1, 2.618), выбор нажатием,
 * рисунок частично за экраном и логарифмическая шкала.
 */

const fib = (levels?: number[], points = [{ time: T0 + 20 * H, price: 100 }, { time: T0 + 60 * H, price: 120 }]): Drawing => ({ id: "F", type: "fib", points, style: { color: "text2", width: 1, dashed: false }, locked: false, timeframe: null, updated_at: 0, ...(levels ? { levels } : {}) });

describe("набор уровней: приведение", () => {
  it("по возрастанию, без повторов, 3 знака; отрицательные остаются", () => {
    expect(normalizeFibLevels([1, 0.5, 0, 0.5, -0.618, 1.618, -0.618])).toEqual([-0.618, 0, 0.5, 1, 1.618]);
    // хвост двоичной дроби: 0.1 + 0.2 — это уровень 0.3
    expect(normalizeFibLevels([0.30000000000000004, 0.1 + 0.2, 0.3])).toEqual([0.3]);
    expect(normalizeFibLevels([0.61803398875, 1.27201965])).toEqual([0.618, 1.272]);
    // «−0» после округления — уровень 0, а не второй ноль
    const zero = normalizeFibLevels([-0.0001, 0]);
    expect(zero).toEqual([0]);
    expect(Object.is(zero[0], 0)).toBe(true);
  });

  it("NaN, Infinity, не числа и уровни за ±10 отбрасываются", () => {
    expect(normalizeFibLevels([0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "0.618", null, undefined, {}, 11, -10.001, 10, -10])).toEqual([-10, 0.5, 10]);
  });

  it("поля нет, пустой список и мусор без единого числа — уровни по умолчанию (новым массивом)", () => {
    for (const raw of [undefined, null, [], "0.5", 0.5, {}, [Number.NaN], ["a", null], [50, -50]]) {
      const out = normalizeFibLevels(raw);
      expect(out, JSON.stringify(raw)).toEqual(FIB_LEVELS);
      expect(out).not.toBe(FIB_LEVELS);
    }
  });

  it("не больше 24 уровней — столько принимает сервер", () => {
    const many = Array.from({ length: 40 }, (_, i) => i / 10);
    const out = normalizeFibLevels(many);
    expect(out).toHaveLength(FIB_LEVELS_MAX);
    expect(out[0]).toBe(0);
    expect(out[FIB_LEVELS_MAX - 1]).toBe(2.3);
  });

  it("приведённый набор приведение не меняет; набор по умолчанию — подмножество выбора в карточке", () => {
    expect(normalizeFibLevels(FIB_LEVELS)).toEqual(FIB_LEVELS);
    expect(normalizeFibLevels(FIB_PRESET_LEVELS)).toEqual([...FIB_PRESET_LEVELS]);
    for (const l of FIB_LEVELS) expect(FIB_PRESET_LEVELS).toContain(l);
    expect(sameFibLevels([1, 0], [0, 1, 1.0004])).toBe(true);
    expect(sameFibLevels(undefined, FIB_LEVELS)).toBe(true);
    expect(sameFibLevels([0, 1], [0, 1, -1])).toBe(false);
  });
});

describe("набор уровней: переключение в карточке", () => {
  it("включить — уровень встаёт на своё место; выключить — убирается; набора нет — от уровней по умолчанию", () => {
    expect(toggleFibLevel(undefined, -0.618)).toEqual([-0.618, ...FIB_LEVELS]);
    expect(toggleFibLevel([-0.618, ...FIB_LEVELS], 0.236)).toEqual([-0.618, 0, 0.382, 0.5, 0.618, 0.705, 0.786, 1, 1.272, 1.618]);
    expect(toggleFibLevel([0, 1], 2.618)).toEqual([0, 1, 2.618]);
    // уровень вне выбора карточки (пришёл с другого клиента) выключается так же
    expect(toggleFibLevel([0, 0.33, 1], 0.33)).toEqual([0, 1]);
  });

  it("последний уровень не выключается; не число и уровень за ±10 набор не меняют", () => {
    expect(toggleFibLevel([0.5], 0.5)).toEqual([0.5]);
    expect(toggleFibLevel([0.5, 1], 0.5)).toEqual([1]);
    expect(toggleFibLevel([0, 1], Number.NaN)).toEqual([0, 1]);
    expect(toggleFibLevel([0, 1], 50)).toEqual([0, 1]);
  });

  it("подпись уровня — с типографским минусом; группы: цели по движению, коррекция, за началом", () => {
    expect([-1, -0.618, 0, 0.5, 1, 2.618].map(fibLevelText)).toEqual(["−1", "−0.618", "0", "0.5", "1", "2.618"]);
    expect(FIB_PRESET_LEVELS.map(fibLevelGroup)).toEqual(["targets", "targets", "targets", "retracement", "retracement", "retracement", "retracement", "retracement", "retracement", "retracement", "retracement", "beyond", "beyond", "beyond"]);
    expect(FIB_LEVEL_GROUPS).toEqual(["targets", "retracement", "beyond"]);
  });
});

describe("сохранённые и пришедшие с сервера рисунки", () => {
  it("у Фибоначчи пустой список и мусор — уровни по умолчанию; поля нет — так и остаётся; чистый рисунок — тот же объект", () => {
    expect(cleanDrawingLevels(fib([])).levels).toEqual(FIB_LEVELS);
    expect(cleanDrawingLevels({ ...fib(), levels: [Number.NaN, "x"] as unknown as number[] }).levels).toEqual(FIB_LEVELS);
    expect(cleanDrawingLevels(fib([1, 0, 0.5000001, 0.5])).levels).toEqual([0, 0.5, 1]);
    const none = fib();
    expect(cleanDrawingLevels(none)).toBe(none);
    expect("levels" in cleanDrawingLevels({ ...fib(), levels: null as unknown as number[] })).toBe(false);
    const clean = fib([-0.618, 0, 1]);
    expect(cleanDrawingLevels(clean)).toBe(clean);
  });

  it("у других типов уровней нет", () => {
    const line = { ...fib([0, 1]), type: "trend" as const };
    expect("levels" in cleanDrawingLevels(line)).toBe(false);
    const plain = { ...fib(), type: "rect" as const };
    expect(cleanDrawingLevels(plain)).toBe(plain);
  });
});

describe("отмена и повтор правки уровней", () => {
  it("каждое переключение — шаг отмены; шаг истории называет набор, к которому вернулся рисунок", () => {
    let s = addDrawing(createState(), fib());
    const created = s;
    s = updateDrawing(s, "F", { levels: toggleFibLevel(undefined, -0.618) });
    const withTarget = s;
    s = updateDrawing(s, "F", { levels: toggleFibLevel(s.items[0]!.levels, 0.236) });
    expect(s.past).toHaveLength(3);
    expect(s.items[0]!.levels).not.toContain(0.236);
    const back = undo(s);
    expect(back.items[0]!.levels).toEqual(withTarget.items[0]!.levels);
    expect(changedFibLevels(s.items, back.items)).toEqual([-0.618, ...FIB_LEVELS]);
    // повтор — снова без 0.236
    expect(changedFibLevels(back.items, redo(back).items)).toEqual(s.items[0]!.levels);
    // отмена первой правки: поля levels у рисунка нет — уровни по умолчанию
    expect(changedFibLevels(back.items, undo(back).items)).toEqual(FIB_LEVELS);
    // шаг, который уровней не менял (отмена создания рисунка, сдвиг), набор не называет
    expect(changedFibLevels(created.items, undo(created).items)).toBeNull();
    const moved = updateDrawing(withTarget, "F", { points: [{ time: T0, price: 1 }, { time: T0 + H, price: 2 }] });
    expect(changedFibLevels(moved.items, undo(moved).items)).toBeNull();
  });
});

/** Панель 1000 × 800: 10 px на свечу от T0, 4 px на единицу цены от 200 вниз. */
const PROJ: Projector = { x: (t) => ((t - T0) / H) * 10, y: (p) => (200 - p) * 4, width: 1000, height: 800 };
const measure = (t: string, _f: "mono" | "sans", px: number) => t.length * px * 0.6;
const labelsOf = (ds: Drawing[], proj: Projector = PROJ, precision: number | null = 2) => drawingLabels({ drawings: ds, draft: null, selectedId: null, proj, tokens: TOKENS, precision, profile: null, text: DRAWING_TEXT, measure });
const VP: Viewport = { width: 1000, height: 800, insetTop: 0, volumeTopY: 800, free: null, gutter: null };
const NO_CANDLES = { x0: 0, spacing: 0, halfWidth: 0, top: new Float32Array(0), bottom: new Float32Array(0) };
const place = (ds: Drawing[], proj: Projector = PROJ, vp: Viewport = VP) => {
  const labels = labelsOf(ds, proj);
  const res = layoutLabels(labels.map(toCandidate), { candles: NO_CANDLES, rects: [] }, vp, { canvas: 0, perLayer: {} });
  return new Map((res.external ?? []).map((p) => [p.id, p.rect]));
};

describe("подписи уровней", () => {
  it("уровни [−0.618, 0, 0.5, 1] от минимума 100 к максимуму 120: тексты, цены и места над своими линиями", () => {
    const d = fib([-0.618, 0, 0.5, 1]);
    const ls = labelsOf([d]);
    // цена = B − (B − A) × уровень: −0.618 — цель выше максимума на 61.8 % хода
    expect(ls.map((l) => l.lines[0])).toEqual(["−0.618 · 132.36", "0 · 120.00", "0.5 · 110.00", "1 · 100.00"]);
    expect(ls.map((l) => l.id)).toEqual(["F#L-0.618", "F#L0", "F#L0.5", "F#L1"]);
    expect(new Set(ls.map((l) => l.id)).size).toBe(4);
    // первое место — справа от рисунка (x правого конца + 2), над линией: низ строки на 3 px выше неё
    const y = (price: number) => (200 - price) * 4;
    expect(ls.map((l) => l.slots[0])).toEqual([132.36, 120, 110, 100].map((p) => ({ x: 602, y: y(p) - 3 - 14 })));
    const placed = place([d]);
    expect([...placed.keys()].sort()).toEqual(["F#L-0.618", "F#L0", "F#L0.5", "F#L1"]);
    for (const [id, r] of placed) expect(r.y + r.h + 3, id).toBeCloseTo(y(Number(ls.find((l) => l.id === id)!.lines[0]!.split(" · ")[1])), 6);
  });

  it("выделение — как раньше: 0.5 и 0.618 полужирные, 0 и 1 — основные, цели и уровни за началом — второстепенные", () => {
    const ls = labelsOf([fib([...FIB_PRESET_LEVELS])]);
    expect(ls).toHaveLength(FIB_PRESET_LEVELS.length);
    const by = (level: number) => ls.find((l) => l.id === `F#L${level}`)!;
    for (const key of [0.5, 0.618]) expect(by(key)).toMatchObject({ weight: 600, mode: "soft", rank: 0 });
    for (const edge of [0, 1]) expect(by(edge)).toMatchObject({ weight: 400, mode: "soft", rank: 0 });
    for (const minor of [-1, -0.618, -0.272, 0.236, 0.786, 1.272, 2.618]) expect(by(minor)).toMatchObject({ weight: 400, mode: "drop", rank: 1, style: "plaque" });
    expect(by(-1).lines[0]).toBe("−1 · 140.00");
    expect(by(2.618).lines[0]).toBe("2.618 · 67.64");
  });

  it("уровень, ушедший за панель (−1 выше верхнего края), не подписывается; остальные — в панели", () => {
    // шкала цены 136…: −1 (цена 140) — выше панели
    const proj: Projector = { ...PROJ, y: (p) => (136 - p) * 10 };
    const placed = place([fib([-1, -0.618, 0, 1])], proj);
    expect([...placed.keys()].sort()).toEqual(["F#L-0.618", "F#L0", "F#L1"]);
    for (const r of placed.values()) {
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.y + r.h).toBeLessThanOrEqual(800);
    }
  });

  it("рисунок частично за экраном (левый конец левее панели, правый — правее): подписи −1 и 2.618 — в панели", () => {
    for (const points of [
      [{ time: T0 - 30 * H, price: 100 }, { time: T0 + 40 * H, price: 120 }],
      [{ time: T0 + 70 * H, price: 100 }, { time: T0 + 130 * H, price: 120 }],
    ]) {
      const placed = place([fib([-1, 0, 1, 2.618], points)]);
      expect([...placed.keys()].sort()).toEqual(["F#L-1", "F#L0", "F#L1", "F#L2.618"]);
      for (const r of placed.values()) {
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(1000);
      }
    }
  });

  it("цена уровня ниже нуля и не число: типографский минус и прочерк, без исключения", () => {
    // ход 40 → 100: уровень 2.618 — на 100 − 60 × 2.618 = −57.08
    const deep = fib([2.618], [{ time: T0 + 20 * H, price: 40 }, { time: T0 + 60 * H, price: 100 }]);
    expect(labelsOf([deep])[0]!.lines[0]).toBe("2.618 · −57.08");
    expect(labelsOf([deep], PROJ, null)[0]!.lines[0]).toBe("2.618 · −57.08");
    expect(formatDrawingPrice(-1234.56, null)).toBe("−1234.6");
    expect(formatDrawingPrice(-0.00046999, null)).toBe("−0.0004700");
    expect(formatDrawingPrice(Number.NaN, 2)).toBe("—");
    expect(formatDrawingPrice(Number.POSITIVE_INFINITY, null)).toBe("—");
    expect(formatDrawingPrice(80432.61, null)).toBe("80432.6");
  });
});

describe("линии и выбор уровней за пределами A–B", () => {
  it("пустой набор рисуется уровнями по умолчанию (рисунок без линий не остаётся)", () => {
    const a = { time: 0, price: 100 }, b = { time: 1, price: 200 };
    expect(fibLevels(a, b, []).map((l) => l.level)).toEqual(FIB_LEVELS);
    expect(fibLevels(a, b, null).map((l) => l.level)).toEqual(FIB_LEVELS);
    expect(fibLevels(a, b).map((l) => l.level)).toEqual(FIB_LEVELS);
    // минимум → максимум: цели по движению — выше максимума, уровни больше 1 — ниже минимума
    expect(fibLevels(a, b, [-1, -0.618, -0.272, 2.618]).map((l) => l.price)).toEqual([300, 261.8, 227.2, -61.80000000000001]);
    // максимум → минимум: зеркально
    expect(fibLevels(b, a, [-1, 2.618]).map((l) => l.price)).toEqual([0, 361.8]);
  });

  it("линии −1 и 2.618 выбираются нажатием по линии в пределах ширины рисунка; промежутки — нет", () => {
    const d = fib([...FIB_PRESET_LEVELS]);
    const y = (level: number) => PROJ.y(fibLevels(d.points[0]!, d.points[1]!, [level])[0]!.price)!;
    // −1 — на 100 % хода выше B (цена 140), 2.618 — ниже A (67.64)
    expect(y(-1)).toBe(240);
    expect(y(2.618)).toBeCloseTo(529.44, 6);
    for (const level of [-1, -0.618, -0.272, 1.272, 1.618, 2.618]) expect(hitTest([d], 400, y(level), PROJ, 8), String(level)).toEqual({ id: "F", part: "body", index: -1 });
    expect(hitTest([d], 400, y(-1) - 5, PROJ, 8)).toEqual({ id: "F", part: "body", index: -1 });
    // между −1 и −0.618, между 1.618 и 2.618 и дальше крайних линий — не рисунок: там сдвиг графика
    expect(hitTest([d], 400, (y(-1) + y(-0.618)) / 2, PROJ, 8)).toBeNull();
    expect(hitTest([d], 400, (y(1.618) + y(2.618)) / 2, PROJ, 8)).toBeNull();
    expect(hitTest([d], 400, y(-1) - 20, PROJ, 8)).toBeNull();
    expect(hitTest([d], 400, y(2.618) + 20, PROJ, 8)).toBeNull();
    // левее и правее рисунка линий нет
    expect(hitTest([d], 150, y(-1), PROJ, 8)).toBeNull();
    expect(hitTest([d], 650, y(2.618), PROJ, 8)).toBeNull();
    // уровень выключили — по его прежнему месту рисунок больше не выбирается
    expect(hitTest([fib([0, 1])], 400, y(-1), PROJ, 8)).toBeNull();
  });

  it("логарифмическая шкала: линия, подпись и выбор — на одной и той же y своего уровня", () => {
    // y — по логарифму цены (как у LWC в режиме log): 2000 px на декаду вниз от цены 1000
    const logY = (p: number) => (p > 0 ? (3 - Math.log10(p)) * 2000 : null);
    const proj: Projector = { ...PROJ, y: logY, height: 4000 };
    const d = fib([-1, 0, 1, 2.618], [{ time: T0 + 20 * H, price: 100 }, { time: T0 + 60 * H, price: 200 }]);
    const prices = fibLevels(d.points[0]!, d.points[1]!, d.levels);
    // 2.618 от хода 100 → 200 — цена −61.8: на логарифмической шкале её нет — ни подписи, ни выбора
    expect(prices.map((l) => l.price)).toEqual([300, 200, 100, -61.80000000000001]);
    const ls = labelsOf([d], proj);
    expect(ls.map((l) => l.id)).toEqual(["F#L-1", "F#L0", "F#L1"]);
    for (const l of ls) {
      const price = prices.find((q) => `F#L${q.level}` === l.id)!.price;
      expect(l.slots[0]!.y + 14 + 3).toBeCloseTo(logY(price)!, 6);
      expect(hitTest([d], 400, logY(price)!, proj, 8), l.id).toEqual({ id: "F", part: "body", index: -1 });
    }
    // на линейной шкале −1 лежал бы на столько же выше B, на сколько A ниже; на логарифмической — ближе
    expect(logY(200)! - logY(300)!).toBeLessThan(logY(100)! - logY(200)!);
  });

  it("отрисовка: −1 и 2.618 — пунктир второстепенного уровня тем же цветом; подпись цели — с минусом", () => {
    const candles = bars(60);
    const env = makeEnv(() => candles, { top: 170, bottom: 30 });
    const prim = new DrawingsPrimitive(TOKENS);
    prim.attached({ chart: env.chart, series: env.series, requestUpdate: () => undefined } as never);
    prim.projector!.setBars(candles.map((c) => c.time), H);
    prim.update({ drawings: [fib([-1, 0, 0.618, 1, 2.618], [{ time: T0 + 10 * H, price: 80 }, { time: T0 + 40 * H, price: 120 }])] });
    const strokes: { style: string; alpha: number; width: number; dash: number[]; y: number }[] = [];
    const texts: string[] = [];
    let path: number[] = [];
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
      moveTo: (_x: number, y: number) => path.push(y),
      lineTo: (_x: number, y: number) => path.push(y),
      stroke: () => strokes.push({ style: st.strokeStyle, alpha: st.globalAlpha, width: st.lineWidth, dash: [...dash], y: path[0] ?? Number.NaN }),
      fillText: (text: string) => texts.push(text),
      fillRect: () => undefined,
      strokeRect: () => undefined,
      measureText: (t: string) => ({ width: t.length * 6 }),
      arc: () => undefined,
      fill: () => undefined,
      closePath: () => undefined,
    });
    prim.paneViews()[0]!.renderer()!.draw({ useMediaCoordinateSpace: (cb: (s: unknown) => void) => cb({ context: ctx, mediaSize: { width: 800, height: 400 } }) } as never);
    const yOf = (price: number) => env.series.priceToCoordinate(price);
    const at = (price: number) => strokes.find((s) => Math.abs(s.y - yOf(price)) < 1e-6)!;
    // −1 → 120 + 40 = 160, 2.618 → 120 − 40 × 2.618 = 15.28 (ниже панели — линия есть, подписи нет)
    expect(strokes).toHaveLength(5);
    expect(at(160)).toMatchObject({ style: TOKENS.text2, alpha: 0.6, width: 1, dash: [4, 3] });
    expect(at(15.28)).toMatchObject({ style: TOKENS.text2, alpha: 0.6, width: 1, dash: [4, 3] });
    expect(at(120)).toMatchObject({ alpha: 1, width: 1, dash: [] });
    expect(at(80)).toMatchObject({ alpha: 1, width: 1, dash: [] });
    expect(at(95.28)).toMatchObject({ alpha: 1, width: 1.5, dash: [] });
    expect(texts.filter((t) => / · /.test(t)).sort()).toEqual(["0 · 120.00", "0.618 · 95.28", "1 · 80.00", "−1 · 160.00"].sort());
  });
});
