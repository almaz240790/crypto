import { afterEach, describe, expect, it, vi } from "vitest";
import { fibExtended, fibHue, fibMulticolor } from "../drawings/fib";
import { fibLevels, hitTest, type Projector } from "../drawings/geometry";
import { DRAWING_TEXT, drawingLabels, fibLevelColor, toCandidate } from "../drawings/labels";
import { DrawingsPrimitive } from "../drawings/primitive";
import { FIB_EXTEND_ALPHA, FIB_FILL_ALPHA, FIB_LABEL_EDGE_PX, FIB_LEVELS, FIB_MINOR_ALPHA, FIB_PLAQUE_ALPHA, FIB_PRESET_LEVELS, type Drawing } from "../drawings/types";
import { layoutLabels } from "../layout/labels";
import type { Viewport } from "../layout/types";
import { alpha, tokensFromElement } from "../theme";
import type { ThemeTokens } from "../types";
import { bars, H, makeEnv, T0, TOKENS } from "./fakes/lwc";

/**
 * Фибоначчи на старшем таймфрейме (жалоба владельца «Фибоначчи говно», BTCUSDT 1Н; ADR-0009, «Рисование», дополнение
 * 2026-11-13): уровни продлены до правого края панели (за B — бледнее), подписи — столбцом у шкалы цены на
 * полупрозрачной плашке, выбор — только по A–B; разноцветные уровни (палитра --fib-*) и заливка полос между ними в
 * пределах A–B; переключатель «Линии до края» (style.extend) возвращает прежний вид.
 */

const fib = (o: { levels?: number[]; points?: Drawing["points"]; style?: Partial<Drawing["style"]> } = {}): Drawing => ({
  id: "F",
  type: "fib",
  points: o.points ?? [{ time: T0 + 10 * H, price: 120 }, { time: T0 + 40 * H, price: 80 }],
  style: { color: "text2", width: 1, dashed: false, ...o.style },
  locked: false,
  timeframe: null,
  updated_at: 0,
  ...(o.levels ? { levels: o.levels } : {}),
});

/** Светлая тема: та же раскладка палитры, другие значения. */
const LIGHT: ThemeTokens = { ...TOKENS, surface: "#ffffff", text2: "#4a524f", up: "#0a7f55", down: "#c8283a", fib: ["#bd3049", "#a65108", "#7f6400", "#3a7520", "#0c6d87", "#3157c9", "#7444c4", "#a8328f"] };

/** Ожидаемый оттенок уровня (номер в палитре --fib-1…--fib-8; null — нейтральный --text-2). */
const HUE: Record<string, number | null> = { "-1": 7, "-0.618": 5, "-0.272": 6, "0": null, "0.236": 0, "0.382": 1, "0.5": 2, "0.618": 4, "0.705": 3, "0.786": 5, "1": null, "1.272": 6, "1.618": 5, "2.618": 0 };

