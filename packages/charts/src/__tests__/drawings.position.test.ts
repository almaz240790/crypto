import { describe, expect, it } from "vitest";
import { hitTest, positionHit, positionKnobs, positionScreen, type Projector } from "../drawings/geometry";
import { DRAWING_LABEL_PRIORITY, DRAWING_TEXT, drawingLabels, handleCandidate, handleRects, positionLabelTexts, toCandidate, type DrawingLabel } from "../drawings/labels";
import { atrAt, flipPosition, formatRR, positionError, positionFieldError, positionFromEntry, positionParts, roundToTick, setPositionEnd, setPositionPrice, withRiskPct, withRiskReward } from "../drawings/position";
import { DrawingsPrimitive } from "../drawings/primitive";
import { DEFAULT_STYLE, POSITION_FILL_ALPHA, type Drawing } from "../drawings/types";
import { AtrCalc } from "../indicators/core";
import { layoutLabels } from "../layout/labels";
import { monoMeasurer } from "../layout/measure";
import type { LabelCandidate, Obstacles, Rect, Viewport } from "../layout/types";
import { VIEW } from "../presets";
import { OverlayPrimitive } from "../render/OverlayPrimitive";
import type { HLineObject, Scene } from "../scene/types";
import { alpha } from "../theme";
import { bars, H, makeEnv, makeTheme, T0, TOKENS } from "./fakes/lwc";

/**
 * Позиция Long/Short (ADR-0009, «Рисование», дополнение «Позиция»): геометрия (ATR-стоп, цель 1:2, проверки, ручки,
 * переворот), подписи на плашках и их место в общей раскладке с подписями разметки, отрисовка зон.
 */

const pos = (type: Drawing["type"], entry: number, stop: number, target: number, from = 20, to = 50): Drawing => ({
  id: "P",
  type,
  points: [
    { time: T0 + from * H, price: entry },
    { time: T0 + to * H, price: stop },
    { time: T0 + to * H, price: target },
  ],
  style: { ...DEFAULT_STYLE, color: type === "position-long" ? "up" : "down" },
  locked: false,
  timeframe: null,
  updated_at: 0,
});

