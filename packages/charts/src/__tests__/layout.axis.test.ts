import { describe, expect, it } from "vitest";
import { bandsKey, hideHalf, inBands, layoutAxis } from "../layout/axis";
import type { AxisCandidate, AxisFixed, AxisScale } from "../layout/types";
import { VIEW, type AxisBudget } from "../presets";

const SCALE: AxisScale = { height: 600, labelH: 18, gap: 1, maxShift: 27, tickFontPx: 12 };
const WIDE: AxisBudget = { srPerSide: 9, alerts: 9, positions: 9, topdown: 9, total: 99, countdown: true };
const LAST: AxisFixed[] = [
  { id: "last", y: 300, h: 18 },
  { id: "countdown", y: 318, h: 18 },
];

const cand = (id: string, y: number, p: Partial<AxisCandidate> = {}): AxisCandidate => ({
  id,
  objectId: id,
  price: 1000 - y,
  y,
  text: `p${y}`,
  tone: "up",
  style: "outline",
  priority: 80,
  group: "sr",
  side: y < 300 ? "above" : "below",
  ...p,
});

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("layoutAxis (M04): метки шкалы", () => {
  it("на своём y, если свободно", () => {
    const r = layoutAxis([cand("a", 100), cand("b", 500)], LAST, SCALE, WIDE);
    expect(r.placed.map((p) => [p.id, p.y])).toEqual([
      ["a", 100],
      ["b", 500],
    ]);
  });

  it("конфликт с ценой — сдвиг от цены, не дальше maxShift; дальше — выброшена", () => {
    const r = layoutAxis([cand("a", 290), cand("b", 330), cand("c", 312, { side: "below" }), cand("d", 340, { priority: 40 })], LAST, SCALE, WIDE);
    const y = Object.fromEntries(r.placed.map((p) => [p.id, p.y]));
    expect(y.a).toBe(300 - 18 - 1); // над ценой вплотную
    expect(y.c).toBe(318 + 18 + 1); // ближе к цене — раньше: под отсчётом
    expect(y.b).toBe(337 + 18 + 1); // под c, сдвиг 26 ≤ 27
    expect(r.dropped).toEqual([{ id: "d", reason: "collision" }]); // 340 → 375: дальше maxShift
  });

  it("одинаковые цены склеиваются: тон и стиль старшего", () => {
    const r = layoutAxis([cand("sr", 100, { text: "83 528", priority: 80 }), cand("al", 100.4, { text: "83 528", priority: 90, group: "alert", tone: "alert" })], LAST, SCALE, WIDE);
    expect(r.placed).toEqual([{ id: "al", objectId: "al", y: 100.4, text: "83 528", tone: "alert", style: "outline", merged: ["sr"] }]);
  });

  it("бюджеты: S/R на сторону, группы и общий", () => {
    const xs = [
      cand("r1", 280, { priority: 80 }),
      cand("r2", 200, { priority: 40 }),
      cand("s1", 340, { priority: 80 }),
      cand("s2", 400, { priority: 40 }),
      cand("a1", 100, { group: "alert", priority: 90 }),
      cand("a2", 60, { group: "alert", priority: 90 }),
      cand("p1", 500, { group: "position", priority: 90 }),
      cand("t1", 550, { group: "topdown", priority: 65 }),
    ];
    const cell = layoutAxis(xs, [], SCALE, VIEW.cell.axis);
    expect(cell.placed.map((p) => p.id).sort()).toEqual(["a1", "r1", "s1"]);
    const desk = layoutAxis(xs, [], SCALE, VIEW.desktop.axis);
    expect(desk.placed.map((p) => p.id).sort()).toEqual(["a1", "a2", "p1", "r1", "r2", "s1", "s2", "t1"]);
    const tight = layoutAxis(xs, [], SCALE, { ...WIDE, total: 2 });
    expect(tight.placed.map((p) => p.id)).toEqual(["a1", "a2"]);
    expect(tight.dropped.every((d) => d.reason === "budget")).toBe(true);
    const phone = layoutAxis(xs, [], SCALE, VIEW.phone.axis);
    expect(phone.placed.filter((p) => p.id.startsWith("r") || p.id.startsWith("s"))).toHaveLength(2);
  });

  it("вне шкалы — offscreen", () => {
    const r = layoutAxis([cand("a", 4), cand("b", 700), cand("c", Number.NaN)], LAST, SCALE, WIDE);
    expect(r.placed).toHaveLength(0);
    expect(r.dropped.map((d) => d.reason)).toEqual(["offscreen", "offscreen", "offscreen"]);
  });

  it("полосы без делений: центр ± (labelH + tickFont)/2 + 1", () => {
    expect(hideHalf(18, 12)).toBe(16);
    expect(hideHalf(16, 11)).toBe(14.5);
    const r = layoutAxis([cand("a", 100)], LAST, SCALE, WIDE);
    expect(r.hiddenBands).toEqual([
      [84, 116],
      [284, 316],
      [302, 334],
    ]);
    expect(inBands(84, r.hiddenBands)).toBe(true);
    expect(inBands(116.01, r.hiddenBands)).toBe(false);
    expect(inBands(320, r.hiddenBands)).toBe(true);
    expect(inBands(500, r.hiddenBands)).toBe(false);
    expect(bandsKey([[84.24, 116.26]])).toBe("84:116.5");
  });

  it("без цены — порядок по приоритету и id", () => {
    const r = layoutAxis([cand("b", 100), cand("a", 100.5)], [], SCALE, WIDE);
    expect(r.placed[0]!.id).toBe("a");
    expect(r.placed[1]!.y).toBe(100.5 - 19);
  });

  describe("свойства на 100 случайных наборах", () => {
    for (let seed = 1; seed <= 100; seed++) {
      it(`сид ${seed}`, () => {
        const rnd = mulberry32(seed);
        const height = 300 + Math.floor(rnd() * 500);
        const scale: AxisScale = { height, labelH: 16 + Math.floor(rnd() * 3), gap: 1, maxShift: 0, tickFontPx: 11 };
        scale.maxShift = 1.5 * scale.labelH;
        const yLast = height * (0.2 + rnd() * 0.6);
        const fixed: AxisFixed[] = [
          { id: "last", y: yLast, h: scale.labelH },
          { id: "countdown", y: yLast + scale.labelH, h: scale.labelH },
        ];
        if (rnd() < 0.3) fixed.push({ id: "overlay", y: rnd() * height, h: scale.labelH });
        const groups: AxisCandidate["group"][] = ["sr", "alert", "position", "topdown"];
        const xs = Array.from({ length: 2 + Math.floor(rnd() * 14) }, (_, i) => {
          const y = rnd() * height;
          return cand(`c${i}`, y, { side: y < yLast ? "above" : "below", priority: [40, 65, 80, 88, 90][Math.floor(rnd() * 5)]!, group: groups[Math.floor(rnd() * 4)]!, text: rnd() < 0.15 ? "dup" : `t${i}` });
        });
        const budget = [VIEW.desktop.axis, VIEW.phone.axis, VIEW.cell.axis][seed % 3]!;
        const r = layoutAxis(xs, fixed, scale, budget);
        const byId = new Map(xs.map((x) => [x.id, x]));
        // фиксированные не двигаются и не попадают в placed
        expect(r.placed.some((p) => fixed.some((f) => f.id === p.id))).toBe(false);
        const all = [...fixed.map((f) => ({ y: f.y, h: f.h, id: f.id })), ...r.placed.map((p) => ({ y: p.y, h: scale.labelH, id: p.id }))];
        for (const p of r.placed) {
          const c = byId.get(p.id)!;
          expect(Math.abs(p.y - c.y)).toBeLessThanOrEqual(scale.maxShift + 1e-9);
          if (c.side === "above") expect(p.y).toBeLessThanOrEqual(c.y);
          else expect(p.y).toBeGreaterThanOrEqual(c.y);
          expect(p.y).toBeGreaterThanOrEqual(scale.labelH / 2);
          expect(p.y).toBeLessThanOrEqual(height - scale.labelH / 2);
        }
        // центры не ближе (h1 + h2)/2 + gap; фиксированные между собой не проверяем
        for (let i = 0; i < all.length; i++)
          for (let j = i + 1; j < all.length; j++) {
            const a = all[i]!;
            const b = all[j]!;
            if (fixed.some((f) => f.id === a.id) && fixed.some((f) => f.id === b.id)) continue;
            expect(Math.abs(a.y - b.y), `${a.id} ${b.id}`).toBeGreaterThanOrEqual((a.h + b.h) / 2 + scale.gap - 1e-9);
          }
        // склейка: один текст — одна метка
        const texts = r.placed.map((p) => p.text);
        expect(new Set(texts).size).toBe(texts.length);
        // бюджеты
        expect(r.placed.length).toBeLessThanOrEqual(budget.total);
        const count = (g: string, side?: string) => r.placed.filter((p) => byId.get(p.id)!.group === g && (!side || byId.get(p.id)!.side === side)).length;
        expect(count("alert")).toBeLessThanOrEqual(budget.alerts);
        expect(count("position")).toBeLessThanOrEqual(budget.positions);
        expect(count("topdown")).toBeLessThanOrEqual(budget.topdown);
        expect(count("sr", "above")).toBeLessThanOrEqual(budget.srPerSide);
        expect(count("sr", "below")).toBeLessThanOrEqual(budget.srPerSide);
        // все кандидаты учтены
        const seen = new Set([...r.placed.flatMap((p) => [p.id, ...p.merged]), ...r.dropped.map((d) => d.id)]);
        expect(seen.size).toBe(xs.length);
        // полосы: на каждую метку и фиксированную
        expect(r.hiddenBands).toHaveLength(fixed.length + r.placed.length);
        for (const p of r.placed) expect(inBands(p.y, r.hiddenBands)).toBe(true);
      });
    }
  });
});
