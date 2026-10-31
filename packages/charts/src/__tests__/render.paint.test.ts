import { describe, expect, it } from "vitest";
import { monoMeasurer } from "../layout/measure";
import { resolvePreset, VIEW, type MarkupSettings } from "../presets";
import { priceFormatter } from "../priceFormat";
import { OverlayPrimitive } from "../render/OverlayPrimitive";
import { paintBottom, paintNormal, paintTop, type PaintContext } from "../render/paint";
import { buildScene } from "../scene/build";
import { deriveAnalytics, NO_SELECTION } from "../scene/input";
import { RU_TEXT } from "../scene/text";
import { alpha } from "../theme";
import { LAYER_KEYS, TF_SECONDS } from "../types";
import { makeEnv, makeTheme } from "./fakes/lwc";
import { loadFixture } from "./fixtures/scene/load";

/** Отрисовка кадра (план 2B.2): цвета только из палитры темы, текст сплошным цветом, кегль ≥ 11 px, приглушение только у заливок. */

type Op = { op: string; fill?: string; stroke?: string; font?: string; alpha?: number; text?: string };

function recorder(): { ctx: PaintContext; ops: Op[] } {
  const ops: Op[] = [];
  const st = { fillStyle: "", strokeStyle: "", font: "", globalAlpha: 1, lineWidth: 1, textAlign: "left", textBaseline: "alphabetic", lineCap: "butt" };
  const rec = (op: string, extra: Partial<Op> = {}) => ops.push({ op, fill: String(st.fillStyle), stroke: String(st.strokeStyle), font: st.font, alpha: st.globalAlpha, ...extra });
  const ctx = {
    save() {},
    restore() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    rect() {},
    quadraticCurveTo() {},
    setLineDash() {},
    fill: () => rec("fill"),
    stroke: () => rec("stroke"),
    fillRect: () => rec("fillRect"),
    fillText: (text: string) => rec("fillText", { text }),
  } as unknown as PaintContext;
  for (const k of Object.keys(st) as (keyof typeof st)[])
    Object.defineProperty(ctx, k, {
      get: () => st[k],
      set: (v) => ((st as Record<string, unknown>)[k] = v),
    });
  return { ctx, ops };
}

const ALL: MarkupSettings = { preset: "detailed", overrides: Object.fromEntries(LAYER_KEYS.map((k) => [k, true])) };

function frame(markup: MarkupSettings, width = 1000) {
  const fx = loadFixture("btc-4h-rich");
  const candles = fx.candles;
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of candles.slice(-100)) {
    lo = Math.min(lo, c.low);
    hi = Math.max(hi, c.high);
  }
  const env = makeEnv(() => candles, { width, height: 600, range: { from: candles.length - 100, to: candles.length - 1 + 13 }, top: hi + (hi - lo) * 0.1, bottom: lo - (hi - lo) * 0.25 });
  const theme = makeTheme();
  const prim = new OverlayPrimitive({ view: VIEW.desktop, theme, measure: monoMeasurer(), candles: () => candles, tfSeconds: () => TF_SECONDS[fx.tf] });
  env.series.attachPrimitive(prim as never);
  const scene = buildScene(
    { tf: fx.tf, analytics: deriveAnalytics(candles, fx.oi, fx.structure), structure: fx.structure, patterns: fx.patterns, figures: fx.figures, signals: fx.signals, alerts: [{ id: 1, price: candles.at(-1)!.close * 1.01, op: "cross_up" }], external: [], selection: NO_SELECTION, fmt: priceFormatter(fx.tick, false), text: RU_TEXT },
    resolvePreset(markup, "desktop", { authed: true }),
  );
  prim.setScene(scene);
  prim.updateAllViews();
  return { prim, theme, screen: prim.screen! };
}

describe("paint", () => {
  it("все цвета — из палитры темы (сплошные или с прозрачностью токена)", () => {
    const { theme, screen } = frame(ALL);
    const allowed = new Set<string>();
    const a = theme.alphas;
    for (const c of Object.values(theme.palette).flat()) {
      allowed.add(c);
      for (const k of [a.zoneFill, a.plaque, a.halo, a.vp, a.vpValue, a.zoneFill * a.dimmed, a.vp * a.dimmed, a.vpValue * a.dimmed]) allowed.add(alpha(c, k));
    }
    const { ctx, ops } = recorder();
    paintBottom({ ctx, hpr: 2, vpr: 2 }, screen, theme, null);
    paintNormal({ ctx, hpr: 2, vpr: 2 }, screen, theme);
    paintTop({ ctx, hpr: 2, vpr: 2 }, screen, theme);
    expect(ops.length).toBeGreaterThan(10);
    for (const o of ops) {
      const used = o.op === "stroke" ? o.stroke! : o.fill!;
      // тепловая карта — тон liq с альфой по весу полосы
      if (used.startsWith("rgba(") && o.op === "fillRect" && alpha(theme.palette.liq, 0.5).split(",").slice(0, 3).join(",") === used.split(",").slice(0, 3).join(",")) continue;
      expect(allowed.has(used), `${o.op}: ${used}`).toBe(true);
    }
  });

  it("текст подписей: каждый размещённый, сплошным цветом тона, кегль ≥ 11 CSS px при любом DPR", () => {
    const { theme, screen } = frame(ALL);
    for (const dpr of [1, 2, 2.75]) {
      const { ctx, ops } = recorder();
      paintTop({ ctx, hpr: dpr, vpr: dpr }, screen, theme);
      const texts = ops.filter((o) => o.op === "fillText");
      expect(texts.map((t) => t.text)).toEqual(screen.labels.placed.map((p) => p.text));
      for (const t of texts) {
        const px = Number(/(\d+(?:\.\d+)?)px/.exec(t.font!)![1]) / dpr;
        expect(px).toBeGreaterThanOrEqual(11);
        expect(t.alpha).toBe(1);
        expect(t.fill!.startsWith("#")).toBe(true);
      }
    }
  });

  it("выбранный объект — ореол цветом выделения в нижнем слое; наведение — прозрачнее", () => {
    const { theme, screen } = frame({ preset: "clean", overrides: {} });
    const id = screen.objects.find((o) => o.obj.kind === "hline")!.obj.id;
    const { ctx, ops } = recorder();
    paintBottom({ ctx, hpr: 1, vpr: 1 }, screen, theme, id);
    const halo = ops.filter((o) => o.op === "stroke");
    expect(halo).toHaveLength(1);
    expect(halo[0]!.stroke).toBe(alpha(theme.palette.selection, theme.alphas.halo * 0.6));
  });

  it("линии рисуются с прозрачностью токена линии, не приглушённой", () => {
    const { theme, screen } = frame(ALL);
    const { ctx, ops } = recorder();
    paintNormal({ ctx, hpr: 1, vpr: 1 }, screen, theme);
    for (const o of ops.filter((x) => x.op === "stroke")) expect([theme.alphas.line, 1]).toContain(o.alpha);
  });
});