describe("геометрия позиции", () => {
  it("ATR(14) на свече входа; правее последней — последний; свечей меньше периода — нет", () => {
    const c = bars(60);
    const calc = new AtrCalc(14);
    const want = c.map((x) => calc.push(x));
    expect(atrAt(c, c[30]!.time)).toBe(want[30]);
    expect(atrAt(c, c[30]!.time + H / 2)).toBe(want[30]);
    expect(atrAt(c, c[59]!.time + 10 * H)).toBe(want[59]);
    expect(atrAt(c, c[5]!.time)).toBeNull();
    expect(atrAt([], T0)).toBeNull();
  });

  it("одно нажатие: стоп на ATR от входа (Long ниже, Short выше), цель — два риска; без ATR — 1 % цены", () => {
    const e = { time: T0, price: 100 };
    expect(positionFromEntry("long", e, { atr: 2, end: T0 + 30 * H }).map((p) => p.price)).toEqual([100, 98, 104]);
    expect(positionFromEntry("short", e, { atr: 2, end: T0 + 30 * H }).map((p) => p.price)).toEqual([100, 102, 96]);
    expect(positionFromEntry("long", e, { atr: null, end: T0 + H }).map((p) => p.price)).toEqual([100, 99, 102]);
    // ATR больше цены — у Long стоп ниже нуля бессмысленен: 1 % цены
    expect(positionFromEntry("long", e, { atr: 150, end: T0 + H }).map((p) => p.price)).toEqual([100, 99, 102]);
    const pts = positionFromEntry("long", e, { atr: 2, end: T0 + 30 * H });
    expect(pts.map((p) => p.time)).toEqual([T0, T0 + 30 * H, T0 + 30 * H]);
  });

  it("цены по шагу инструмента; стоп не сливается со входом после округления", () => {
    expect(roundToTick(0.1 + 0.2, 0.1)).toBe(0.3);
    expect(roundToTick(81234.567, 0.1)).toBe(81234.6);
    expect(roundToTick(0.000012345, 0.00000001)).toBe(0.00001235);
    expect(roundToTick(5, null)).toBe(5);
    // вход — тоже по шагу (нажатие без магнита даёт цену с хвостом)
    const p = positionFromEntry("long", { time: T0, price: 81234.537 }, { atr: 512.345, end: T0, tick: 0.1 });
    expect(p.map((q) => q.price)).toEqual([81234.5, 80722.2, 82259.1]);
    // ATR меньше шага: стоп — на шаг от входа, а не на входе
    const tiny = positionFromEntry("short", { time: T0, price: 100 }, { atr: 0.01, end: T0, tick: 0.5 });
    expect(tiny.map((q) => q.price)).toEqual([100, 100.5, 99]);
  });

  it("проверки: стоп и цель по свои стороны от входа, цены больше нуля", () => {
    expect(positionError("long", 100, 95, 110)).toBeNull();
    expect(positionError("long", 100, 101, 110)).toBe("stop-below");
    expect(positionError("long", 100, 95, 99)).toBe("target-above");
    expect(positionError("short", 100, 105, 90)).toBeNull();
    expect(positionError("short", 100, 99, 90)).toBe("stop-above");
    expect(positionError("short", 100, 105, 101)).toBe("target-below");
    expect(positionError("short", 100, 105, -1)).toBe("positive");
    const p = positionParts(pos("position-long", 100, 95, 110))!;
    expect(positionFieldError(p, "entry", 96)).toBeNull();
    expect(positionFieldError(p, "entry", 120)).toBe("entry-between");
    expect(positionFieldError(p, "stop", 100)).toBe("stop-below");
    expect(positionFieldError(p, "target", 0)).toBe("positive");
    expect(positionFieldError(p, "target", Number.NaN)).toBe("positive");
  });

  it("перетаскивание цены прижимается к своей стороне; правый край — не левее входа + шаг", () => {
    const d = pos("position-long", 100, 95, 110);
    expect(setPositionPrice(d, "stop", 120, 0.5)[1]!.price).toBe(99.5);
    expect(setPositionPrice(d, "target", 50, 0.5)[2]!.price).toBe(100.5);
    expect(setPositionPrice(d, "entry", 130, 0.5)[0]!.price).toBe(109.5);
    expect(setPositionPrice(d, "entry", 10, 0.5)[0]!.price).toBe(95.5);
    expect(setPositionPrice(d, "stop", 90, 0.5)[1]!.price).toBe(90);
    expect(setPositionPrice(d, "stop", -3, null)[1]!.price).toBe(95);
    const s = pos("position-short", 100, 105, 90);
    expect(setPositionPrice(s, "stop", 80, 1)[1]!.price).toBe(101);
    expect(setPositionPrice(s, "target", 120, 1)[2]!.price).toBe(99);
    expect(setPositionEnd(d, T0, H).map((p) => p.time)).toEqual([T0 + 20 * H, T0 + 21 * H, T0 + 21 * H]);
    expect(setPositionEnd(d, T0 + 80 * H, H).map((p) => p.time)).toEqual([T0 + 20 * H, T0 + 80 * H, T0 + 80 * H]);
    // не позиция — без изменений
    const line = { ...d, type: "trend" as const };
    expect(setPositionPrice(line, "stop", 1)).toBe(line.points);
    expect(setPositionEnd(line, T0, H)).toBe(line.points);
  });

  it("R:R двигает цель; риск, % — стоп (R:R тот же); переворот — зеркально, цвет по направлению", () => {
    const d = pos("position-long", 100, 95, 110);
    expect(withRiskReward(d, 3, 0.1).map((p) => p.price)).toEqual([100, 95, 115]);
    expect(withRiskPct(d, 2, 0.1).map((p) => p.price)).toEqual([100, 98, 104]);
    expect(withRiskReward(d, 0)).toBe(d.points);
    expect(withRiskPct(d, 120)).toBe(d.points);
    const f = flipPosition(d)!;
    expect(f.type).toBe("position-short");
    expect(f.style.color).toBe("down");
    expect(f.points.map((p) => p.price)).toEqual([100, 105, 90]);
    const back = flipPosition({ ...d, ...f })!;
    expect(back.type).toBe("position-long");
    expect(back.points.map((p) => p.price)).toEqual([100, 95, 110]);
    // зеркальная цель ниже нуля — половина пути до нуля
    expect(flipPosition(pos("position-long", 100, 95, 250))!.points[2]!.price).toBe(50);
    expect(flipPosition({ ...d, type: "trend" })).toBeNull();
    // по шагу цены, без хвостов float (2 × 80775.1 − 81502.2 = 80048.00000000001)
    const sh = pos("position-short", 80775.1, 81502.2, 79320.9);
    expect(flipPosition(sh, 0.1)!.points.map((p) => p.price)).toEqual([80775.1, 80048, 82229.3]);
    expect(flipPosition(sh)!.points.map((p) => p.price)).toEqual([80775.1, 80048, 82229.3]);
    expect(flipPosition(pos("position-long", 0.0049, 0.0048852, 0.0049296), 0.0000001)!.points.map((p) => p.price)).toEqual([0.0049, 0.0049148, 0.0048704]);
    expect(formatRR(2)).toBe("2");
    expect(formatRR(1.5)).toBe("1.5");
    expect(formatRR(2.3456)).toBe("2.35");
    expect(formatRR(Infinity)).toBe("—");
  });
});

