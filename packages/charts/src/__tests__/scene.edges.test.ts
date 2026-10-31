import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, resolvePreset, type MarkupSettings } from "../presets";
import { priceFormatter } from "../priceFormat";
import { buildScene, sceneHover } from "../scene/build";
import { deriveAnalytics, identity, NO_SELECTION, type ExternalObject, type SceneInput } from "../scene/input";
import { pickEvents } from "../scene/layers/structure";
import { mergeTops } from "../scene/layers/liq";
import { volumeProfile } from "../scene/layers/profile";
import { RU_TEXT } from "../scene/text";
import type { Scene } from "../scene/types";
import type { SceneFigure, ScenePattern, SceneSignal, SceneStructure } from "../scene/wire";
import { mergeZones } from "../scene/zones";
import { LAYER_KEYS, type Candle } from "../types";

/** Пограничные случаи построителей на синтетических данных: 4h, цена около 100. */
const H = 14400;
const T0 = 1_790_000_000 - (1_790_000_000 % H);
const candles: Candle[] = Array.from({ length: 80 }, (_, i) => {
  const mid = 100 + 6 * Math.sin(i / 4);
  return { time: T0 + i * H, open: mid - 0.5, high: mid + 1.5, low: mid - 1.5, close: mid + 0.5, volume: 10 + (i % 7), open_: false };
});
const last = candles[candles.length - 1]!;
const ref = last.close;

const z = (kind: string, dir: string, bottom: number, top: number, from_t = T0) => ({ kind, dir, top: String(top), bottom: String(bottom), from_t, status: "active" });
const structure: SceneStructure = {
  events: [
    { t: T0 + 10 * H, type: "bos", dir: "up", level: "101", from_t: T0 + 5 * H },
    { t: T0 + 10 * H, type: "bos", dir: "up", level: "101.5", from_t: T0 + 6 * H },
    { t: T0 + 20 * H, type: "choch", dir: "down", level: "98", from_t: T0 + 20 * H },
  ],
  zones: [z("ob", "up", 90, 92), z("fvg", "down", 91.5, 93), z("sd", "down", 110, 112), z("ob", "up", 111, 113), z("sd", "up", 80, 81)],
  levels: { pdh: "106", pdl: null, pwh: "x", pwl: "94" },
  equal_levels: [
    { kind: "high", p: String(ref + 2), from_t: T0 + 30 * H, to_t: null, swept: false },
    { kind: "low", p: String(ref - 2), from_t: T0 + 31 * H, to_t: T0 + 31 * H, swept: false },
    { kind: "low", p: String(ref - 1), from_t: T0 + 31 * H, to_t: T0 + 40 * H, swept: true },
  ],
  sweeps: [
    { t: T0 + 50 * H, kind: "high", level: "107" },
    { t: T0 + 50 * H, kind: "low", level: "93" },
  ],
  atr: "3",
};
const fig = (id: number, status: SceneFigure["status"], p: Partial<SceneFigure> = {}): SceneFigure => ({
  id,
  type: "double_top",
  title: "Двойная вершина",
  status,
  known_t: T0 + 60 * H,
  confirm_t: status === "confirmed" ? T0 + 62 * H : null,
  end_t: T0 + 60 * H,
  points: [
    [T0 + 40 * H, "105"],
    [T0 + 50 * H, "nan"],
  ],
  lines: [
    { name: "neck", a: [T0 + 40 * H, "100"], b: [T0 + 200 * H, "104"] },
    { name: "bad", a: [T0 + 40 * H, "x"], b: [T0 + 50 * H, "1"] },
    { name: "future", a: [T0 + 300 * H, "1"], b: [T0 + 310 * H, "1"] },
  ],
  target: "110",
  invalidation: "95",
  ...p,
});
const figures = [fig(1, "confirmed"), fig(2, "forming"), fig(3, "invalidated"), fig(4, "confirmed", { target: null, invalidation: null, confirm_t: null })];
const patterns: ScenePattern[] = [
  { id: 1, type: "doji", title: "Доджи", direction: null, significant: true, t: T0 + 70 * H, price: null },
  { id: 2, type: "engulfing", title: "x", direction: "down", significant: true, t: T0 + 71 * H, price: "101" },
  { id: 3, type: "engulfing", title: "x", direction: "up", significant: false, t: T0 + 72 * H, price: "99" },
];
const signals: SceneSignal[] = [
  { id: "a", dir: "short", t: T0 + 75 * H, status: "open", grade: "B", entry: null, sl: "105", tp: [null, "95"] },
  ...Array.from({ length: 22 }, (_, i) => ({ id: `n${i}`, dir: "long" as const, t: T0 + 10 * H, status: "expired", grade: "C", entry: "100", sl: null, tp: [] })),
];