describe("цвет уровня: разноцветный по умолчанию, одноцветный — выбранным цветом", () => {
  it("0 и 1 нейтральные, остальные — свой оттенок палитры; соседние уровни различаются (тёмная и светлая тема)", () => {
    expect(Object.keys(HUE).map(Number).sort((a, b) => a - b)).toEqual([...FIB_PRESET_LEVELS]);
    for (const tokens of [TOKENS, LIGHT]) {
      const colors = FIB_PRESET_LEVELS.map((l) => fibLevelColor(tokens, fib(), l));
      FIB_PRESET_LEVELS.forEach((l, i) => {
        const hue = HUE[String(l)]!;
        expect(fibHue(l), String(l)).toBe(hue);
        expect(colors[i], String(l)).toBe(hue === null ? tokens.text2 : tokens.fib[hue]);
      });
      for (let i = 1; i < colors.length; i++) expect(colors[i], `${FIB_PRESET_LEVELS[i - 1]} и ${FIB_PRESET_LEVELS[i]}`).not.toBe(colors[i - 1]);
      // ключевые 0.5 и 0.618 — не цвета роста и падения (не похожи на сигнал) и не салатовый выбора
      for (const key of [0.5, 0.618]) expect([tokens.up, tokens.down, tokens.accent]).not.toContain(fibLevelColor(tokens, fib(), key));
    }
  });

  it("уровень вне палитры (с другого клиента) — нейтральный; прежний цвет по умолчанию (accent) — тоже разноцветный", () => {
    expect(fibHue(0.33)).toBeNull();
    expect(fibLevelColor(TOKENS, fib(), 0.33)).toBe(TOKENS.text2);
    expect(fibMulticolor(fib())).toBe(true);
    expect(fibMulticolor(fib({ style: { color: "accent" } }))).toBe(true);
    expect(fibLevelColor(TOKENS, fib({ style: { color: "accent" } }), 0.618)).toBe(TOKENS.fib[4]);
  });

  it("цвет, выбранный пользователем (не text2 и не accent), — у всех уровней один", () => {
    for (const color of ["up", "down", "warn", "text3"] as const) {
      const d = fib({ style: { color } });
      expect(fibMulticolor(d)).toBe(false);
      const want = { up: TOKENS.up, down: TOKENS.down, warn: TOKENS.warn, text3: TOKENS.text3 }[color];
      for (const l of FIB_PRESET_LEVELS) expect(fibLevelColor(TOKENS, d, l)).toBe(want);
    }
  });

  describe("палитра из CSS (tokensFromElement)", () => {
    afterEach(() => vi.unstubAllGlobals());
    it("--fib-1…--fib-8; нет переменной — запасной цвет, а не пустая строка", () => {
      const vars: Record<string, string> = Object.fromEntries(LIGHT.fib.map((c, i) => [`--fib-${i + 1}`, c]));
      vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: (n: string) => vars[n] ?? "" }));
      expect(tokensFromElement({} as HTMLElement).fib).toEqual(LIGHT.fib);
      delete vars["--fib-3"];
      const t = tokensFromElement({} as HTMLElement);
      expect(t.fib).toHaveLength(8);
      expect(t.fib[2]).toMatch(/^#[0-9a-f]{6}$/i);
    });
  });
});

describe("линии до края: поле style.extend", () => {
  it("рисунок без поля (сохранённый раньше, с сервера) — продлён; extend: false — как раньше, от A до B", () => {
    expect(fibExtended(fib())).toBe(true);
    expect(fibExtended(fib({ style: { extend: true } }))).toBe(true);
    expect(fibExtended(fib({ style: { extend: false } }))).toBe(false);
    // style без поля, как в localStorage и в ответе /v1/drawings до 11.2026
    expect(fibExtended({ style: JSON.parse('{"color":"text2","width":1,"dashed":false}') as Drawing["style"] })).toBe(true);
  });
});

type Stroke = { style: string; alpha: number; width: number; dash: number[]; x0: number; x1: number; y: number };
type Fill = { style: string; alpha: number; x: number; y: number; w: number; h: number };
type Text = { text: string; fill: string; font: string; x: number; y: number };

/** Холст-подделка: линии (с прозрачностью и пунктиром), заливки (с globalAlpha) и тексты. */
function canvas() {
  const strokes: Stroke[] = [];
  const fills: Fill[] = [];
  const texts: Text[] = [];
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
    stroke: () => strokes.push({ style: st.strokeStyle, alpha: st.globalAlpha, width: st.lineWidth, dash: [...dash], x0: path[0]?.x ?? NaN, x1: path[1]?.x ?? NaN, y: path[0]?.y ?? NaN }),
    fillText: (text: string, x: number, y: number) => texts.push({ text, fill: st.fillStyle, font: st.font, x, y }),
    fillRect: (x: number, y: number, w: number, h: number) => fills.push({ style: st.fillStyle, alpha: st.globalAlpha, x, y, w, h }),
    strokeRect: () => undefined,
    measureText: (t: string) => ({ width: t.length * 6 }),
    arc: () => undefined,
    rect: () => undefined,
    fill: () => undefined,
    closePath: () => undefined,
  });
  return { ctx, strokes, fills, texts };
}

