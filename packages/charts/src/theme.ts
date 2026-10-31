import type { ChartOptions, DeepPartial } from "lightweight-charts";
import { ColorType, CrosshairMode, LineStyle } from "lightweight-charts";
import type { ViewPreset } from "./presets";
import type { ThemeTokens, Tone } from "./types";

/** Ширина ценовой шкалы не меньше этой: «81 118» моноширинным 11 px. */
const PRICE_SCALE_MIN_PX = 48;
/** Пустых баров справа от последней свечи. */
export const RIGHT_OFFSET = 5;

/** Прозрачность для hex-цвета #rrggbb → rgba(). Токены задаются в hex (план 5.3). */
export function alpha(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return hex;
  return `rgba(${parseInt(m[1]!, 16)}, ${parseInt(m[2]!, 16)}, ${parseInt(m[3]!, 16)}, ${a})`;
}

/** Настройки LWC из токенов: без градиентов и свечений, сетка — токен границы (план 5.6). */
export function chartOptions(t: ThemeTokens): DeepPartial<ChartOptions> {
  return {
    layout: {
      background: { type: ColorType.Solid, color: t.surface },
      textColor: t.text2,
      fontFamily: t.fontMono,
      fontSize: 11,
      // логотип TradingView в углу графика выключен; атрибуция по лицензии — ссылкой в подвале сайта
      attributionLogo: false,
      panes: { separatorColor: t.border, separatorHoverColor: alpha(t.accent, 0.2), enableResize: true },
    },
    grid: { vertLines: { color: alpha(t.border, 0.6) }, horzLines: { color: alpha(t.border, 0.6) } },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: t.text3, width: 1, style: LineStyle.Dashed, labelBackgroundColor: t.text },
      horzLine: { color: t.text3, width: 1, style: LineStyle.Dashed, labelBackgroundColor: t.text },
    },
    // минимальная ширина шкалы — страховка: если браузер неверно измерит текст, цены всё равно не обрежутся
    rightPriceScale: { borderColor: t.border, scaleMargins: { top: 0.08, bottom: 0.2 }, minimumWidth: PRICE_SCALE_MIN_PX },
    timeScale: { borderColor: t.border, timeVisible: true, secondsVisible: false, rightOffset: RIGHT_OFFSET, barSpacing: 7, minBarSpacing: 2 },
    // колесо и трекпад обрабатывает Terminal сам (см. onWheel): горизонтальный жест — прокрутка,
    // вертикальный и pinch — масштаб вокруг курсора; встроенная обработка слишком резкая на трекпаде
    handleScale: { axisPressedMouseMove: true, pinch: true, mouseWheel: false },
    handleScroll: { pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false, mouseWheel: false },
    localization: { locale: "ru-RU" },
  };
}

export function seriesColors(t: ThemeTokens) {
  return {
    candles: { upColor: t.up, downColor: t.down, borderVisible: false, wickUpColor: t.up, wickDownColor: t.down },
    bars: { upColor: t.up, downColor: t.down, thinBars: false },
    line: { color: t.accent, lineWidth: 2 as const },
    volumeUp: alpha(t.up, 0.35),
    volumeDown: alpha(t.down, 0.35),
  };
}

/** Чтение токенов из CSS-переменных элемента (в браузере). Имена — из apps/web/src/styles/tokens.css. */
export function tokensFromElement(el: HTMLElement): ThemeTokens {
  const cs = getComputedStyle(el);
  const v = (n: string, fallback: string) => cs.getPropertyValue(n).trim() || fallback;
  return {
    bg: v("--bg", "#ffffff"),
    surface: v("--surface", "#ffffff"),
    border: v("--border", "#e4e2dd"),
    text: v("--text", "#1b1a17"),
    text2: v("--text-2", "#4e4b45"),
    text3: v("--text-3", "#726f68"),
    up: v("--up", "#1f8a5b"),
    down: v("--down", "#c93c3c"),
    accent: v("--accent", "#2d5bd7"),
    warn: v("--warn", "#b7791f"),
    ind: [1, 2, 3, 4, 5, 6].map((i) => v(`--ind-${i}`, "#4a6fa5")),
    fontSans: v("--font-sans", "system-ui"),
    fontMono: v("--font-mono", "ui-monospace"),
  };
}

/**
 * Цвета сцены по смыслу (ADR-0008): значения токенов --chart-* из apps/web/src/styles/tokens.css.
 * Синонимы (var(--up) и т. п.) раскрывает getComputedStyle, поэтому здесь всегда hex.
 */
export interface ChartPalette {
  up: string;
  down: string;
  structure: string;
  liq: string;
  figure: string;
  alert: string;
  position: string;
  selection: string;
  muted: string;
  /** Основной текст и фон области (контурные метки шкалы, фон под плашкой). */
  text: string;
  surface: string;
  /** Фон плашки подписи (--chart-plaque). */
  plaque: string;
  grid: string;
  ind: readonly string[];
}

/** Прозрачности из токенов --chart-*-alpha (свои у тёмной темы). */
export interface ChartAlphas {
  zoneFill: number;
  heatMin: number;
  heatMax: number;
  line: number;
  plaque: number;
  volume: number;
  /** Только для заливок (тепловая карта и профиль поверх свечей), никогда для линий и текста. */
  dimmed: number;
  halo: number;
  vp: number;
  vpValue: number;
}

