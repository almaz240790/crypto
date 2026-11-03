import { describe, expect, it } from "vitest";
import { layoutLabels, hitsCandles, inflate, intersects, compareCandidates } from "../layout/labels";
import type { CandleBand, LabelCandidate, Obstacles, Rect, Viewport } from "../layout/types";
import { VIEW, type LabelBudget } from "../presets";
import { LAYER_ORDER } from "../scene/build";
import type { SlotKey } from "../scene/types";
import type { SceneLayer } from "../types";

/** Детерминированный генератор (mulberry32). */
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

const PRIORITIES = [10, 20, 25, 30, 40, 45, 50, 55, 60, 65, 70, 80, 90, 95];
const SLOT_KEYS: SlotKey[] = ["free-above", "free-below", "line-end-above", "line-end-below", "box-top-left", "glyph-above"];

type Case = { candidates: LabelCandidate[]; obstacles: Obstacles; viewport: Viewport; budget: LabelBudget; band: Rect };

/** Случайная сцена: блуждание свечей, 5–40 кандидатов по 1–4 места, полоса цены, бюджет одного из устройств. */
function randomCase(seed: number, nCand?: number): Case {
  const rnd = mulberry32(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const width = 320 + Math.floor(rnd() * 1100);
  const height = 300 + Math.floor(rnd() * 600);
  const view = pick([VIEW.desktop, VIEW.phone, VIEW.cell]);
  const spacing = 4 + rnd() * 9;
  const freeX0 = width - view.rightOffsetPx;
  const n = Math.max(0, Math.floor(freeX0 / spacing));
  const top = new Float32Array(n);
  const bottom = new Float32Array(n);
  let mid = height * (0.3 + rnd() * 0.4);
  for (let i = 0; i < n; i++) {
    mid = Math.min(height * 0.8, Math.max(height * 0.1, mid + (rnd() - 0.5) * 14));
    const half = 3 + rnd() * 20;
    top[i] = mid - half;
    bottom[i] = mid + half;
    if (rnd() < 0.03) top[i] = bottom[i] = NaN;
  }
  const candles: CandleBand = { x0: spacing / 2, spacing, halfWidth: Math.max(1, 0.4 * spacing) + 1, top, bottom };
  const yLast = n > 0 ? (bottom[n - 1]! + top[n - 1]!) / 2 || mid : mid;
  const band = { x: freeX0, y: yLast - view.axisLabelPx / 2, w: width - freeX0, h: view.axisLabelPx };
  const viewport: Viewport = { width, height, insetTop: view.insetTopPx, volumeTopY: height * view.volumeTop, free: { x0: freeX0, x1: width }, gutter: null };
  const count = nCand ?? 5 + Math.floor(rnd() * 36);
  const candidates: LabelCandidate[] = [];
  for (let i = 0; i < count; i++) {
    const w = Math.round(30 + rnd() * 70);
    const h = 17;
    const ly = rnd() * height;
    const slots = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => {
      const inFree = rnd() < 0.5;
      return { key: pick(SLOT_KEYS), x: inFree ? width - 4 - w : -60 + rnd() * (width + 60), y: ly + (rnd() < 0.5 ? -2 - h : 2) + (rnd() - 0.5) * 30, clampX: rnd() < 0.2 };
    });
    const layer: SceneLayer = pick(LAYER_ORDER);
    candidates.push({ id: `o${i}#label`, objectId: `o${i}`, layer, text: `t${i}`, font: rnd() < 0.2 ? "mono" : "sans", px: 11, w, h, priority: pick(PRIORITIES), tone: "up", slots, bypassBudget: rnd() < 0.08 });
  }
  return { candidates, obstacles: { candles, rects: [{ rect: band, kind: "lastPrice" }] }, viewport, budget: view.labels, band };
}

/** Независимая проверка пересечения с колонками свечей — перебором. */
function hitsCandlesBrute(r: Rect, b: CandleBand): boolean {
  for (let i = 0; i < b.top.length; i++) {
    const t = b.top[i]!;
    const bt = b.bottom[i]!;
    if (Number.isNaN(t) || Number.isNaN(bt)) continue;
    const xc = b.x0 + i * b.spacing;
    if (xc + b.halfWidth >= r.x && xc - b.halfWidth <= r.x + r.w && t <= r.y + r.h && bt >= r.y) return true;
  }
  return false;
}