const PANE_W = 800;
/** Шкала подделки: 0…110 логических на 800 px; цены 150…70 на 400 px. */
const spacing = PANE_W / 110;
const xAt = (logical: number) => logical * spacing + spacing / 2;

function render(drawings: Drawing[], tokens: ThemeTokens = TOKENS) {
  const candles = bars(60);
  const env = makeEnv(() => candles, { top: 150, bottom: 70 });
  const prim = new DrawingsPrimitive(tokens);
  prim.attached({ chart: env.chart, series: env.series, requestUpdate: () => undefined } as never);
  prim.projector!.setBars(candles.map((c) => c.time), H);
  prim.update({ drawings });
  const c = canvas();
  prim.paneViews()[0]!.renderer()!.draw({ useMediaCoordinateSpace: (cb: (s: unknown) => void) => cb({ context: c.ctx, mediaSize: { width: PANE_W, height: 400 } }) } as never);
  return { ...c, y: (price: number) => env.series.priceToCoordinate(price) };
}

/** Линии уровней (горизонтальные обводки) по y. */
const levelStrokes = (c: ReturnType<typeof render>, price: number) => c.strokes.filter((s) => Math.abs(s.y - c.y(price)) < 1e-6);
const priceOf = (d: Drawing, level: number) => fibLevels(d.points[0]!, d.points[1]!, [level])[0]!.price;