/** Проектор: 10 px на свечу от T0, 4 px на единицу цены от 200 вниз; область 1000 × 800. */
const PROJ: Projector = { x: (t) => ((t - T0) / H) * 10, y: (p) => (200 - p) * 4, width: 1000, height: 800 };

describe("ручки позиции", () => {
  it("вход, стоп и цель — у левого края своих линий, правый край — справа на линии входа; ширина не меньше 40 px", () => {
    const s = positionScreen(pos("position-long", 100, 96, 108), PROJ)!;
    expect(s).toEqual({ xL: 200, xR: 500, xC: 350, yE: 400, yS: 416, yT: 368 });
    expect(positionKnobs(s)).toEqual({ entry: { x: 200, y: 400 }, stop: { x: 200, y: 416 }, target: { x: 200, y: 368 }, end: { x: 500, y: 400 } });
    const narrow = positionScreen(pos("position-long", 100, 96, 108, 20, 20), PROJ)!;
    expect(narrow.xR - narrow.xL).toBe(40);
    // у правого края панели запас до 40 px не уводит край за width − 8 (там нажатие — жест шкалы цены)
    const edge = positionScreen(pos("position-long", 100, 96, 108, 97, 98), PROJ)!;
    expect([edge.xL, edge.xR]).toEqual([970, 992]);
    const edge2 = positionScreen(pos("position-long", 100, 96, 108, 99, 99), PROJ)!;
    expect([edge2.xL, edge2.xR]).toEqual([990, 992]);
    // позиция, которая сама тянется за край (график прокрутили), — как есть
    expect(positionScreen(pos("position-long", 100, 96, 108, 90, 120), PROJ)!.xR).toBe(1200);
    expect(positionScreen({ type: "trend", points: [] }, PROJ)).toBeNull();
  });

  it("попадание: ручка (под пальцем — 22 px), линия по всей длине, правый край, тело, мимо", () => {
    const s = positionScreen(pos("position-long", 100, 96, 108), PROJ)!;
    expect(positionHit(s, 200 + 15, 416 + 12, 14, 22)).toBe("stop");
    // мышью (8 px) так далеко от ручки — мимо
    expect(positionHit(s, 200 + 15, 416 + 12, 8, 8)).toBeNull();
    // ручки входа и стопа рядом (зона риска 16 px): ближайшая
    expect(positionHit(s, 200, 404, 14, 22)).toBe("entry");
    expect(positionHit(s, 200, 413, 14, 22)).toBe("stop");
    expect(positionHit(s, 260, 369, 8, 8)).toBe("target");
    expect(positionHit(s, 260, 401, 8, 8)).toBe("entry");
    expect(positionHit(s, 502, 380, 8, 8)).toBe("end");
    expect(positionHit(s, 300, 384, 8, 8)).toBe("body");
    expect(positionHit(s, 300, 300, 8, 8)).toBeNull();
    // тонкая зона риска (16 px): полоса линии — не шире трети зоны, середина — тело
    expect(positionHit(s, 260, 408, 8, 8)).toBe("body");
    const d = pos("position-long", 100, 96, 108);
    expect(hitTest([d], 200, 416, PROJ, 8)).toEqual({ id: "P", part: "point", index: 1 });
    expect(hitTest([d], 350, 416, PROJ, 8)).toEqual({ id: "P", part: "point", index: 1 });
    expect(hitTest([d], 500, 400, PROJ, 8)).toEqual({ id: "P", part: "point", index: 3 });
    expect(hitTest([d], 300, 384, PROJ, 8)).toEqual({ id: "P", part: "body", index: -1 });
    expect(hitTest([d], 300, 200, PROJ, 8)).toBeNull();
  });
});