function shuffle<T>(xs: readonly T[], seed: number): T[] {
  const rnd = mulberry32(seed);
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe("layoutLabels: свойства на 200 случайных сценах", () => {
  for (let seed = 1; seed <= 200; seed++) {
    it(`сид ${seed}`, () => {
      const c = randomCase(seed);
      const res = layoutLabels(c.candidates, c.obstacles, c.viewport, c.budget);
      const byId = new Map(c.candidates.map((x) => [x.id, x]));
      expect(res.placed.length + res.dropped.length).toBe(c.candidates.length);
      // не пересекаются, зазор ≥ 2 px
      for (let i = 0; i < res.placed.length; i++)
        for (let j = i + 1; j < res.placed.length; j++) expect(intersects(inflate(res.placed[i]!.rect, 2), res.placed[j]!.rect), `${res.placed[i]!.id} × ${res.placed[j]!.id}`).toBe(false);
      for (const p of res.placed) {
        const cand = byId.get(p.id)!;
        // внутри области, выше объёма и ниже полосы OHLC
        expect(p.rect.x).toBeGreaterThanOrEqual(2);
        expect(p.rect.x + p.rect.w).toBeLessThanOrEqual(c.viewport.width - 2 + 1e-9);
        expect(p.rect.y).toBeGreaterThanOrEqual(c.viewport.insetTop);
        expect(p.rect.y + p.rect.h).toBeLessThanOrEqual(c.viewport.volumeTopY + 1e-9);
        // не на свече и не на полосе цены
        expect(hitsCandlesBrute(inflate(p.rect, 2), c.obstacles.candles)).toBe(false);
        expect(intersects(inflate(p.rect, 2), c.band)).toBe(false);
        // шрифт не меняется
        expect(p.px).toBe(cand.px);
        expect([p.rect.w, p.rect.h]).toEqual([cand.w, cand.h]);
        expect(cand.slots.map((s) => s.key)).toContain(p.slot);
      }
      // бюджет: всего и по слоям, обходящие бюджет — сверх
      const counted = res.placed.filter((p) => !p.bypassBudget);
      expect(counted.length).toBeLessThanOrEqual(c.budget.canvas);
      for (const layer of LAYER_ORDER) {
        const cap = c.budget.perLayer[layer];
        if (cap !== undefined) expect(counted.filter((p) => p.layer === layer).length).toBeLessThanOrEqual(cap);
      }
      // приоритет: выброшенный по бюджету не старше размещённого, который съел тот же бюджет
      for (const d of res.dropped.filter((x) => x.reason === "budget")) {
        const cand = byId.get(d.id)!;
        expect(cand.bypassBudget).toBe(false);
        const cap = c.budget.perLayer[cand.layer];
        const sameLayer = counted.filter((p) => p.layer === cand.layer);
        const byTotal = cap === undefined || sameLayer.length < cap;
        const rivals = byTotal ? counted : sameLayer;
        for (const p of rivals) expect(p.priority, `${d.id} (${cand.priority}) выброшен, ${p.id} (${p.priority}) размещён`).toBeGreaterThanOrEqual(cand.priority);
      }
      // порядок входа не важен
      const again = layoutLabels(shuffle(c.candidates, seed * 7 + 1), c.obstacles, c.viewport, c.budget);
      const key = (r: typeof res) => JSON.stringify([[...r.placed].sort((a, b) => a.id.localeCompare(b.id)), [...r.dropped].sort((a, b) => a.id.localeCompare(b.id))]);
      expect(key(again)).toBe(key(res));
    });
  }

  it("сцены не пустые: подписи размещаются и выбрасываются по всем причинам", () => {
    const totals = { placed: 0, budget: 0, collision: 0, offscreen: 0 };
    for (let seed = 1; seed <= 200; seed++) {
      const c = randomCase(seed);
      const r = layoutLabels(c.candidates, c.obstacles, c.viewport, c.budget);
      totals.placed += r.placed.length;
      for (const d of r.dropped) totals[d.reason]++;
    }
    expect(totals.placed).toBeGreaterThan(400);
    expect(totals.budget).toBeGreaterThan(50);
    expect(totals.collision).toBeGreaterThan(50);
    expect(totals.offscreen).toBeGreaterThan(50);
  });

  it("hitsCandles совпадает с перебором", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const c = randomCase(seed);
      const rnd = mulberry32(seed + 1000);
      for (let k = 0; k < 200; k++) {
        const r = { x: rnd() * c.viewport.width - 20, y: rnd() * c.viewport.height, w: 5 + rnd() * 90, h: 5 + rnd() * 30 };
        expect(hitsCandles(r, c.obstacles.candles)).toBe(hitsCandlesBrute(r, c.obstacles.candles));
      }
    }
    expect(hitsCandles({ x: 0, y: 0, w: 10, h: 10 }, { x0: 0, spacing: 0, halfWidth: 1, top: new Float32Array(1), bottom: new Float32Array(1) })).toBe(false);
  });

  it("время: 40 кандидатов × 4 места — медиана меньше 2 мс (цель 0.5 мс)", () => {
    const c = randomCase(4242, 40);
    for (const cand of c.candidates) while ((cand.slots as unknown[]).length < 4) (cand.slots as unknown[]).push({ ...cand.slots[0]!, y: cand.slots[0]!.y + 20 });
    const times: number[] = [];
    for (let i = 0; i < 201; i++) {
      const t0 = performance.now();
      layoutLabels(c.candidates, c.obstacles, c.viewport, c.budget);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    expect(times[100]!).toBeLessThan(2);
  });
});

