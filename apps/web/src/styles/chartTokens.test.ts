import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FIB_PLAQUE_ALPHA } from "@platform/charts";
import { describe, expect, it } from "vitest";

/**
 * Токены графика --chart-* (ADR-0008, план 2B.2, 5.3): полнота, формат значений и контраст в обеих темах.
 * Текст на плашке — не меньше 4.5:1 поверх худшей подложки (заливка зоны любого направления, максимум тепловой
 * карты); линии при --chart-line-alpha — не меньше 3:1 поверх фона и заливок зон.
 */

const css = readFileSync(fileURLToPath(new URL("./tokens.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Объявления --имя: значение; внутри первого блока с этим селектором. */
function block(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  expect(start, `нет блока ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  let depth = 0;
  let end = open;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  const body = css.slice(open + 1, end);
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

const root = block(":root {");
const dark = block('[data-theme="dark"] {');
const media = block(':root:not([data-theme="light"]) {');
const THEMES = { light: root, dark: { ...root, ...dark }, "prefers-dark": { ...root, ...media } } as const;

const TONES = ["up", "down", "structure", "liq", "figure", "alert", "position", "selection", "muted"] as const;
const COLOR_TOKENS = [...TONES.map((t) => `--chart-${t}`), "--chart-plaque"];
const ALPHA_TOKENS = ["--chart-zone-alpha", "--chart-heat-alpha-min", "--chart-heat-alpha-max", "--chart-line-alpha", "--chart-plaque-alpha", "--chart-dimmed-alpha", "--chart-halo-alpha", "--chart-vp-alpha", "--chart-vp-value-alpha", "--chart-volume-alpha"];

const HEX = /^#[0-9a-f]{6}$/i;

function resolve(theme: Record<string, string>, name: string, depth = 0): string {
  const v = theme[name];
  expect(v, `${name} не задан`).toBeDefined();
  const m = /^var\((--[\w-]+)\)$/.exec(v!);
  if (!m) return v!;
  expect(depth).toBeLessThan(8);
  return resolve(theme, m[1]!, depth + 1);
}

type Rgb = [number, number, number];
const toRgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const mix = (a: Rgb, b: Rgb, t: number): Rgb => a.map((x, i) => x * t + b[i]! * (1 - t)) as Rgb;
const lin = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const lum = ([r, g, b]: Rgb) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

describe("токены графика --chart-*", () => {
  it("все --chart-* объявлены в :root", () => {
    for (const name of [...COLOR_TOKENS, ...ALPHA_TOKENS]) expect(root[name], name).toBeDefined();
  });

  it("цвета — только hex или var() от hex (canvas не читает color-mix)", () => {
    for (const [mode, theme] of Object.entries(THEMES))
      for (const name of COLOR_TOKENS) {
        const raw = theme[name]!;
        expect(raw, `${mode} ${name}`).toMatch(/^(#[0-9a-f]{6}|var\(--[\w-]+\))$/i);
        expect(resolve(theme, name), `${mode} ${name}`).toMatch(HEX);
      }
  });

  it("цвета-синонимы объявлены только в :root, тёмные блоки меняют лишь прозрачности", () => {
    for (const name of COLOR_TOKENS) {
      expect(dark[name], name).toBeUndefined();
      expect(media[name], name).toBeUndefined();
    }
  });

  it("прозрачности — числа 0..1, в двух тёмных блоках одинаковые", () => {
    for (const [mode, theme] of Object.entries(THEMES))
      for (const name of ALPHA_TOKENS) {
        const n = Number(theme[name]);
        expect(Number.isFinite(n), `${mode} ${name}`).toBe(true);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(1);
      }
    const darkChart = Object.fromEntries(Object.entries(dark).filter(([k]) => k.startsWith("--chart-")));
    const mediaChart = Object.fromEntries(Object.entries(media).filter(([k]) => k.startsWith("--chart-")));
    expect(Object.keys(darkChart).length).toBeGreaterThan(0);
    expect(mediaChart).toEqual(darkChart);
  });

  it("контраст считается так же, как в расчёте спецификации (минимумы 4.70 текст — карта ярче, ревью T6 — и 3.09 линия)", () => {
    const mins = Object.values(THEMES).map((theme) => {
      const c = (name: string) => toRgb(resolve(theme, name));
      const a = (name: string) => Number(theme[name]);
      const surface = c("--surface");
      const zones = [mix(c("--chart-up"), surface, a("--chart-zone-alpha")), mix(c("--chart-down"), surface, a("--chart-zone-alpha"))];
      // под полупрозрачной плашкой карта бывает только приглушённой (полоса занята — подписи уровней левее неё);
      // сумма ликвидаций на полной карте — на непрозрачной плашке (render/paint.ts)
      const heat = mix(c("--chart-liq"), surface, a("--chart-heat-alpha-max") * a("--chart-dimmed-alpha"));
      const plaque = (u: Rgb) => mix(c("--chart-plaque"), u, a("--chart-plaque-alpha"));
      const text = Math.min(...TONES.flatMap((t) => [surface, ...zones, heat].map((u) => contrast(c(`--chart-${t}`), plaque(u)))));
      const line = Math.min(...TONES.flatMap((t) => [surface, ...zones].map((u) => contrast(mix(c(`--chart-${t}`), u, a("--chart-line-alpha")), u))));
      return { text, line };
    });
    expect(contrast([255, 255, 255], [0, 0, 0])).toBeCloseTo(21, 5);
    expect(Math.min(...mins.map((m) => m.text))).toBeCloseTo(4.7, 1);
    expect(Math.min(...mins.map((m) => m.line))).toBeCloseTo(3.09, 1);
  });

  for (const [mode, theme] of Object.entries(THEMES)) {
    describe(`контраст: ${mode}`, () => {
      const c = (name: string) => toRgb(resolve(theme, name));
      const a = (name: string) => Number(theme[name]);
      const surface = c("--surface");
      const zoneA = a("--chart-zone-alpha");
      const zones = [mix(c("--chart-up"), surface, zoneA), mix(c("--chart-down"), surface, zoneA)];
      const heatMax = mix(c("--chart-liq"), surface, a("--chart-heat-alpha-max"));
      const heatDimmed = mix(c("--chart-liq"), surface, a("--chart-heat-alpha-max") * a("--chart-dimmed-alpha"));
      const plaqueOver = (under: Rgb) => mix(c("--chart-plaque"), under, a("--chart-plaque-alpha"));

      it("сумма ликвидаций на непрозрачной плашке ≥ 4.5", () => {
        expect(contrast(c("--chart-liq"), c("--chart-plaque"))).toBeGreaterThanOrEqual(4.5);
      });

      it("самая крупная полоса карты ликвидаций — не меньше 3:1 к фону", () => {
        expect(contrast(heatMax, surface)).toBeGreaterThanOrEqual(3);
      });

      for (const tone of TONES) {
        it(`${tone}: текст на плашке ≥ 4.5, линия ≥ 3`, () => {
          const fg = c(`--chart-${tone}`);
          const text = Math.min(...[surface, ...zones, heatDimmed].map((u) => contrast(fg, plaqueOver(u))));
          expect(text).toBeGreaterThanOrEqual(4.5);
          const lineA = a("--chart-line-alpha");
          const line = Math.min(...[surface, ...zones].map((u) => contrast(mix(fg, u, lineA), u)));
          expect(line).toBeGreaterThanOrEqual(3);
        });
      }
    });
  }
});

/**
 * Палитра уровней Фибоначчи --fib-1…--fib-6 (ADR-0009, «Рисование», дополнение 2026-11-13): hex в каждой теме, две
 * тёмные — одинаковые; подпись цветом уровня на полупрозрачной плашке (FIB_PLAQUE_ALPHA) — не меньше 4.5:1 над фоном и
 * 3:1 над телом свечи (рост и падение), линия уровня — не меньше 3:1 к фону; оттенки различимы и не совпадают с цветами
 * роста, падения и выбора. Ни красного, ни зелёного (план 5.3 — только направление и результат): тон каждого оттенка
 * не ближе 30° к --up и --down и 25° к --accent — ни один уровень не читается как покупка, продажа или выбор.
 */
/** Тон цвета по кругу HSL, градусы. */
const hueOf = ([r, g, b]: Rgb): number => {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return Number.NaN;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};
const hueDist = (a: number, b: number) => {
  const x = Math.abs(a - b) % 360;
  return Math.min(x, 360 - x);
};

describe("палитра уровней Фибоначчи --fib-*", () => {
  const FIB = Array.from({ length: 6 }, (_, i) => `--fib-${i + 1}`);

  it("6 оттенков в каждой теме, hex; в двух тёмных блоках одинаковые; седьмого нет", () => {
    for (const [mode, theme] of Object.entries(THEMES)) for (const name of FIB) expect(resolve(theme, name), `${mode} ${name}`).toMatch(HEX);
    for (const name of FIB) {
      expect(dark[name], name).toBeDefined();
      expect(media[name], name).toBe(dark[name]);
      expect(dark[name], name).not.toBe(root[name]);
    }
    for (const theme of [root, dark, media]) expect(theme["--fib-7"]).toBeUndefined();
  });

  for (const [mode, theme] of Object.entries(THEMES)) {
    it(`${mode}: подпись ≥ 4.5 над фоном и ≥ 3 над свечой, линия ≥ 3; оттенки разные и не цвета роста, падения, выбора`, () => {
      const c = (name: string) => toRgb(resolve(theme, name));
      const surface = c("--surface");
      const plaqueOver = (under: Rgb) => mix(surface, under, FIB_PLAQUE_ALPHA);
      for (const name of FIB) {
        const fg = c(name);
        expect(contrast(fg, plaqueOver(surface)), `${name} над фоном`).toBeGreaterThanOrEqual(4.5);
        for (const candle of ["--up", "--down"]) expect(contrast(fg, plaqueOver(c(candle))), `${name} над свечой ${candle}`).toBeGreaterThanOrEqual(3);
        expect(contrast(fg, surface), `${name}: линия`).toBeGreaterThanOrEqual(3);
      }
      const values = FIB.map((n) => resolve(theme, n).toLowerCase());
      expect(new Set(values).size).toBe(6);
      for (const other of ["--up", "--down", "--accent", "--text-2"]) expect(values).not.toContain(resolve(theme, other).toLowerCase());
    });
  }

  for (const [mode, theme] of Object.entries(THEMES)) {
    it(`${mode}: ни красного, ни зелёного — тон не ближе 30° к росту и падению и 25° к выбору (план 5.3)`, () => {
      const h = (name: string) => hueOf(toRgb(resolve(theme, name)));
      for (const name of FIB) {
        expect(hueDist(h(name), h("--up")), `${name} ${resolve(theme, name)} и --up`).toBeGreaterThanOrEqual(30);
        expect(hueDist(h(name), h("--down")), `${name} ${resolve(theme, name)} и --down`).toBeGreaterThanOrEqual(30);
        expect(hueDist(h(name), h("--accent")), `${name} ${resolve(theme, name)} и --accent`).toBeGreaterThanOrEqual(25);
      }
    });
  }
});