const measure = (t: string, _f: "mono" | "sans", px: number) => t.length * px * 0.6;
const labelsOf = (ds: Drawing[], o: { proj?: Projector; profile?: { deposit: number; riskPct: number } | null; selectedId?: string | null; draft?: Drawing | null } = {}) =>
  drawingLabels({ drawings: ds, draft: o.draft ?? null, selectedId: o.selectedId ?? null, proj: o.proj ?? PROJ, tokens: TOKENS, precision: 2, profile: o.profile ?? null, text: DRAWING_TEXT, measure });

describe("подписи позиции", () => {
  it("тексты: цель «+%» и R, стоп «−%», вход с R:R 1:x; с депозитом и риском — риск в $ и объём", () => {
    const p = positionParts(pos("position-long", 100, 95, 110))!;
    expect(positionLabelTexts(p, 2, null, DRAWING_TEXT)).toEqual({ target: "Цель 110.00 · +10.00% · 2R", stop: "Стоп 95.00 · −5.00%", entry: ["Вход 100.00 · R:R 1:2"] });
    expect(positionLabelTexts(p, 2, { deposit: 10000, riskPct: 1 }, DRAWING_TEXT).entry).toEqual(["Вход 100.00 · R:R 1:2", "риск 100 $ · объём 20.00"]);
    const s = positionParts(pos("position-short", 100, 104, 94))!;
    expect(positionLabelTexts(s, 2, null, DRAWING_TEXT)).toEqual({ target: "Цель 94.00 · +6.00% · 1.5R", stop: "Стоп 104.00 · −4.00%", entry: ["Вход 100.00 · R:R 1:1.5"] });
    expect(positionLabelTexts(s, 2, null, { entry: "Entry", stop: "Stop", target: "Target", risk: "risk", size: "size" }).target).toMatch(/^Target 94.00/);
  });

  it("плашки: цель над зоной прибыли (у Short — под ней), стоп под зоной риска, вход на своей линии; цвета зон", () => {
    const long = labelsOf([pos("position-long", 100, 96, 108)]);
    const by = (ls: DrawingLabel[], part: string) => ls.find((l) => l.id === `P#${part}`)!;
    expect(by(long, "target").slots[0]!.y + by(long, "target").h).toBeLessThanOrEqual(368);
    expect(by(long, "stop").slots[0]!.y).toBeGreaterThanOrEqual(416);
    const e = by(long, "entry");
    expect(e.slots[0]!.y).toBeLessThan(400);
    expect(e.slots[0]!.y + e.h).toBeGreaterThan(400);
    expect([by(long, "target").color, by(long, "stop").color, e.color]).toEqual([TOKENS.up, TOKENS.down, TOKENS.text2]);
    const short = labelsOf([pos("position-short", 100, 104, 92)]);
    expect(by(short, "target").slots[0]!.y).toBeGreaterThanOrEqual((200 - 92) * 4);
    expect(by(short, "stop").slots[0]!.y + by(short, "stop").h).toBeLessThanOrEqual((200 - 104) * 4);
    // по горизонтали — посередине позиции
    const t = by(long, "target");
    expect(t.slots[0]!.x + t.w / 2).toBeCloseTo(350, 6);
  });

  it("подписи — в панели: у верхнего и правого края прижимаются внутрь; позиция за экраном — без подписей", () => {
    const top = labelsOf([pos("position-long", 199, 195, 200.5, 90, 99)]);
    for (const l of top) for (const s of l.slots) {
      expect(s.y).toBeGreaterThanOrEqual(0);
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.x + l.w).toBeLessThanOrEqual(1000);
      expect(s.y + l.h).toBeLessThanOrEqual(800);
    }
    expect(labelsOf([pos("position-long", 100, 96, 108, 120, 140)])).toEqual([]);
    // зона прибыли целиком выше панели — подписи цели нет, стоп и вход есть
    const off = labelsOf([pos("position-long", 210, 190, 260)]).map((l) => l.id);
    expect(off).toEqual(["P#stop", "P#entry"]);
  });

  it("порядок: начатый и выбранный рисунок раньше остальных; уровни Фибоначчи — ключевые раньше", () => {
    const a = pos("position-long", 100, 96, 108);
    const b = { ...pos("position-short", 120, 124, 112), id: "Q" };
    const ls = labelsOf([a, b], { selectedId: "Q" });
    expect(ls.find((l) => l.id === "Q#entry")!.rank).toBeLessThan(ls.find((l) => l.id === "P#entry")!.rank);
    const fib: Drawing = { ...a, id: "F", type: "fib", points: [{ time: T0 + 10 * H, price: 120 }, { time: T0 + 40 * H, price: 80 }], levels: [0, 0.236, 0.5, 1] };
    const fl = labelsOf([fib]);
    expect(fl.find((l) => l.id === "F#L0.5")!.mode).toBe("soft");
    expect(fl.find((l) => l.id === "F#L0.236")!.mode).toBe("drop");
    expect(fl.find((l) => l.id === "F#L0.5")!.rank).toBeLessThan(fl.find((l) => l.id === "F#L0.236")!.rank);
  });
});