describe("layoutLabels: правила", () => {
  const vp: Viewport = { width: 400, height: 300, insetTop: 32, volumeTopY: 258, free: { x0: 296, x1: 400 }, gutter: null };
  const noCandles: CandleBand = { x0: 0, spacing: 8, halfWidth: 4, top: new Float32Array(0), bottom: new Float32Array(0) };
  const budget: LabelBudget = { canvas: 2, perLayer: { sr: 1 } };
  const cand = (id: string, p: Partial<LabelCandidate> = {}): LabelCandidate => ({
    id: `${id}#label`,
    objectId: id,
    layer: "zones",
    text: id,
    font: "sans",
    px: 11,
    w: 60,
    h: 17,
    priority: 50,
    tone: "up",
    slots: [{ key: "free-above", x: 336, y: 100, clampX: false }],
    bypassBudget: false,
    ...p,
  });

  it("занятое место — следующее по порядку; нет мест — collision", () => {
    const a = cand("a", { priority: 80 });
    const b = cand("b", { slots: [{ key: "free-above", x: 336, y: 100, clampX: false }, { key: "free-below", x: 336, y: 130, clampX: false }] });
    const c = cand("c", { priority: 40 });
    const r = layoutLabels([c, b, a], { candles: noCandles, rects: [] }, vp, { canvas: 9, perLayer: {} });
    expect(r.placed.map((p) => `${p.objectId}:${p.slot}`)).toEqual(["a:free-above", "b:free-below"]);
    expect(r.dropped).toEqual([{ id: "c#label", reason: "collision" }]);
  });

  it("вне области — offscreen; clampX прижимает зону к краю (M09)", () => {
    const off = cand("off", { slots: [{ key: "line-end-above", x: -500, y: 100, clampX: false }] });
    const low = cand("low", { slots: [{ key: "free-below", x: 336, y: 250, clampX: false }] });
    const zone = cand("zone", { slots: [{ key: "box-top-left", x: -1186, y: 60, clampX: true }] });
    const r = layoutLabels([off, low, zone], { candles: noCandles, rects: [] }, vp, { canvas: 9, perLayer: {} });
    expect(r.dropped).toEqual([
      { id: "low#label", reason: "offscreen" },
      { id: "off#label", reason: "offscreen" },
    ]);
    expect(r.placed[0]!.rect.x).toBe(2);
  });

  it("бюджет: всего и по слою; выбранный и наведённый — сверх", () => {
    const s1 = cand("s1", { layer: "sr", priority: 80, slots: [{ key: "free-above", x: 336, y: 40, clampX: false }] });
    const s2 = cand("s2", { layer: "sr", priority: 70, slots: [{ key: "free-above", x: 336, y: 70, clampX: false }] });
    const z1 = cand("z1", { priority: 60, slots: [{ key: "free-above", x: 336, y: 100, clampX: false }] });
    const z2 = cand("z2", { priority: 50, slots: [{ key: "free-above", x: 336, y: 130, clampX: false }] });
    const sel = cand("sel", { priority: 95, bypassBudget: true, slots: [{ key: "free-above", x: 336, y: 160, clampX: false }] });
    const r = layoutLabels([s1, s2, z1, z2, sel], { candles: noCandles, rects: [] }, vp, budget);
    expect(r.placed.map((p) => p.objectId).sort()).toEqual(["s1", "sel", "z1"]);
    expect(r.dropped).toEqual([
      { id: "s2#label", reason: "budget" },
      { id: "z2#label", reason: "budget" },
    ]);
  });

  it("свеча и полоса цены — препятствия", () => {
    const band: CandleBand = { x0: 340, spacing: 8, halfWidth: 4, top: new Float32Array([90]), bottom: new Float32Array([130]) };
    const r1 = layoutLabels([cand("a")], { candles: band, rects: [] }, vp, budget);
    expect(r1.dropped[0]!.reason).toBe("collision");
    const r2 = layoutLabels([cand("a")], { candles: noCandles, rects: [{ rect: { x: 296, y: 110, w: 104, h: 18 }, kind: "lastPrice" }] }, vp, budget);
    expect(r2.dropped[0]!.reason).toBe("collision");
  });

  it("порядок: приоритет, слой, id", () => {
    const xs = [cand("b", { layer: "zones" }), cand("a", { layer: "zones" }), cand("c", { layer: "alerts" }), cand("d", { priority: 90, layer: "patterns" })];
    expect([...xs].sort(compareCandidates).map((x) => x.objectId)).toEqual(["d", "c", "a", "b"]);
  });
});
