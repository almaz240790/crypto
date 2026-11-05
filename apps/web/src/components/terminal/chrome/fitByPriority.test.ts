import { describe, expect, it } from "vitest";
import { fitByPriority, sameFit, type ItemWidth, type ShedStep } from "./fitByPriority";

/** Подгонка строки по приоритетам (план 2B.9): шапка и тулбар терминала. */
const W: Record<string, ItemWidth> = {
  tf: { full: 270 },
  view: { full: 76, compact: 40 },
  ind: { full: 141, compact: 115 },
  markup: { full: 120, compact: 40 },
  alert: { full: 107, compact: 80 },
  snap: { full: 32 },
  multi: { full: 32 },
  more: { full: 32 },
  objects: { full: 97, compact: 40 },
};
const SHED: ShedStep[] = [
  { id: "objects", action: "compact" },
  { id: "multi", action: "hide" },
  { id: "snap", action: "hide" },
  { id: "view", action: "compact" },
  { id: "ind", action: "compact" },
  { id: "alert", action: "compact" },
  { id: "markup", action: "compact" },
];
const GAP = 8;
const full = Object.values(W).reduce((s, w) => s + w.full, 0) + GAP * (Object.keys(W).length - 1);

describe("fitByPriority", () => {
  it("влезает — ничего не сворачивается и не прячется", () => {
    const f = fitByPriority(W, SHED, full, GAP);
    expect([...f.compact]).toEqual([]);
    expect([...f.hidden]).toEqual([]);
  });

  it("шаги — строго по порядку: сначала первый, затем следующий", () => {
    const f1 = fitByPriority(W, SHED, full - 1, GAP);
    expect([...f1.compact]).toEqual(["objects"]);
    expect([...f1.hidden]).toEqual([]);
    // после «Объектов» (−57) нужен ещё шаг: «Мультичарт» уходит из строки вместе с промежутком
    const f2 = fitByPriority(W, SHED, full - 60, GAP);
    expect([...f2.compact]).toEqual(["objects"]);
    expect([...f2.hidden]).toEqual(["multi"]);
  });

  it("элементы без шага (таймфреймы, «⋯») не трогаются, даже если всё равно не влезает", () => {
    const f = fitByPriority(W, SHED, 100, GAP);
    expect(f.hidden.has("tf")).toBe(false);
    expect(f.hidden.has("more")).toBe(false);
    expect(f.compact.has("tf")).toBe(false);
    // все шаги применены
    expect(new Set([...f.compact, ...f.hidden])).toEqual(new Set(SHED.map((x) => x.id)));
  });

  it("сначала компактный вид, потом скрытие: спрятанный элемент не остаётся в compact", () => {
    const steps: ShedStep[] = [
      { id: "view", action: "compact" },
      { id: "view", action: "hide" },
    ];
    const f = fitByPriority({ view: { full: 100, compact: 40 }, tf: { full: 300 } }, steps, 300, GAP);
    expect(f.hidden.has("view")).toBe(true);
    expect(f.compact.has("view")).toBe(false);
  });

  it("шаги для отсутствующих элементов и compact без компактной ширины пропускаются", () => {
    const f = fitByPriority({ a: { full: 200 }, b: { full: 200 } }, [{ id: "nope", action: "hide" }, { id: "a", action: "compact" }, { id: "b", action: "hide" }], 300, GAP);
    expect([...f.compact]).toEqual([]);
    expect([...f.hidden]).toEqual(["b"]);
  });

  it("детерминирована: тот же вход — тот же результат", () => {
    for (const avail of [300, 700, 844, 968, 1044, 1384]) expect(sameFit(fitByPriority(W, SHED, avail, GAP), fitByPriority(W, SHED, avail, GAP))).toBe(true);
  });

  it("чем уже строка, тем больше шагов (монотонно)", () => {
    let prev = -1;
    for (let avail = full; avail > 300; avail -= 10) {
      const f = fitByPriority(W, SHED, avail, GAP);
      const n = f.compact.size + f.hidden.size;
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
  });
});