/** Область раскладки 1000 × 800 без полосы OHLC и объёма; свечей нет. */
const VP: Viewport = { width: 1000, height: 800, insetTop: 0, volumeTopY: 800, free: null, gutter: null };
const NO_CANDLES = { x0: 0, spacing: 0, halfWidth: 0, top: new Float32Array(0), bottom: new Float32Array(0) };
const obstacles = (rects: Obstacles["rects"] = []): Obstacles => ({ candles: NO_CANDLES, rects });
const BUDGET = { canvas: 8, perLayer: {} };
/** Подпись разметки с одним местом. */
const markup = (id: string, rect: Rect, priority: number): LabelCandidate => ({ id, objectId: id, layer: "sr", text: id, font: "sans", px: 11, w: rect.w, h: rect.h, priority, tone: "up", slots: [{ key: "free-above", x: rect.x, y: rect.y, clampX: false }], bypassBudget: false });
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("подписи рисунков и разметки в одной раскладке", () => {
  const long = pos("position-long", 100, 96, 108);
  const cands = () => labelsOf([long]).map(toCandidate);
  const first = (id: string) => {
    const c = cands().find((x) => x.id === id)!;
    return { x: c.slots[0]!.x, y: c.slots[0]!.y, w: c.w, h: c.h };
  };

  it("«Подд.» (80) ниже подписи рисунка: подпись рисунка на своём месте, разметка уходит или пропадает", () => {
    const r = first("P#target");
    const res = layoutLabels([...cands(), markup("sr", r, 80)], obstacles(), VP, BUDGET);
    expect(res.external!.find((p) => p.id === "P#target")!.rect).toEqual(r);
    expect(res.placed.find((p) => p.id === "sr")).toBeUndefined();
    expect(res.dropped).toContainEqual({ id: "sr", reason: "collision" });
    expect(DRAWING_LABEL_PRIORITY).toBeGreaterThan(80);
  });

  it("алерт (90) старше: его подпись на месте, подпись рисунка — на следующем месте, без наложения", () => {
    const r = first("P#target");
    const res = layoutLabels([...cands(), markup("alert", r, 90)], obstacles(), VP, BUDGET);
    expect(res.placed.find((p) => p.id === "alert")!.rect).toEqual(r);
    const t = res.external!.find((p) => p.id === "P#target")!;
    expect(overlaps(t.rect, r)).toBe(false);
    for (const p of res.external!) for (const q of res.placed) expect(overlaps(p.rect, q.rect)).toBe(false);
  });

  it("полоса текущей цены, легенда, кнопки — препятствия: подпись рисунка на них не ложится даже без места", () => {
    const r = first("P#target");
    const band = { x: 0, y: r.y - 4, w: 1000, h: r.h + 8 };
    const res = layoutLabels(cands(), obstacles([{ rect: band, kind: "lastPrice" }]), VP, BUDGET);
    const t = res.external!.find((p) => p.id === "P#target")!;
    expect(overlaps(t.rect, band)).toBe(false);
  });

  it("нет свободного места: soft — первое место без препятствий (поверх подписи), drop — не показывать, fixed — на месте", () => {
    const c0 = cands().find((x) => x.id === "P#stop")!;
    // одно место, его заняла подпись старше (95)
    const c = { ...c0, slots: [c0.slots[0]!] };
    const blocker = markup("sel", { x: c.slots[0]!.x, y: c.slots[0]!.y, w: c.w, h: c.h }, 95);
    const soft = layoutLabels([c, blocker], obstacles(), VP, BUDGET);
    expect(soft.external!.map((p) => p.id)).toEqual(["P#stop"]);
    expect(soft.placed.map((p) => p.id)).toEqual(["sel"]);
    const drop = layoutLabels([{ ...c, force: undefined }, blocker], obstacles(), VP, BUDGET);
    expect(drop.external).toEqual([]);
    expect(drop.dropped).toContainEqual({ id: "P#stop", reason: "collision" });
    const fixed = layoutLabels([{ ...c, force: "fixed" }], obstacles([{ rect: { x: 0, y: 0, w: 1000, h: 800 }, kind: "ui" }]), VP, BUDGET);
    expect(fixed.external!.map((p) => p.id)).toEqual(["P#stop"]);
    // всё место занято препятствием — soft не кладёт подпись на него
    const blocked = layoutLabels([c], obstacles([{ rect: { x: 0, y: 0, w: 1000, h: 800 }, kind: "ui" }]), VP, BUDGET);
    expect(blocked.external).toEqual([]);
  });

  it("ручки выбранной позиции (палец — 20 px) заняты: плашки цели, стопа и входа под ними не прячутся", () => {
    const d = pos("position-long", 100, 96, 108, 20, 32);
    const handles = handleRects({ drawings: [d], draft: null, selectedId: "P", proj: PROJ }, true);
    expect(handles).toHaveLength(4);
    expect(handles[0]!.rect.w).toBe(20);
    expect(handleRects({ drawings: [d], draft: null, selectedId: null, proj: PROJ }, true)).toEqual([]);
    const fib: Drawing = { ...d, id: "F", type: "fib", points: [{ time: T0 + 10 * H, price: 120 }, { time: T0 + 40 * H, price: 80 }] };
    expect(handleRects({ drawings: [fib], draft: null, selectedId: "F", proj: PROJ }, false).map((h) => h.rect.w)).toEqual([8, 8]);
    const res = layoutLabels([...handles.map(handleCandidate), ...labelsOf([d], { selectedId: "P" }).map(toCandidate)], obstacles(), VP, BUDGET);
    const labels = res.external!.filter((p) => p.text !== "");
    expect(labels).toHaveLength(3);
    for (const l of labels) for (const h of handles) expect(overlaps(l.rect, h.rect), `${l.id} / ${h.id}`).toBe(false);
  });

  it("подписи рисунков не ложатся друг на друга: две позиции рядом, подписи сдвинуты", () => {
    const a = pos("position-long", 100, 96, 108);
    const b = { ...pos("position-long", 103, 99, 111, 35, 65), id: "Q" };
    const res = layoutLabels(labelsOf([a, b]).map(toCandidate), obstacles(), VP, BUDGET);
    const ext = res.external!;
    expect(ext.length).toBe(6);
    for (let i = 0; i < ext.length; i++) for (let j = i + 1; j < ext.length; j++) expect(overlaps(ext[i]!.rect, ext[j]!.rect), `${ext[i]!.id} / ${ext[j]!.id}`).toBe(false);
  });
});