/** Типографика холста (M10): семейства — из --font-sans / --font-mono, размеры — из вида устройства. */
export interface CanvasType {
  sans: string;
  mono: string;
  labelPx: number;
  labelWeight: 500 | 600;
  axisPx: number;
  plaquePadX: number;
  plaquePadY: number;
  plaqueRadius: number;
}

export interface ChartTheme {
  mode: "light" | "dark";
  /** Растёт при каждой смене data-theme / prefers-color-scheme: ключ кэша раскладки и отрисовки. */
  version: number;
  tokens: ThemeTokens;
  palette: ChartPalette;
  alphas: ChartAlphas;
  type: CanvasType;
}

/** Значения по умолчанию (светлая тема), если токена нет в CSS. */
export const DEFAULT_ALPHAS: ChartAlphas = { zoneFill: 0.08, heatMin: 0.05, heatMax: 0.22, line: 0.85, plaque: 0.88, volume: 0.35, dimmed: 0.4, halo: 0.22, vp: 0.16, vpValue: 0.28 };
const ALPHA_VARS: Readonly<Record<keyof ChartAlphas, string>> = {
  zoneFill: "--chart-zone-alpha",
  heatMin: "--chart-heat-alpha-min",
  heatMax: "--chart-heat-alpha-max",
  line: "--chart-line-alpha",
  plaque: "--chart-plaque-alpha",
  volume: "--chart-volume-alpha",
  dimmed: "--chart-dimmed-alpha",
  halo: "--chart-halo-alpha",
  vp: "--chart-vp-alpha",
  vpValue: "--chart-vp-value-alpha",
};
/** Плашка подписи: отступы 4 × 2 px, радиус 2, шрифт Manrope 600. */
export const PLAQUE = { padX: 4, padY: 2, radius: 2, weight: 600 } as const;

let warnedMissing = false;

/** Относительная яркость hex-цвета (WCAG): тёмная ли поверхность. */
function luminance(hex: string): number | null {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return null;
  const ch = (h: string) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(m[1]!) + 0.7152 * ch(m[2]!) + 0.0722 * ch(m[3]!);
}

/**
 * Тема сцены из CSS-переменных элемента: --chart-* (цвета по смыслу и прозрачности), --font-sans/--font-mono.
 * Нет токена — значение из базовых токенов (tokensFromElement) и одно предупреждение в консоль.
 */
export function readChartTheme(el: HTMLElement, view: ViewPreset, version: number): ChartTheme {
  const tokens = tokensFromElement(el);
  const cs = getComputedStyle(el);
  const missing: string[] = [];
  const v = (name: string, fallback: string): string => {
    const raw = cs.getPropertyValue(name).trim();
    if (!raw) missing.push(name);
    return raw || fallback;
  };
  const palette: ChartPalette = {
    up: v("--chart-up", tokens.up),
    down: v("--chart-down", tokens.down),
    structure: v("--chart-structure", tokens.text2),
    liq: v("--chart-liq", tokens.warn),
    figure: v("--chart-figure", tokens.text3),
    alert: v("--chart-alert", tokens.text),
    position: v("--chart-position", tokens.text2),
    selection: v("--chart-selection", tokens.accent),
    muted: v("--chart-muted", tokens.text3),
    text: tokens.text,
    surface: tokens.surface,
    plaque: v("--chart-plaque", tokens.surface),
    grid: tokens.border,
    ind: tokens.ind,
  };
  const alphas = { ...DEFAULT_ALPHAS };
  for (const key of Object.keys(ALPHA_VARS) as (keyof ChartAlphas)[]) {
    const n = Number.parseFloat(v(ALPHA_VARS[key], ""));
    if (Number.isFinite(n) && n >= 0 && n <= 1) alphas[key] = n;
  }
  if (missing.length > 0 && !warnedMissing) {
    warnedMissing = true;
    console.warn(`chart theme: нет токенов ${missing.join(", ")} — взяты значения по умолчанию`);
  }
  const scheme = cs.getPropertyValue("color-scheme").trim();
  const lum = luminance(tokens.surface);
  const mode: ChartTheme["mode"] = scheme.includes("dark") ? "dark" : scheme.includes("light") ? "light" : lum !== null && lum < 0.2 ? "dark" : "light";
  const type: CanvasType = {
    sans: tokens.fontSans,
    mono: tokens.fontMono,
    labelPx: view.labelFontPx,
    labelWeight: PLAQUE.weight,
    axisPx: view.scaleFontPx,
    plaquePadX: PLAQUE.padX,
    plaquePadY: PLAQUE.padY,
    plaqueRadius: PLAQUE.radius,
  };
  return { mode, version, tokens, palette, alphas, type };
}

/** Единственное место, где тон превращается в цвет. */
export function toneColor(theme: ChartTheme, tone: Tone): string {
  return theme.palette[tone];
}

/** Сброс предупреждения о токенах (для тестов). */
export function resetThemeWarnings(): void {
  warnedMissing = false;
}