describe("отрисовка продлённого Фибоначчи", () => {
  it("каждый уровень — от левой точки до правого края панели; за B — та же линия бледнее (×0.55), цвет уровня", () => {
    const d = fib();
    const c = render([d]);
    const left = xAt(10), right = xAt(40);
    for (const level of FIB_LEVELS) {
      const ss = levelStrokes(c, priceOf(d, level));
      expect(ss, String(level)).toHaveLength(2);
      const [inner, outer] = [...ss].sort((a, b) => a.x0 - b.x0) as [Stroke, Stroke];
      const key = level === 0.5 || level === 0.618;
      const solid = key || level === 0 || level === 1;
      const a0 = solid ? 1 : FIB_MINOR_ALPHA;
      const color = fibLevelColor(TOKENS, d, level);
      // внутри A–B — как раньше: 0 и 1 сплошные, 0.5 и 0.618 сплошные и толще, остальные — пунктир полупрозрачный
      expect(inner).toMatchObject({ style: color, alpha: a0, width: key ? 1.5 : 1, dash: solid ? [] : [4, 3] });
      expect(inner.x0).toBeCloseTo(left, 6);
      expect(inner.x1).toBeCloseTo(right, 6);
      // за B — до края панели (не в шкалу цены), бледнее: размах A–B выделяется
      expect(outer).toMatchObject({ style: color, width: inner.width, dash: inner.dash });
      expect(outer.alpha).toBeCloseTo(a0 * FIB_EXTEND_ALPHA, 9);
      expect(outer.x0).toBeCloseTo(right, 6);
      expect(outer.x1).toBe(PANE_W);
    }
    // 0 и 1 — нейтральные, 0.618 — свой цвет
    expect(levelStrokes(c, 80)[0]!.style).toBe(TOKENS.text2);
    expect(levelStrokes(c, 120)[0]!.style).toBe(TOKENS.text2);
    expect(levelStrokes(c, priceOf(d, 0.618))[0]!.style).toBe(TOKENS.fib[4]);
  });

  it("Фибоначчи левее экрана (график ушёл вперёд) — линии от левого края панели до правого; B за правым краем — без продления", () => {
    const past = fib({ points: [{ time: T0 - 30 * H, price: 120 }, { time: T0 - 10 * H, price: 80 }] });
    const c = render([past]);
    for (const level of FIB_LEVELS) {
      const outer = levelStrokes(c, priceOf(past, level)).find((s) => s.x1 === PANE_W)!;
      expect(outer, String(level)).toBeDefined();
      expect(outer.x0, String(level)).toBe(0);
    }
    const ahead = fib({ points: [{ time: T0 + 60 * H, price: 120 }, { time: T0 + 120 * H, price: 80 }] });
    const c2 = render([ahead]);
    for (const level of FIB_LEVELS) {
      const ss = levelStrokes(c2, priceOf(ahead, level));
      expect(ss, String(level)).toHaveLength(1);
      expect(ss[0]!.x0).toBeCloseTo(xAt(60), 6);
      expect(ss[0]!.x1).toBeGreaterThan(PANE_W);
    }
  });

  it("extend: false — одна линия уровня от A до B, как раньше", () => {
    const d = fib({ style: { extend: false } });
    const c = render([d]);
    for (const level of FIB_LEVELS) {
      const ss = levelStrokes(c, priceOf(d, level));
      expect(ss, String(level)).toHaveLength(1);
      expect(ss[0]!.x0).toBeCloseTo(xAt(10), 6);
      expect(ss[0]!.x1).toBeCloseTo(xAt(40), 6);
    }
  });

  it("заливка полос между соседними уровнями — только в пределах A–B, цветом уровня дальше от 0; за B — только линии", () => {
    const d = fib();
    const c = render([d]);
    const left = xAt(10), right = xAt(40);
    const bands = c.fills.filter((f) => f.alpha === FIB_FILL_ALPHA);
    expect(bands).toHaveLength(FIB_LEVELS.length - 1);
    for (let i = 1; i < FIB_LEVELS.length; i++) {
      const lo = FIB_LEVELS[i - 1]!, hi = FIB_LEVELS[i]!;
      const y0 = c.y(priceOf(d, lo)), y1 = c.y(priceOf(d, hi));
      const band = bands.find((f) => Math.abs(f.y - Math.min(y0, y1)) < 1e-6 && Math.abs(f.h - Math.abs(y1 - y0)) < 1e-6);
      expect(band, `${lo}…${hi}`).toBeDefined();
      expect(band!.x).toBeCloseTo(left, 6);
      expect(band!.x + band!.w).toBeCloseTo(right, 6);
      expect(band!.style, `${lo}…${hi}`).toBe(fibLevelColor(TOKENS, d, hi));
    }
    // ни одна заливка рисунка не выходит правее B
    for (const f of c.fills.filter((f) => f.alpha < 0.5)) expect(f.x + f.w).toBeLessThanOrEqual(right + 1e-6);
  });

  it("одноцветный (цвет выбран) — линии и подписи одним цветом, без заливки; светлая тема — свои оттенки", () => {
    const single = render([fib({ style: { color: "warn" } })]);
    expect(new Set(single.strokes.map((s) => s.style))).toEqual(new Set([TOKENS.warn]));
    expect(single.fills.filter((f) => f.alpha === FIB_FILL_ALPHA)).toHaveLength(0);
    const light = render([fib()], LIGHT);
    const d = fib();
    expect(levelStrokes(light, priceOf(d, 0.5))[0]!.style).toBe(LIGHT.fib[2]);
    expect(levelStrokes(light, priceOf(d, 0))[0]!.style).toBe(LIGHT.text2);
  });

  it("подписи — текстом цвета уровня на полупрозрачной нейтральной плашке (свечи под ней видны); ключевые — полужирные", () => {
    const d = fib();
    const c = render([d]);
    const labels = c.texts.filter((t) => / · /.test(t.text));
    expect(labels.length).toBeGreaterThanOrEqual(6);
    for (const t of labels) {
      const level = Number(t.text.split(" · ")[0]);
      expect(t.fill, t.text).toBe(fibLevelColor(TOKENS, d, level));
      expect(/^600 /.test(t.font), t.text).toBe(level === 0.5 || level === 0.618);
    }
    const plaques = c.fills.filter((f) => f.style === alpha(TOKENS.surface, FIB_PLAQUE_ALPHA));
    expect(plaques).toHaveLength(labels.length);
    expect(FIB_PLAQUE_ALPHA).toBeGreaterThanOrEqual(0.6);
    expect(FIB_PLAQUE_ALPHA).toBeLessThanOrEqual(0.7);
    expect(c.fills.some((f) => f.style === alpha(TOKENS.surface, 0.85))).toBe(false);
  });
});