const sr = (price: number, priority: number): HLineObject => ({
  kind: "hline",
  id: `sr:${price}`,
  layer: "sr",
  tone: "up",
  priority,
  hover: { title: "Поддержка", price },
  label: { text: "Подд.", tone: "up", priority, slots: ["line-end-above", "line-end-below"], font: "sans", show: "always" },
  emphasis: "normal",
  price,
  from: null,
  to: null,
  style: "dashed",
  width: 1,
});
const sceneOf = (objects: HLineObject[]): Scene => ({ version: 1, key: "k", objects, byId: new Map(objects.map((o) => [o.id, o])), legend: [], legendOf: new Map(), index: { version: 1, levels: [], onChart: new Set(), dropped: new Set(), liqUnavailable: false }, selected: null });

describe("OverlayPrimitive: подписи рисунков в кадре разметки", () => {
  function setup() {
    const candles = bars(100);
    const env = makeEnv(() => candles, { range: { from: 0, to: 114 }, top: 110, bottom: 90 });
    const overlay = new OverlayPrimitive({ view: VIEW.desktop, theme: makeTheme(), measure: monoMeasurer(), candles: () => candles, tfSeconds: () => H });
    env.series.attachPrimitive(overlay as never);
    const prim = new DrawingsPrimitive(TOKENS);
    env.series.attachPrimitive(prim as never);
    prim.projector!.setBars(candles.map((c) => c.time), H);
    prim.linked = () => overlay.externalPlaced();
    overlay.setExternalLabels((m) => prim.labelCandidates(m));
    return { env, overlay, prim, candles };
  }

  it("кандидаты рисунков — в той же раскладке: подписи разметки их обходят, в debug — drawingLabels", () => {
    const { overlay, prim } = setup();
    overlay.setScene(sceneOf([sr(103, 80), sr(97, 40)]));
    prim.update({ drawings: [pos("position-long", 100, 98, 104, 60, 90)] });
    overlay.updateAllViews();
    const dbg = overlay.debug();
    expect(dbg.drawingLabels.map((l) => l.id).sort()).toEqual(["P#entry", "P#stop", "P#target"]);
    expect(dbg.labels.every((l) => l.layer !== "drawings")).toBe(true);
    for (const d of dbg.drawingLabels) for (const l of dbg.labels) expect(overlaps(d.rect, l.rect), `${d.id} / ${l.id}`).toBe(false);
    expect(overlay.externalPlaced()!.length).toBe(3);
  });

  it("рисунок сдвинулся — кадр пересчитан (ключ кадра — с подписями рисунков); без провайдера — их нет", () => {
    const { overlay, prim } = setup();
    overlay.setScene(sceneOf([sr(103, 80)]));
    prim.update({ drawings: [pos("position-long", 100, 98, 104, 60, 90)] });
    overlay.updateAllViews();
    const k1 = overlay.debug().frameKey;
    prim.update({ drawings: [pos("position-long", 101, 98, 104, 60, 90)] });
    overlay.updateAllViews();
    expect(overlay.debug().frameKey).not.toBe(k1);
    overlay.setExternalLabels(null);
    overlay.updateAllViews();
    expect(overlay.debug().drawingLabels).toEqual([]);
  });

  it("без сцены места нет (null): примитив рисует подписи своей раскладкой", () => {
    const { overlay } = setup();
    expect(overlay.externalPlaced()).toBeNull();
  });
});