function input(p: Partial<SceneInput> = {}, cs: Candle[] = candles): SceneInput {
  return {
    tf: "4h",
    analytics: deriveAnalytics(cs, null, p.structure === undefined ? structure : p.structure),
    structure,
    patterns,
    figures,
    signals,
    alerts: [],
    external: [],
    selection: NO_SELECTION,
    fmt: priceFormatter("0.01", false),
    text: RU_TEXT,
    ...p,
  };
}
const all: MarkupSettings = { preset: "clean", overrides: Object.fromEntries(LAYER_KEYS.map((k) => [k, true])) };
const build = (p: Partial<SceneInput> = {}, markup: MarkupSettings = all, cs?: Candle[]): Scene => buildScene(input(p, cs), resolvePreset(markup, "desktop", { authed: true }));
const ids = (s: Scene, layer: string) => s.objects.filter((o) => o.layer === layer).map((o) => o.id);

describe("построители слоёв: пограничные случаи", () => {
  it("без структуры: нет зон, структуры и уровней; ATR нет", () => {
    const s = build({ structure: null });
    for (const layer of ["zones", "structure", "levels"]) expect(ids(s, layer)).toEqual([]);
    expect(deriveAnalytics(candles, null, null).atr).toBeNull();
    expect(deriveAnalytics(candles, null, { ...structure, atr: null }).atr).toBeNull();
    expect(deriveAnalytics(candles, null, { ...structure, atr: "-1" }).atr).toBeNull();
    expect(identity(null)).toBe(0);
  });

  it("структура: одинаковые id получают суффикс; равные уровни обеих сторон; снятия над и под", () => {
    const s = build({}, { preset: "detailed", overrides: {} });
    expect(ids(s, "structure")).toEqual(["bos:" + (T0 + 10 * H), "bos:" + (T0 + 10 * H) + ":2", "choch:" + (T0 + 20 * H), "sweep:" + (T0 + 50 * H), "sweep:" + (T0 + 50 * H) + ":2", "eq:H:" + (T0 + 30 * H), "eq:L:" + (T0 + 31 * H)]);
    const eqh = s.byId.get("eq:H:" + (T0 + 30 * H))!;
    const eql = s.byId.get("eq:L:" + (T0 + 31 * H))!;
    expect(eqh).toMatchObject({ to: null, label: { text: "Равные макс." } });
    expect(eql).toMatchObject({ to: T0 + 32 * H, label: { text: "Равные мин." } });
    const choch = s.byId.get("choch:" + (T0 + 20 * H))!;
    expect(choch).toMatchObject({ from: T0 + 20 * H, to: T0 + 21 * H });
    expect(choch.label?.slots[0]).toBe("break-above");
    expect(s.byId.get("sweep:" + (T0 + 50 * H) + ":2")).toMatchObject({ side: "below", hover: { title: "Снятие ликвидности под минимумом" } });
    expect(pickEvents(structure.events, 1, false).map((e) => e.type)).toEqual(["choch"]);
  });

  it("зоны: смешанная группа, ближайший спрос и предложение, виды по направлению частей", () => {
    const groups = mergeZones(structure.zones, ref);
    expect(groups.map((g) => g.dir)).toEqual(["mixed", "mixed", "up"].slice(0, groups.length));
    const s = build({}, { preset: "levels", overrides: {} });
    const zs = s.objects.filter((o) => o.layer === "zones");
    expect(zs).toHaveLength(2);
    expect(zs.every((o) => o.tone === "muted" && o.label?.text === "Зона")).toBe(true);
    expect(zs.map((o) => o.hover.subtitle)).toEqual(expect.arrayContaining(["ордер-блок покупок + разрыв цены вниз"]));
    expect(s.index.levels.filter((r) => r.layer === "zones").map((r) => r.kind)).toEqual(["zone", "zone"]);
    // ниже цены — спрос, выше — предложение, у каждой своя первая подпись 70
    expect(zs.map((o) => o.label?.priority)).toEqual([70, 70]);
    const far = s.index.levels.find((r) => r.layer === "zones" && r.price < 85);
    expect(far).toBeUndefined();
  });

  it("уровни: пустые и нечисловые пропускаются, выбранный — даже вне levelKeys", () => {
    const s = build({}, { preset: "levels", overrides: {} });
    expect(ids(s, "levels")).toEqual(["lvl:pdh", "lvl:pwl"]);
    const r = resolvePreset({ preset: "levels", overrides: {} }, "desktop", { authed: true });
    const only = buildScene(input(), { ...r, limits: { ...DEFAULT_LIMITS, levelKeys: ["pdh"] } });
    expect(ids(only, "levels")).toEqual(["lvl:pdh"]);
    const sel = buildScene(input({ selection: { selected: "lvl:pwl", hidden: new Set() } }), { ...r, limits: { ...DEFAULT_LIMITS, levelKeys: ["pdh"] } });
    expect(ids(sel, "levels")).toEqual(["lvl:pdh", "lvl:pwl"]);
    expect(build({ structure: null }, { preset: "levels", overrides: {} }).index.levels.some((x) => x.layer === "levels")).toBe(false);
  });

  it("фигуры: обрезка по последней свече, кривые точки пропускаются, статусы словами", () => {
    const s = build({ selection: { selected: "fig:2", hidden: new Set() } }, { preset: "detailed", overrides: {} });
    const f1 = s.byId.get("fig:1")!;
    expect(f1.kind).toBe("polyline");
    if (f1.kind === "polyline") {
      expect(f1.paths).toHaveLength(1);
      expect(f1.paths[0]![1]![0]).toBe(last.time);
      expect(f1.style).toBe("dashed");
    }
    expect(ids(s, "figures")).toEqual(["fig:1", "fig:1:tgt", "fig:1:inv", "fig:2"]);
    const f2 = s.byId.get("fig:2")!;
    expect(f2).toMatchObject({ style: "solid", tone: "selection", hover: { subtitle: "формируется" } });
    if (f2.kind === "polyline") expect(f2.dots).toEqual([[T0 + 40 * H, 105]]);
    const s3 = build({ selection: { selected: "fig:3", hidden: new Set() } });
    expect(s3.byId.get("fig:3")).toMatchObject({ hover: { subtitle: "отменена" } });
    expect(s3.byId.get("fig:1:inv")?.label?.slots[0]).toBe("free-below");
    // без линий в пределах свечей — только цель и слом
    const s4 = build({ figures: [fig(9, "confirmed", { lines: [] })] });
    expect(ids(s4, "figures")).toEqual(["fig:9:tgt", "fig:9:inv"]);
    const s5 = build({ figures: [fig(4, "confirmed", { target: null, invalidation: null, confirm_t: null, known_t: T0 }), fig(5, "confirmed", { confirm_t: null, known_t: T0 + 2 * H })] });
    expect(ids(s5, "figures")).toEqual(["fig:5"]);
  });

  it("паттерны: без цены, без направления — ромб, вниз — над свечой; незначимые не рисуются", () => {
    const s = build();
    expect(ids(s, "patterns")).toEqual(["pat:1", "pat:2"]);
    expect(s.byId.get("pat:1")).toMatchObject({ shape: "diamond", side: "above", price: null, tone: "muted", label: { text: "доджи", slots: ["glyph-above", "glyph-below"] } });
    expect(s.byId.get("pat:2")).toMatchObject({ shape: "triangle-down", side: "above", price: 101 });
    const r = resolvePreset(all, "desktop", { authed: true });
    const loose = buildScene(input(), { ...r, limits: { ...r.limits, patternsSignificantOnly: false } });
    expect(loose.byId.get("pat:3")).toMatchObject({ shape: "triangle-up", side: "below", label: { slots: ["glyph-below", "glyph-above"] } });
  });

  it("сигналы: шорт без входа, пустые цели пропускаются, не больше 20, выбранный — сверх", () => {
    const s = build();
    const sig = ids(s, "signals");
    expect(sig.slice(0, 3)).toEqual(["sig:a", "sig:a:stop", "sig:a:tp2"]);
    expect(sig.filter((x) => x.startsWith("sig:n"))).toHaveLength(19);
    expect(s.byId.get("sig:a")).toMatchObject({ shape: "triangle-down", side: "above", price: null, hover: { title: "Сигнал B, шорт" } });
    expect(s.byId.get("sig:a:stop")?.hover.subtitle).toBe("сигнал B, шорт");
    const s2 = build({ selection: { selected: "sig:n21", hidden: new Set() } });
    expect(s2.byId.get("sig:n21")?.emphasis).toBe("selected");
    expect(s2.byId.get("sig:n21")?.label).toBeUndefined();
  });

  it("«Разбор»: начало зоны по умолчанию — последняя свеча, у линии — от времени", () => {
    const ext: ExternalObject[] = [
      { id: "l", owner: "topdown", sourceTf: "1d", kind: "hline", price: 120, from: T0 + 3 * H + 5, tone: "down", label: "Д1", hover: { title: "Д1" }, priority: 65 },
      { id: "b", owner: "topdown", sourceTf: "1d", kind: "box", top: 1, bottom: 2, tone: "up", label: "Д1 зона", hover: { title: "Д1 зона" }, priority: 65 },
      { id: "nan", owner: "topdown", sourceTf: "1d", kind: "hline", price: Number.NaN, tone: "up", label: "-", hover: { title: "-" }, priority: 65 },
    ];
    const s = build({ external: ext, selection: { selected: "ext:b", hidden: new Set() } });
    expect(s.byId.get("ext:l")).toMatchObject({ from: T0 + 3 * H, label: { slots: ["free-above", "free-below", "line-end-above", "line-end-below"] } });
    expect(s.byId.get("ext:b")).toMatchObject({ from: last.time, emphasis: "selected" });
    expect(s.byId.has("ext:nan")).toBe(false);
  });

  it("ликвидации: соседние корзины склеиваются, сумма общая", () => {
    const b = (price: number, long: number, short = 0) => ({ price, long, short });
    const buckets = [b(1, 0), b(2, 5), b(3, 4), b(4, 0), b(5, 3), b(6, 0, 7)];
    const m = { step: 1, buckets, max: 9, topLong: buckets[1]!, topShort: buckets[5]!, topLongs: [buckets[1]!, buckets[2]!, buckets[4]!], topShorts: [buckets[5]!] };
    expect(mergeTops(m, "long", 2)).toEqual([
      { bucket: 1, price: 2, amount: 9 },
      { bucket: 4, price: 5, amount: 3 },
    ]);
    expect(mergeTops(m, "short", 0)).toEqual([]);
    expect(mergeTops({ ...m, topShorts: [b(99, 0, 1)] }, "short", 2)).toEqual([]);
  });

  it("профиль объёма: пустой и плоский вход, зона стоимости расширяется в обе стороны", () => {
    expect(volumeProfile([], 24, 0.7)).toEqual([]);
    expect(volumeProfile([{ time: 0, high: 1, low: 1, volume: 5 }], 24, 0.7)).toEqual([]);
    expect(volumeProfile([{ time: 0, high: 2, low: 1, volume: 5 }], 0, 0.7)).toEqual([]);
    const rows = volumeProfile(
      [
        { time: 0, high: 10, low: 0, volume: 10 },
        { time: 1, high: 6, low: 4, volume: 50 },
        { time: 2, high: 3, low: 0, volume: 30 },
      ],
      10,
      0.9,
    );
    expect(rows.filter((r) => r.poc)).toHaveLength(1);
    const value = rows.filter((r) => r.value);
    expect(value.length).toBeGreaterThan(3);
    expect(value[0]!.bottom).toBe(0);
  });

  it("подсказка суммы ликвидаций и пустая сцена без последней закрытой свечи", () => {
    const open: Candle[] = candles.map((c) => ({ ...c, open_: true }));
    const s = build({}, all, open);
    expect(s.objects).toHaveLength(0);
    expect(deriveAnalytics(open, [], structure).liqUnavailable).toBe(false);
    expect(deriveAnalytics(candles, [], structure).liqUnavailable).toBe(true);
    expect(deriveAnalytics(candles, [], structure).key).toContain("|0:|");
    const fake = { ...s, byId: new Map([["liq:L:1", { kind: "heat", id: "liq:map", tops: [], hover: { title: "map" } } as never]]) } as Scene;
    expect(sceneHover(fake, "liq:L:1")?.title).toBe("map");
  });
});