/** Панель 1000 × 800: 10 px на свечу от T0, 4 px на единицу цены от 200 вниз. */
const PROJ: Projector = { x: (t) => ((t - T0) / H) * 10, y: (p) => (200 - p) * 4, width: 1000, height: 800 };
const measure = (t: string, _f: "mono" | "sans", px: number) => t.length * px * 0.6;
const VP: Viewport = { width: 1000, height: 800, insetTop: 0, volumeTopY: 800, free: null, gutter: null };
const NO_CANDLES = { x0: 0, spacing: 0, halfWidth: 0, top: new Float32Array(0), bottom: new Float32Array(0) };
const labelsOf = (ds: Drawing[], proj: Projector = PROJ) => drawingLabels({ drawings: ds, draft: null, selectedId: null, proj, tokens: TOKENS, precision: 2, profile: null, text: DRAWING_TEXT, measure });
const place = (ds: Drawing[], rects: { rect: { x: number; y: number; w: number; h: number }; kind: "lastPrice" }[] = []) => {
  const labels = labelsOf(ds);
  const res = layoutLabels(labels.map(toCandidate), { candles: NO_CANDLES, rects }, VP, { canvas: 0, perLayer: {} });
  return { labels, placed: new Map((res.external ?? []).map((p) => [p.id, p.rect])) };
};
/** Ход 100 → 120 на свечах 20…60: x 200…600, y уровней — 4 px на единицу цены. */
const SWING = [{ time: T0 + 20 * H, price: 100 }, { time: T0 + 60 * H, price: 120 }];
const yOf = (level: number) => (200 - (120 - 20 * level)) * 4;
/** Подпись у своей линии: над ней (низ на 3 px выше) или под ней (верх на 3 px ниже). */
const atLine = (r: { y: number; h: number }, y: number) => Math.min(Math.abs(r.y + r.h + 3 - y), Math.abs(r.y - 3 - y)) < 1e-6;