type Rec = { fills: { style: string; x: number; y: number; w: number; h: number }[]; texts: { text: string; x: number; y: number; fill: string }[]; strokes: { style: string; y0: number; y1: number }[]; arcs: number; rects: number };
function canvas(): { ctx: unknown; rec: Rec } {
  const rec: Rec = { fills: [], texts: [], strokes: [], arcs: 0, rects: 0 };
  const st = { fillStyle: "", strokeStyle: "", font: "", lineWidth: 1, globalAlpha: 1, textBaseline: "" };
  let path: { x: number; y: number }[] = [];
  const ctx = Object.assign(st, {
    save: () => undefined,
    restore: () => undefined,
    setLineDash: () => undefined,
    beginPath: () => (path = []),
    moveTo: (x: number, y: number) => path.push({ x, y }),
    lineTo: (x: number, y: number) => path.push({ x, y }),
    stroke: () => rec.strokes.push({ style: st.strokeStyle, y0: path[0]?.y ?? NaN, y1: path[1]?.y ?? NaN }),
    fillText: (text: string, x: number, y: number) => rec.texts.push({ text, x, y, fill: st.fillStyle }),
    fillRect: (x: number, y: number, w: number, h: number) => rec.fills.push({ style: st.fillStyle, x, y, w, h }),
    strokeRect: () => undefined,
    measureText: (t: string) => ({ width: t.length * 6.6 }),
    arc: () => rec.arcs++,
    rect: () => rec.rects++,
    fill: () => undefined,
    closePath: () => undefined,
  });
  return { ctx, rec };
}

