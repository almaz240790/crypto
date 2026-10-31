import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VIEW } from "../presets";
import { DEFAULT_ALPHAS, readChartTheme, resetThemeWarnings, toneColor } from "../theme";
import { TONES } from "../types";

/** Подменяет getComputedStyle: значения CSS-переменных элемента. */
function stubStyle(vars: Record<string, string>) {
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: (n: string) => vars[n] ?? "" }));
  return {} as HTMLElement;
}

const DARK: Record<string, string> = {
  "color-scheme": "dark",
  "--surface": "#0b0e10",
  "--text": "#eef1f0",
  "--text-2": "#a2aaa8",
  "--text-3": "#7c8582",
  "--up": "#22c58b",
  "--down": "#f2555c",
  "--accent": "#c6f432",
  "--warn": "#f0b429",
  "--border": "#1d2327",
  "--font-sans": "Manrope, sans-serif",
  "--font-mono": "IBM Plex Mono, monospace",
  "--chart-up": "#22c58b",
  "--chart-down": "#f2555c",
  "--chart-structure": "#a2aaa8",
  "--chart-liq": "#f0b429",
  "--chart-figure": "#7c8582",
  "--chart-alert": "#eef1f0",
  "--chart-position": "#a2aaa8",
  "--chart-selection": "#c6f432",
  "--chart-muted": "#7c8582",
  "--chart-plaque": "#0b0e10",
  "--chart-zone-alpha": "0.1",
  "--chart-heat-alpha-min": "0.06",
  "--chart-heat-alpha-max": " 0.35",
  "--chart-line-alpha": "0.75",
  "--chart-plaque-alpha": "0.88",
  "--chart-dimmed-alpha": "0.4",
  "--chart-halo-alpha": "0.28",
  "--chart-vp-alpha": "0.2",
  "--chart-vp-value-alpha": "0.34",
  "--chart-volume-alpha": "0.35",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetThemeWarnings();
});

describe("тема графика из токенов --chart-*", () => {
  it("цвета и прозрачности тёмной темы, шрифты из вида", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = readChartTheme(stubStyle(DARK), VIEW.desktop, 3);
    expect(t.mode).toBe("dark");
    expect(t.version).toBe(3);
    expect(t.palette).toMatchObject({ up: "#22c58b", liq: "#f0b429", selection: "#c6f432", plaque: "#0b0e10", surface: "#0b0e10", grid: "#1d2327" });
    expect(t.alphas).toEqual({ zoneFill: 0.1, heatMin: 0.06, heatMax: 0.35, line: 0.75, plaque: 0.88, volume: 0.35, dimmed: 0.4, halo: 0.28, vp: 0.2, vpValue: 0.34 });
    expect(t.type).toEqual({ sans: "Manrope, sans-serif", mono: "IBM Plex Mono, monospace", labelPx: 11, labelWeight: 600, axisPx: 12, plaquePadX: 4, plaquePadY: 2, plaqueRadius: 2 });
    expect(readChartTheme(stubStyle(DARK), VIEW.phone, 1).type.axisPx).toBe(11);
    expect(warn).not.toHaveBeenCalled();
  });

  it("нет токенов — значения по умолчанию и одно предупреждение", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const el = stubStyle({ "--up": "#0a7f55", "--text-2": "#4a524f", "--chart-line-alpha": "abc", "--chart-zone-alpha": "2" });
    const t = readChartTheme(el, VIEW.desktop, 0);
    expect(t.palette.up).toBe("#0a7f55");
    expect(t.palette.structure).toBe("#4a524f");
    expect(t.alphas).toEqual(DEFAULT_ALPHAS);
    expect(t.mode).toBe("light");
    readChartTheme(el, VIEW.desktop, 1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("режим по яркости поверхности, если color-scheme не задан", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { "color-scheme": _, ...noScheme } = DARK;
    void _;
    expect(readChartTheme(stubStyle(noScheme), VIEW.desktop, 0).mode).toBe("dark");
    expect(readChartTheme(stubStyle({ ...noScheme, "--surface": "#ffffff" }), VIEW.desktop, 0).mode).toBe("light");
    expect(readChartTheme(stubStyle({ ...noScheme, "--surface": "white" }), VIEW.desktop, 0).mode).toBe("light");
    expect(readChartTheme(stubStyle({ ...DARK, "color-scheme": "light" }), VIEW.desktop, 0).mode).toBe("light");
  });

  it("toneColor — для всех 9 тонов из палитры", () => {
    const t = readChartTheme(stubStyle(DARK), VIEW.desktop, 0);
    const expected: Record<string, string> = { up: "#22c58b", down: "#f2555c", structure: "#a2aaa8", liq: "#f0b429", figure: "#7c8582", alert: "#eef1f0", position: "#a2aaa8", selection: "#c6f432", muted: "#7c8582" };
    expect(TONES).toHaveLength(9);
    for (const tone of TONES) expect(toneColor(t, tone)).toBe(expected[tone]);
  });

  it("значения по умолчанию совпадают со светлыми токенами tokens.css", () => {
    const css = readFileSync(fileURLToPath(new URL("../../../../apps/web/src/styles/tokens.css", import.meta.url)), "utf8");
    const root = css.slice(css.indexOf(":root {"), css.indexOf('[data-theme="dark"]'));
    const num = (name: string) => Number(new RegExp(`${name}:\\s*([\\d.]+);`).exec(root)?.[1]);
    expect({
      zoneFill: num("--chart-zone-alpha"),
      heatMin: num("--chart-heat-alpha-min"),
      heatMax: num("--chart-heat-alpha-max"),
      line: num("--chart-line-alpha"),
      plaque: num("--chart-plaque-alpha"),
      volume: num("--chart-volume-alpha"),
      dimmed: num("--chart-dimmed-alpha"),
      halo: num("--chart-halo-alpha"),
      vp: num("--chart-vp-alpha"),
      vpValue: num("--chart-vp-value-alpha"),
    }).toEqual(DEFAULT_ALPHAS);
  });
});