describe("подписи продлённого Фибоначчи — столбцом у шкалы цены", () => {
  it("первые места — у правого края панели (правый край плашки — край минус зазор), над линией и под ней; текст и цвет уровня", () => {
    const ls = labelsOf([fib({ points: SWING })]);
    expect(ls.map((l) => l.id)).toEqual(FIB_LEVELS.map((l) => `F#L${l}`));
    for (const l of ls) {
      const level = Number(l.id.slice(3));
      expect(l.style).toBe("fib");
      expect(l.color).toBe(fibLevelColor(TOKENS, fib(), level));
      expect(l.slots[0]!.x + l.w, l.id).toBeCloseTo(1000 - FIB_LABEL_EDGE_PX, 6);
      expect(l.slots[1]!.x, l.id).toBe(l.slots[0]!.x);
      expect(l.slots[0]!.y + l.h + 3).toBeCloseTo(yOf(level), 6);
      expect(l.slots[1]!.y - 3).toBeCloseTo(yOf(level), 6);
    }
  });

  it("раскладка: столбец выровнен по правому краю, у своих линий, не друг на друге; ключевые на месте, тесные второстепенные — без подписи", () => {
    const { placed } = place([fib({ points: SWING })]);
    for (const id of ["F#L0", "F#L0.5", "F#L0.618", "F#L1"]) expect(placed.has(id), id).toBe(true);
    const rects = [...placed.entries()];
    for (const [id, r] of rects) {
      expect(r.x + r.w, id).toBeCloseTo(1000 - FIB_LABEL_EDGE_PX, 6);
      expect(atLine(r, yOf(Number(id.slice(3)))), `${id} у своей линии: ${JSON.stringify(r)}`).toBe(true);
    }
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]![1], b = rects[j]![1];
        expect(a.y + a.h <= b.y || b.y + b.h <= a.y, `${rects[i]![0]} и ${rects[j]![0]}`).toBe(true);
      }
    // ход в 80 px: 0.705 и 0.786 — в 6.5 px друг от друга, рядом 0.618 — места всем не хватает, лишние не показаны
    expect(placed.size).toBeLessThan(FIB_LEVELS.length);
  });

  it("место в столбце занято полосой текущей цены — ключевой уровень у рисунка (на своей линии), второстепенный — без подписи", () => {
    // полоса цены поперёк столбца на уровне 0.5 (y 360) и 0.382 (y 350.6) — от свободной зоны до края панели
    const band = { rect: { x: 700, y: 345, w: 300, h: 30 }, kind: "lastPrice" as const };
    const { placed } = place([fib({ points: SWING })], [band]);
    const r = placed.get("F#L0.5")!;
    expect(r, "0.5 подписан").toBeDefined();
    expect(r.x + r.w).toBeLessThan(700);
    expect(atLine(r, yOf(0.5))).toBe(true);
    expect(placed.has("F#L0.382")).toBe(false);
  });

  it("Фибоначчи левее экрана: линии идут через панель — подписи в столбце у края; правее экрана — без подписей", () => {
    const past = fib({ points: [{ time: T0 - 60 * H, price: 100 }, { time: T0 - 20 * H, price: 120 }] });
    const { placed } = place([past]);
    expect(placed.has("F#L0.618")).toBe(true);
    for (const r of placed.values()) expect(r.x + r.w).toBeCloseTo(1000 - FIB_LABEL_EDGE_PX, 6);
    const ahead = fib({ points: [{ time: T0 + 120 * H, price: 100 }, { time: T0 + 160 * H, price: 120 }] });
    expect(labelsOf([ahead])).toEqual([]);
  });

  it("extend: false — прежние места (справа от B, внутри, слева); левее экрана — без подписей", () => {
    const ls = labelsOf([fib({ points: SWING, style: { extend: false } })]);
    for (const l of ls) expect(l.slots[0]!.x).toBe(602);
    expect(ls.every((l) => l.style === "fib")).toBe(true);
    expect(labelsOf([fib({ points: [{ time: T0 - 60 * H, price: 100 }, { time: T0 - 20 * H, price: 120 }], style: { extend: false } })])).toEqual([]);
  });
});

describe("выбор продлённого Фибоначчи — только по A–B и ручкам", () => {
  it("продолжение линии правее B не выбирает рисунок (там сдвиг графика); тело A–B, линия в пределах A–B и ручки — выбирают", () => {
    const d = fib({ points: SWING });
    for (const level of FIB_LEVELS) {
      expect(hitTest([d], 700, yOf(level), PROJ, 8), `правее B, ${level}`).toBeNull();
      expect(hitTest([d], 990, yOf(level), PROJ, 12), `у края, ${level}`).toBeNull();
    }
    expect(hitTest([d], 400, yOf(0.5), PROJ, 8)).toEqual({ id: "F", part: "body", index: -1 });
    expect(hitTest([d], 400, (yOf(0.236) + yOf(0.382)) / 2, PROJ, 8)).toEqual({ id: "F", part: "body", index: -1 });
    expect(hitTest([d], 600, yOf(0), PROJ, 8)).toEqual({ id: "F", part: "point", index: 1 });
    expect(hitTest([d], 200, yOf(1), PROJ, 8)).toEqual({ id: "F", part: "point", index: 0 });
    // и у не продлённого — то же
    expect(hitTest([fib({ points: SWING, style: { extend: false } })], 700, yOf(0.5), PROJ, 8)).toBeNull();
  });
});