function paint(prim: DrawingsPrimitive): Rec {
  const c = canvas();
  prim.paneViews()[0]!.renderer()!.draw({ useMediaCoordinateSpace: (cb: (s: unknown) => void) => cb({ context: c.ctx, mediaSize: { width: 800, height: 400 } }) } as never);
  return c.rec;
}

describe("отрисовка позиции", () => {
  function prim(drawings: Drawing[], selectedId: string | null = null, touch = false) {
    const candles = bars(60);
    const env = makeEnv(() => candles, { top: 120, bottom: 80 });
    const p = new DrawingsPrimitive(TOKENS);
    p.attached({ chart: env.chart, series: env.series, requestUpdate: () => undefined } as never);
    p.projector!.setBars(candles.map((c) => c.time), H);
    p.update({ drawings, selectedId, touch });
    return p;
  }

  it("зона прибыли — --up, зона риска — --down, полупрозрачные (12 %); линия входа нейтральная; плашки с текстами", () => {
    const r = paint(prim([pos("position-long", 100, 96, 108)]));
    expect(r.fills.map((f) => f.style)).toContain(alpha(TOKENS.up, POSITION_FILL_ALPHA));
    expect(r.fills.map((f) => f.style)).toContain(alpha(TOKENS.down, POSITION_FILL_ALPHA));
    expect(POSITION_FILL_ALPHA).toBeLessThanOrEqual(0.15);
    const styles = r.strokes.map((s) => s.style);
    expect(styles).toEqual(expect.arrayContaining([TOKENS.up, TOKENS.down, TOKENS.text2]));
    const texts = r.texts.map((t) => t.text);
    expect(texts.find((t) => t.startsWith("Цель "))).toMatch(/· \+8\.00% · 2R$/);
    expect(texts.find((t) => t.startsWith("Стоп "))).toMatch(/· −4\.00%$/);
    expect(texts.find((t) => t.startsWith("Вход "))).toMatch(/R:R 1:2$/);
    expect(r.texts.find((t) => t.text.startsWith("Цель "))!.fill).toBe(TOKENS.up);
    expect(r.texts.find((t) => t.text.startsWith("Стоп "))!.fill).toBe(TOKENS.down);
    // невыбранная — без ручек
    expect(r.arcs).toBe(0);
  });

  it("выбранная — ручки входа, стопа, цели (круги) и правого края; профиль — вторая строка плашки входа", () => {
    const p = prim([pos("position-long", 100, 96, 108)], "P");
    p.update({ profile: { deposit: 10000, riskPct: 1 } });
    const r = paint(p);
    expect(r.arcs).toBe(3);
    expect(r.rects).toBe(1);
    expect(r.texts.map((t) => t.text)).toContain("риск 100 $ · объём 25.00");
  });

  it("места подписей — из общей раскладки, если она посчитана для этого состояния", () => {
    const p = prim([pos("position-long", 100, 96, 108)]);
    const rect = { x: 11, y: 22, w: 200, h: 16 };
    p.labelCandidates(monoMeasurer());
    p.linked = () => [{ id: "P#target", objectId: "P", layer: "drawings", text: "", rect, slot: "free-above", tone: "muted", font: "mono", px: 11, priority: 85, bypassBudget: true }];
    const r = paint(p);
    const t = r.texts.find((x) => x.text.startsWith("Цель "))!;
    expect(t.x).toBe(11 + 4);
    // стоп и вход в общей раскладке не размещены — не рисуются
    expect(r.texts.some((x) => x.text.startsWith("Стоп "))).toBe(false);
    // состояние сменилось после раскладки — своя раскладка
    p.update({ selectedId: "P" });
    expect(paint(p).texts.some((x) => x.text.startsWith("Стоп "))).toBe(true);
  });
});
